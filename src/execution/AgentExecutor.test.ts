import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Tool } from 'ai';
import type { Message } from '../providers';
import { APICallError } from 'ai';
import { AgentExecutor } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { CompactedLLMProviderError } from './errors';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { Span, TraceExporter } from './tracing';
import { LLMProvider, GenerateResult, textOf } from '../providers';

describe('AgentExecutor', () => {
  let provider: ReturnType<typeof createMockProvider>;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    provider = createMockProvider({
      name: 'mock',
      responses: ['Hello! How can I help you today?'],
    });

    toolRegistry = new ToolRegistry();
  });

  describe('tracing hooks', () => {
    it('invokes onLLMRequest/onLLMResponse and onToolCall/onToolResult in order, with real latency', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('slowTool', {
        displayName: 'Slow Tool',
        tool: tool({
          description: 'A tool with an artificial delay',
          parameters: z.object({}),
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ok: true };
          },
        }),
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('slowTool', { tool: 'slowTool', options: {} })
        .build();

      let callCount = 0;
      const mockProvider = {
        name: 'mock',
        async generate() {
          callCount++;
          if (callCount === 1) {
            return {
              text: '',
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: 'call-1',
                  type: 'function' as const,
                  function: { name: 'slowTool', arguments: '{}' },
                },
              ],
            };
          }
          return {
            text: 'done',
            finishReason: 'stop' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        async stream() {
          throw new Error('not implemented');
        },
        supportsTools: () => true,
        supportsStreaming: () => false,
        async getModels() {
          return [];
        },
      };

      const onLLMRequest = vi.fn();
      const onLLMResponse = vi.fn();
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      const order: string[] = [];
      onLLMRequest.mockImplementation(() => order.push('llm-request'));
      onLLMResponse.mockImplementation(() => order.push('llm-response'));
      onToolCall.mockImplementation(() => order.push('tool-call'));
      onToolResult.mockImplementation(() => order.push('tool-result'));

      await AgentExecutor.execute({
        agent,
        input: 'please call slowTool',
        provider: mockProvider as LLMProvider,
        toolRegistry,
        onLLMRequest,
        onLLMResponse,
        onToolCall,
        onToolResult,
      });

      expect(onLLMRequest).toHaveBeenCalledTimes(2);
      expect(onLLMResponse).toHaveBeenCalledTimes(2);
      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(onToolResult).toHaveBeenCalledTimes(1);

      // Order: request -> response for step 1, then the tool call/result,
      // then request -> response for step 2.
      expect(order).toEqual([
        'llm-request',
        'llm-response',
        'tool-call',
        'tool-result',
        'llm-request',
        'llm-response',
      ]);

      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ function: expect.objectContaining({ name: 'slowTool' }) })
      );

      // Latency should be a real positive number, reflecting the tool's
      // artificial 30ms delay.
      const toolResultLatency = onToolResult.mock.calls[0][2];
      expect(typeof toolResultLatency).toBe('number');
      expect(toolResultLatency).toBeGreaterThan(0);

      const llmResponseLatency = onLLMResponse.mock.calls[0][1];
      expect(typeof llmResponseLatency).toBe('number');
      expect(llmResponseLatency).toBeGreaterThanOrEqual(0);
    });
  });

  describe('withSpan tracing', () => {
    function createSpyExporter() {
      const starts: Span[] = [];
      const ends: Span[] = [];
      const exporter: TraceExporter = {
        onSpanStart: vi.fn((span: Span) => starts.push({ ...span })),
        onSpanEnd: vi.fn((span: Span) => ends.push({ ...span })),
      };
      return { exporter, starts, ends };
    }

    function buildToolAgentAndProvider() {
      let callCount = 0;
      const mockProvider = {
        name: 'mock',
        async generate() {
          callCount++;
          if (callCount === 1) {
            return {
              text: '',
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
              toolCalls: [
                {
                  id: 'call-1',
                  type: 'function' as const,
                  function: { name: 'echoTool', arguments: '{"msg":"secret-value"}' },
                },
              ],
            };
          }
          return {
            text: 'done',
            finishReason: 'stop' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        async stream() {
          throw new Error('not implemented');
        },
        supportsTools: () => true,
        supportsStreaming: () => false,
        async getModels() {
          return [];
        },
      };
      return mockProvider;
    }

    it('includes content in span attributes when redactContent is false', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('echoTool', {
        displayName: 'Echo Tool',
        tool: tool({
          description: 'Echoes its input',
          parameters: z.object({ msg: z.string() }),
          execute: async ({ msg }) => ({ echoed: msg }),
        }),
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('echoTool', { tool: 'echoTool', options: {} })
        .build();

      const { exporter, ends } = createSpyExporter();

      await AgentExecutor.execute({
        agent,
        input: 'please call echoTool',
        provider: buildToolAgentAndProvider() as LLMProvider,
        toolRegistry,
        exporter,
        redactContent: false,
      });

      const serialized = JSON.stringify(ends);
      expect(serialized).toContain('secret-value');

      const llmSpan = ends.find((s) => s.name.startsWith('chat'));
      expect(llmSpan?.attributes.prompt).toBeDefined();
      expect(llmSpan?.attributes.promptTokens).toBeDefined();
      expect(llmSpan?.attributes.finishReason).toBeDefined();

      const toolSpan = ends.find((s) => s.name.startsWith('execute_tool'));
      expect(toolSpan?.attributes.args).toBeDefined();
      expect(toolSpan?.attributes.result).toBeDefined();
      expect(toolSpan?.attributes).not.toHaveProperty('error');
      expect(typeof toolSpan?.attributes.latencyMs).toBe('number');
    });

    it('omits content from span attributes when redactContent is true, while keeping non-content fields', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('echoTool', {
        displayName: 'Echo Tool',
        tool: tool({
          description: 'Echoes its input',
          parameters: z.object({ msg: z.string() }),
          execute: async ({ msg }) => ({ echoed: msg }),
        }),
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('echoTool', { tool: 'echoTool', options: {} })
        .build();

      const { exporter, ends } = createSpyExporter();

      await AgentExecutor.execute({
        agent,
        input: 'please call echoTool',
        provider: buildToolAgentAndProvider() as LLMProvider,
        toolRegistry,
        exporter,
        redactContent: true,
      });

      const serialized = JSON.stringify(ends);
      expect(serialized).not.toContain('secret-value');

      const llmSpan = ends.find((s) => s.name.startsWith('chat'));
      expect(llmSpan?.attributes.prompt).toBeUndefined();
      expect(llmSpan?.attributes.promptTokens).toBeDefined();
      expect(llmSpan?.attributes.finishReason).toBeDefined();

      const toolSpan = ends.find((s) => s.name.startsWith('execute_tool'));
      expect(toolSpan?.attributes.args).toBeUndefined();
      expect(toolSpan?.attributes.result).toBeUndefined();
      expect(toolSpan?.attributes).not.toHaveProperty('error');
    });
  });

  describe('hooks', () => {

    it('a preGenerate hook can inject a message that is actually sent to the provider', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({
        name: 'inject-context',
        preGenerate: (ctx) => {
          ctx.request.messages.push({ role: 'system', content: 'injected-by-hook' });
        },
      });

      const generateSpy = vi.fn(provider.generate.bind(provider));
      const spiedProvider = { ...provider, generate: generateSpy };

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .build();

      await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider: spiedProvider as Partial<LLMProvider> as LLMProvider,
        hooks,
      });

      const sentMessages = generateSpy.mock.calls[0][0].messages;
      expect(sentMessages.some((m: Message) => m.content === 'injected-by-hook')).toBe(true);
    });

    it('a preToolCall hook mutating ctx.args changes what the tool is actually invoked with (redact-pii style)', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({
        name: 'redact-pii',
        preToolCall: (ctx) => {
          ctx.args.email = '[REDACTED]';
        },
      });

      const execute = vi.fn().mockResolvedValue({ ok: true });
      toolRegistry.register('sendEmail', {
        displayName: 'Send Email',
        tool: { description: 'send email', parameters: {}, execute } as Tool,
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('sendEmail', { tool: 'sendEmail', options: {} })
        .build();

      const toolCall = {
        id: 'call-1',
        type: 'function' as const,
        function: { name: 'sendEmail', arguments: JSON.stringify({ email: 'real@example.com' }) },
      };

      await AgentExecutor['executeToolCall'](toolCall, agent, toolRegistry, undefined, undefined, undefined, hooks, undefined, []);

      expect(execute).toHaveBeenCalledWith({ email: '[REDACTED]' }, expect.objectContaining({ toolCallId: 'call-1', messages: expect.any(Array) }));
    });
  });

  describe('provider.generate() failure compaction', () => {
    /**
     * A minimal, hand-rolled LLMProvider whose `generate()` is fully
     * scripted - throws a caller-supplied sequence of errors, then
     * (optionally) succeeds - so these tests control EXACTLY what
     * provider.generate() throws without depending on real network I/O or
     * a specific adapter's HTTP client.
     */
    function makeScriptedProvider(script: Array<unknown | 'success'>): LLMProvider {
      let call = 0;
      return {
        name: 'scripted',
        async generate(): Promise<GenerateResult> {
          const step = script[Math.min(call, script.length - 1)];
          call++;
          if (step === 'success') {
            return {
              text: 'ok',
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
          }
          throw step;
        },
        async stream() {
          throw new Error('not implemented');
        },
        supportsTools: () => false,
        supportsStreaming: () => false,
        async getModels() {
          return [];
        },
      };
    }

    it('leaves the existing tool-error {error} compaction pattern (resume.ts/executeToolCall) completely unaffected', async () => {
      // A tool that throws should still be compacted into a conversational
      // {error} tool-result message and the run should still complete
      // normally - this is the pre-existing pattern must not touch.
      const { tool } = await import('ai');
      const { z } = await import('zod');
      toolRegistry.register('boom', {
        displayName: 'Boom',
        tool: tool({
          description: 'always throws',
          parameters: z.object({}),
          execute: async (): Promise<string> => {
            throw new Error('tool exploded');
          },
        }),
      });

      const toolProvider = createMockProvider({
        name: 'mock',
        responses: ['calling boom', 'done'],
      });
      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('boom', { tool: 'boom', options: {} })
        .build();

      const events: AgentEvent[] = [];
      const result = await AgentExecutor.execute({
        agent,
        input: 'please call boom',
        provider: toolProvider,
        toolRegistry,
        onAgentEvent: (event) => events.push(event),
      });

      // Pre-existing pattern (unrelated to): a thrown tool error is
      // compacted to `{error: message}` on the `tool.error` event/return
      // value (see AgentExecutor.doExecuteToolCall()'s catch block) - the
      // run itself completes normally rather than rejecting.
      const toolErrorEvent = events.find((e) => e.type === 'tool.error');
      expect(toolErrorEvent?.error.message).toBe('tool exploded');
      const toolMessage = result.messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      // No CompactedLLMProviderError anywhere near this run.
      expect(result.finishReason).toBeDefined();
    });

    describe('with surfaceRetryableProviderErrors: true', () => {
      it('surfaces a rate-limit failure into messages (tagged, not a raw stack) and retries generation', async () => {
        const rawError = new APICallError({
          message: 'Rate limit reached for requests',
          url: 'https://api.openai.com/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'retry-after': '2' },
          isRetryable: true,
        });
        const scripted = makeScriptedProvider([rawError, 'success']);
        const agent = AgentBuilder.create()
          .setName('Test Agent')
          .build();

        const result = await AgentExecutor.execute({
          agent,
          input: 'Hello',
          provider: scripted,
          surfaceRetryableProviderErrors: true,
        });

        expect(result.text).toBe('ok');
        const surfaced = result.messages.find(
          (m) => m.role === 'user' && textOf(m).startsWith('[provider-error]')
        );
        expect(surfaced).toBeDefined();
        expect(surfaced!.content).toContain('rate-limit');
        expect(surfaced!.content).not.toContain('at APICallError');
        expect(surfaced!.content).not.toMatch(/\bat\s+.*:\d+:\d+/); // no stack frames
      });

      it('rejects with the last compacted error once maxSteps is exhausted by repeated retryable failures', async () => {
        const rawError = new APICallError({
          message: 'Request timed out',
          url: 'https://api.openai.com/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 408,
          isRetryable: true,
        });
        const scripted = makeScriptedProvider([rawError]); // always throws
        const agent = AgentBuilder.create()
          .setName('Test Agent')
          .build();

        let caught: unknown;
        try {
          await AgentExecutor.execute({
            agent,
            input: 'Hello',
            provider: scripted,
            surfaceRetryableProviderErrors: true,
            maxSteps: 3,
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(CompactedLLMProviderError);
        expect((caught as CompactedLLMProviderError).compacted.category).toBe('timeout');
      });
    });
  });
});
