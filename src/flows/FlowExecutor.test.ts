/**
 * Flow Executor Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDescriptor } from '../types';
import type { EditorStep, AgentFlow } from '../types/flow';
import type { FlowExecutionEvent } from './FlowExecutor';
import { FlowExecutor, FlowExecutionContext } from './FlowExecutor';
import { AgentConfig } from '../types';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { SandboxAdapter } from '../security/sandbox';
import { mockModel } from '../testing';
import { SDKError } from '../execution/errors';
import { defineTool } from '../tools/defineTool';

describe('FlowExecutor', () => {
  let mockProvider: MockLLMProvider;
  let toolRegistry: ToolRegistry;
  let agent: AgentConfig;
  let context: FlowExecutionContext;

  beforeEach(() => {
    mockProvider = new MockLLMProvider({
      name: 'mock',
      responses: ['Hello from LLM', 'Another response'],
    });

    toolRegistry = new ToolRegistry();
    toolRegistry.register('testTool', {
      displayName: 'Test tool',
      tool: {
        description: 'Test tool',
        parameters: z.object({ value: z.string().optional() }),
        execute: async (args: unknown) => {
          return { success: true, input: args };
        },
      },
    });

    agent = {
      id: 'test-agent',
      name: 'Test Agent',
      
      prompt: 'You are a helpful assistant',
      settings: {
        model: 'gpt-4',
      },
    };

    context = {
      agent,
      provider: mockProvider,
      toolRegistry,
      variables: {},
    };
  });

  describe('Basic Execution', () => {

    it('should execute an end node', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'end',
          value: 'Done',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Done');
    });
  });

  describe('Expression safety (no eval)', () => {
    const hostileFlow = (condition: string): AgentFlow => ({
      code: 'test-flow',
      name: 'Test Flow',
      flow: {
        type: 'oneOf',
        options: [
          { condition, step: { type: 'return', value: 'INJECTED' } },
          { step: { type: 'return', value: 'default' } },
        ],
      },
    });

    it.each([
      "process.exit(1)",
    ])('treats %s as a failed condition instead of executing it', async (condition) => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      context.variables = { score: 85 };

      const result = await FlowExecutor.execute(hostileFlow(condition), context);

      expect(result.output).toBe('default');
      expect(exit).not.toHaveBeenCalled();
      expect(context.variables.score).toBe(85);
      exit.mockRestore();
    });

    it('evaluator nodes compute safe expressions and fail the flow on unsupported syntax', async () => {
      context.variables = { a: 2, b: 3 };
      const ok = await FlowExecutor.execute(
        { code: 'f', name: 'F', flow: { type: 'evaluator', expression: 'a * b + 1' } } as AgentFlow,
        context
      );
      expect(ok.success).toBe(true);
      expect(ok.output).toBe(7);

      const bad = await FlowExecutor.execute(
        { code: 'f', name: 'F', flow: { type: 'evaluator', expression: "require('fs')" } } as AgentFlow,
        context
      );
      expect(bad.success).toBe(false);
      expect(bad.error?.message).toContain('Failed to evaluate expression: require');
      expect(bad.error?.message).toContain('position');
    });
  });

  describe('ToolCall steps pass the agent gate', () => {
    const payFlow = (amount: string): AgentFlow => ({
      code: 'pay-flow',
      name: 'Pay flow',
      flow: { type: 'toolCall', tool: 'pay', arguments: { amount } },
    });

    function registerPay(needsApproval: ToolDescriptor['needsApproval'] = true) {
      const execute = vi.fn(async ({ amount }: { amount: string }) => `PAID ${amount}`);
      toolRegistry.register(defineTool({ name: 'pay', description: 'Pay a vendor', input: z.object({ amount: z.string() }), needsApproval, execute }));
      return execute;
    }

    it('asks the approve callback, and runs the tool only when it approves', async () => {
      const execute = registerPay();
      const approve = vi.fn(({ args }: { args: Record<string, unknown> }) => Number(args.amount) < 1000);

      const small = await FlowExecutor.execute(payFlow('10.00'), { ...context, approve });
      const large = await FlowExecutor.execute(payFlow('25000.00'), { ...context, approve });

      expect(small.success).toBe(true);
      expect(small.output).toBe('PAID 10.00');
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'pay', args: { amount: '10.00' }, toolCallId: expect.any(String) }));
      expect(large.success).toBe(false);
      expect((large.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("applies a needsApproval policy's deny", async () => {
      const execute = registerPay(() => ({ deny: 'Vendor is blocked' }));

      const result = await FlowExecutor.execute(payFlow('1'), { ...context, approve: () => true });

      expect((result.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
      expect(result.error?.message).toContain('Vendor is blocked');
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('Flow inputs', () => {
    const flowWithInput: AgentFlow = {
      code: 'needs-doc',
      name: 'Needs doc',
      inputs: [{ name: 'docId', type: 'shortText', required: true }],
      flow: { type: 'return', value: '$docId' },
    };

    it('fails the flow when an input has the wrong type', async () => {
      const result = await FlowExecutor.execute(flowWithInput, { ...context, variables: { docId: 42 } });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Input variable 'docId' must be a string");
    });
  });

  describe('fix: sandbox seam wiring in executeToolCall()', () => {
    it("routes a requiresSandbox:true tool with sandboxExecute() through the configured SandboxAdapter, never touching tool.execute()", async () => {
      const toolExecute = vi.fn().mockResolvedValue({ done: true });
      const sandboxExecute = vi.fn(async (args: unknown, sandbox: SandboxAdapter) => {
        await sandbox.writeFile('args.json', JSON.stringify(args));
        const runResult = await sandbox.run('echo', ['hello-from-real-work']);
        return { stdout: runResult.stdout };
      });

      toolRegistry.register('sandboxedFlowTool', {
        tool: {
          description: 'Sandboxed flow tool',
          parameters: {},
          execute: toolExecute,
        },
        type: 'Test',
        requiresSandbox: true,
        sandboxExecute,
      } as Partial<ToolDescriptor> as ToolDescriptor);

      const spySandbox: SandboxAdapter = {
        name: 'spy',
        run: vi.fn().mockResolvedValue({ stdout: 'hello-from-real-work', stderr: '', exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'sandboxedFlowTool',
          arguments: { value: 'test' },
        },
      };

      const result = await FlowExecutor.execute(flow, { ...context, sandbox: spySandbox });

      // sandboxExecute() itself was invoked, with the real (interpolated)
      // args and the configured sandbox adapter.
      expect(sandboxExecute).toHaveBeenCalledTimes(1);
      expect(sandboxExecute).toHaveBeenCalledWith({ value: 'test' }, spySandbox, expect.objectContaining({ toolCallId: expect.any(String), messages: [] }));
      expect(spySandbox.writeFile).toHaveBeenCalledWith(
        'args.json',
        JSON.stringify({ value: 'test' })
      );
      expect(spySandbox.run).toHaveBeenCalledWith('echo', ['hello-from-real-work']);

      // Critical assertion: the tool's own in-process execute() is NEVER
      // called for a genuinely-sandboxed tool invoked through a Flow.
      expect(toolExecute).not.toHaveBeenCalled();

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ stdout: 'hello-from-real-work' });
    });

    it('a requiresSandbox:true tool with NO sandboxExecute() fails closed through a Flow - the run surfaces the error instead of silently running in-process', async () => {
      const toolExecute = vi.fn().mockResolvedValue({ done: true });

      toolRegistry.register('unsandboxableFlowTool', {
        tool: {
          description: 'Unsandboxable flow tool',
          parameters: {},
          execute: toolExecute,
        },
        type: 'Test',
        requiresSandbox: true,
        // no sandboxExecute implementation - this is the bug scenario
      } as Partial<ToolDescriptor> as ToolDescriptor);

      const spySandbox: SandboxAdapter = {
        name: 'spy',
        run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'unsandboxableFlowTool',
          arguments: {},
        },
      };

      const result = await FlowExecutor.execute(flow, { ...context, sandbox: spySandbox });

      // FlowExecutor's established convention for a thrown step error: the
      // flow result comes back with success:false and the error attached,
      // rather than a rejected promise (see 'should handle errors' above).
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('unsandboxableFlowTool');
      expect(result.error?.message).toContain('requiresSandbox');
      expect(result.error?.message).toContain('sandboxExecute');
      expect(result.error?.message).toContain('refusing to fall back to unsandboxed execution');

      // Fail-closed: neither the tool's real execute() NOR any real
      // sandbox operation happens. Before this fix, tool.execute() would
      // have run in-process on the host unconditionally, silently.
      expect(toolExecute).not.toHaveBeenCalled();
      expect(spySandbox.run).not.toHaveBeenCalled();
      expect(spySandbox.writeFile).not.toHaveBeenCalled();
    });

    it('a tool WITHOUT requiresSandbox through a flow behaves exactly as before (regression guard)', async () => {
      // Reuses the pre-existing 'testTool' registered in beforeEach, which
      // has no requiresSandbox flag - this is the same flow as the
      // "Tool Call Execution > should execute tool" test above.
      const spySandbox: SandboxAdapter = {
        name: 'spy',
        run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'testTool',
          arguments: { value: 'test' },
        },
      };

      const result = await FlowExecutor.execute(flow, { ...context, sandbox: spySandbox });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ success: true, input: { value: 'test' } });
      expect(spySandbox.run).not.toHaveBeenCalled();
      expect(spySandbox.writeFile).not.toHaveBeenCalled();
    });
  });
});

describe('FlowExecutor parallel failure', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const flowOf = (root: EditorStep): AgentFlow => ({ code: 'f', name: 'f', flow: root });

  it('aborts sibling branches when one fails and returns only after they settle', async () => {
    const charged: string[] = [];
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'charge',
      description: 'charge a customer',
      input: z.object({ customer: z.string() }),
      execute: async ({ customer }) => { await sleep(10); charged.push(customer); return 'ok'; },
    }));
    const provider = mockModel([{ text: 'note', delayMs: 5 }], { onExhausted: 'repeat-last' });
    const result = await FlowExecutor.execute(
      flowOf({ type: 'parallel', steps: [
        { type: 'throw', message: 'validation failed' },
        { type: 'forEach', items: ['x1', 'x2', 'x3'], step: { type: 'sequence', steps: [
          { type: 'llmCall', prompt: 'note for {{item}}' },
          { type: 'toolCall', tool: 'charge', arguments: { customer: '{{item}}' } },
        ] } },
      ] } as EditorStep),
      { agent: { name: 'f' }, provider, toolRegistry: registry, variables: {} }
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('validation failed');
    const chargedAtReturn = charged.length;
    const eventsAtReturn = result.events.length;
    await sleep(100);
    expect(charged).toHaveLength(chargedAtReturn);
    expect(charged).toHaveLength(0);
    expect(result.events).toHaveLength(eventsAtReturn);
    expect(result.events.at(-1)?.type).toBe('flow-error');
  });
});

describe('FlowExecutor loop variable scoping', () => {
  const flowOf = (root: EditorStep): AgentFlow => ({ code: 'f', name: 'f', flow: root });

  it('keeps loop variables local, lets other writes reach the flow, and shadows an outer variable of the same name', async () => {
    const result = await FlowExecutor.execute(
      flowOf({ type: 'sequence', steps: [
        { type: 'forEach', items: ['a', 'b'], step: { type: 'sequence', steps: [
          { type: 'setVariable', variable: 'last', value: '$item' },
          { type: 'evaluator', expression: '{{item}} + {{index}}' },
        ] } },
        { type: 'return', value: '$item' },
      ] } as EditorStep),
      { agent: { name: 'f' }, provider: mockModel(['x']), variables: { item: 'outer' } }
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe('outer');
    expect(result.variables.last).toBe('b');
    expect(result.variables.index).toBeUndefined();
  });
});

describe('FlowExecutor template interpolation of non-string values', () => {
  function flowOf(root: unknown): AgentFlow {
    return { code: 'interp', name: 'Interp', flow: root as EditorStep };
  }

  function registryWith(result: unknown): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register('fetch', {
      displayName: 'Fetch',
      tool: { description: 'Returns a fixed result', parameters: z.object({}), execute: async () => result },
    });
    return registry;
  }

  /** The prompt the llmCall step sent, after a toolCall stored `result` in `res`. */
  async function promptAfterTool(result: unknown, prompt: string): Promise<string> {
    const events: FlowExecutionEvent[] = [];
    const outcome = await FlowExecutor.execute(
      flowOf({ type: 'sequence', steps: [
        { type: 'toolCall', tool: 'fetch', arguments: {}, outputVariable: 'res' },
        { type: 'llmCall', prompt },
      ] }),
      { agent: { name: 'f' }, provider: mockModel(['ok']), toolRegistry: registryWith(result), variables: {} },
      (event) => events.push(event)
    );
    expect(outcome.success).toBe(true);
    return (events.find((e) => e.type === 'llm-call')?.data as { prompt: string }).prompt;
  }

  it('renders a { text } result (an MCP tool result) as its text', async () => {
    expect(await promptAfterTool({ text: 'page body' }, 'Summarize: {{res}}')).toBe('Summarize: page body');
    const mcp = Object.defineProperty({ text: 'hello' }, 'content', { value: [{ type: 'text', text: 'hello' }], enumerable: false });
    expect(await promptAfterTool(mcp, '{{res}}')).toBe('hello');
    const withMedia = { text: 'caption', content: [{ type: 'text', text: 'caption' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    expect(await promptAfterTool(withMedia, '{{res}}')).toBe('caption');
  });

  it('renders a raw MCP content array as its joined text parts', async () => {
    const raw = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(await promptAfterTool(raw, '{{res}}')).toBe('a\nb');
  });

  it('reads dotted paths into objects and arrays; a missing path is empty', async () => {
    const result = { user: { name: 'Ada', tags: ['x', 'y'] }, count: 0 };
    expect(await promptAfterTool(result, '{{res.user.name}} {{res.user.tags.1}} {{res.count}} [{{res.missing.deep}}]')).toBe('Ada y 0 []');
    expect(await promptAfterTool(result, '{{res.user}}')).toBe('{"name":"Ada","tags":["x","y"]}');
  });
});


