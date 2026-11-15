import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Tool } from 'ai';
import type { LLMProvider } from '../providers';
import type { ResumeExecuteOptions } from './resume';
import { resumeAfterApproval } from './resume';
import { ApprovalStore, PendingApproval, ExecutionSnapshot } from './ApprovalGate';
import { AgentExecutor } from './AgentExecutor';
import { Checkpoint, CheckpointStore } from './checkpoint';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import type { Span } from './tracing';

/** Simple in-memory ApprovalStore, good enough for resume tests. */
function createInMemoryApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    async save(pending, snapshot) {
      records.set(pending.id, { pending, snapshot });
    },
    async resolve(id) {
      const record = records.get(id);
      if (!record) {
        return null;
      }
      records.delete(id);
      return record;
    },
  };
}

/** Simple in-memory CheckpointStore, good enough for resume tests. */
function createInMemoryCheckpointStore(): CheckpointStore {
  const checkpoints = new Map<string, Checkpoint>();
  return {
    async save(sessionId, checkpoint) {
      checkpoints.set(sessionId, checkpoint);
    },
    async load(sessionId) {
      return checkpoints.get(sessionId) ?? null;
    },
    async delete(sessionId) {
      checkpoints.delete(sessionId);
    },
  };
}

describe('Execution - resumeAfterApproval', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  it('an explicit businessState passed to resumeAfterApproval() overrides the stale pre-pause checkpoint value', async () => {
    const chargeExecute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: chargeExecute } as Tool,
      needsApproval: true,
    });

    const lookupExecute = vi.fn().mockResolvedValue({ found: true });
    toolRegistry.register('lookup', {
      displayName: 'Lookup',
      tool: { description: 'Look something up', parameters: {}, execute: lookupExecute } as Tool,
      needsApproval: false,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .addTool('lookup', { tool: 'lookup', options: {} })
      .build();

    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call === 1) {
          return {
            text: 'charging',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-charge', type: 'function' as const, function: { name: 'chargeCard', arguments: '{}' } },
            ],
          };
        }
        if (call === 2) {
          // Post-resume, unguarded tool call so AgentExecutor's normal
          // per-tool-result checkpoint.save() actually fires during the
          // resumed run.
          return {
            text: 'looking up',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-lookup', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          };
        }
        return {
          text: 'all done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const approvalStore = createInMemoryApprovalStore();
    const checkpointStore = createInMemoryCheckpointStore();
    const saveSpy = vi.spyOn(checkpointStore, 'save');
    const sessionId = 'business-state-override-session';

    const paused = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      sessionId,
      checkpointStore,
      businessState: { stage: 'stale-value' },
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    saveSpy.mockClear();

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as LLMProvider,
      { businessState: { stage: 'explicitly-overridden' } },
      checkpointStore
    );

    expect(resumed.finishReason).toBe('stop');
    expect(saveSpy).toHaveBeenCalled();
    for (const [, checkpoint] of saveSpy.mock.calls) {
      expect((checkpoint as Checkpoint).businessState).toEqual({ stage: 'explicitly-overridden' });
    }
  });

  describe('hooks', () => {

    it('a preToolCall hook that redacts args also on the paused run: the human approved the redacted input, which the deferred tool runs with', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({
        name: 'redact-pii',
        preToolCall: (ctx) => { ctx.args.email = '[REDACTED]'; },
      });

      const execute = vi.fn().mockResolvedValue({ sent: true });
      toolRegistry.register('sendEmail', {
        displayName: 'Send Email',
        tool: { description: 'send email', parameters: {}, execute } as Tool,
        needsApproval: true,
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('sendEmail', { tool: 'sendEmail', options: {} })
        .build();

      // Scripted provider emits a tool call carrying a real `email` arg -
      // the built-in MockLLMProvider always synthesizes empty `{}` args, so
      // it can't exercise argument mutation.
      const scriptedProvider = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => { throw new Error('not implemented'); },
        generate: async () => ({
          text: '',
          finishReason: 'tool_calls' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          toolCalls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: 'sendEmail', arguments: JSON.stringify({ email: 'real@example.com' }) },
            },
          ],
        }),
      };

      const approvalStore = createInMemoryApprovalStore();

      const paused = await AgentExecutor.execute({
        agent,
        input: 'email real@example.com',
        provider: scriptedProvider as LLMProvider,
        toolRegistry,
        approvalStore,
        hooks,
      });

      expect(paused.finishReason).toBe('awaiting-approval');

      const provider = createMockProvider({ name: 'mock', responses: ['Sending', 'Done'] });

      await resumeAfterApproval(
        { id: paused.approvalId!, approved: true },
        approvalStore,
        toolRegistry,
        provider,
        { hooks }
      );

      // The approval carries the redacted input, so the hook's rewrite on resume is a no-op.
      expect(execute).toHaveBeenCalledWith({ email: '[REDACTED]' }, expect.objectContaining({ toolCallId: 'call-1', messages: expect.any(Array) }));
    });

    it('a preToolCall hook that only exists on resume and changes args in place is refused', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({ name: 'redact-pii', preToolCall: (ctx) => { ctx.args.email = '[REDACTED]'; } });
      const execute = vi.fn().mockResolvedValue({ sent: true });
      toolRegistry.register('sendEmail', {
        displayName: 'Send Email',
        tool: { description: 'send email', parameters: {}, execute } as never,
        needsApproval: true,
      });
      const agent = AgentBuilder.create().setName('Test Agent').addTool('sendEmail', { tool: 'sendEmail', options: {} }).build();
      const call = { id: 'call-1', type: 'function' as const, function: { name: 'sendEmail', arguments: JSON.stringify({ email: 'real@example.com' }) } };
      const scripted = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => { throw new Error('not implemented'); },
        generate: async () => ({ text: '', finishReason: 'tool_calls' as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, toolCalls: [call] }),
      };
      const approvalStore = createInMemoryApprovalStore();
      const paused = await AgentExecutor.execute({ agent, input: 'email', provider: scripted as never, toolRegistry, approvalStore });

      const resumed = await resumeAfterApproval(
        { id: paused.approvalId!, approved: true },
        approvalStore,
        toolRegistry,
        createMockProvider({ name: 'mock', responses: ['Done'] }),
        { hooks }
      );

      expect(execute).not.toHaveBeenCalled();
      expect(resumed.messages.find((m) => m.role === 'tool')?.content).toContain('approved with different input');
    });
  });
});

describe('Execution - resumeAfterApproval: error text on the resumed run span', () => {
  const secret = 'abcdefghij0123456789ABCD';
  const failedRunSpan = async (executeOptions: ResumeExecuteOptions) => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: async () => ({ charged: true }) } as Tool,
      needsApproval: true,
    });
    const agent = AgentBuilder.create().setName('Test Agent').addTool('chargeCard', { tool: 'chargeCard', options: {} }).build();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });
    const approvalStore = createInMemoryApprovalStore();
    const paused = await AgentExecutor.execute({ agent, input: 'Please call chargeCard now', provider, toolRegistry, approvalStore });
    const failing = { ...provider, generate: async () => { throw new Error('boom Bearer ' + secret); } } as unknown as LLMProvider;
    const ended: Span[] = [];
    const exporter = { onSpanStart: () => {}, onSpanEnd: (span: Span) => void ended.push({ ...span }) };
    await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, failing, { exporter, ...executeOptions }).catch(() => undefined);
    return ended.find((span) => span.name.startsWith('invoke_agent'))!;
  };

  it('scrubs by default, applies a custom redactor, keeps the text under redactContent: false', async () => {
    expect(JSON.stringify((await failedRunSpan({})).status)).not.toContain(secret);
    expect((await failedRunSpan({ redactContent: (t) => t.replace(secret, '<custom>') })).status?.message).toContain('<custom>');
    const kept = await failedRunSpan({ redactContent: false });
    expect(kept.status?.message).toContain(secret);
    expect(kept.attributes.error).toContain(secret);
  });
});

describe('Execution - resumeAfterApproval: the span of the approved call (#281)', () => {
  const approvedRun = async (executeOptions: ResumeExecuteOptions) => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: async () => ({ charged: true }) } as Tool,
      needsApproval: true,
    });
    const agent = AgentBuilder.create().setName('Test Agent').addTool('chargeCard', { tool: 'chargeCard', options: {} }).build();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });
    const approvalStore = createInMemoryApprovalStore();
    const paused = await AgentExecutor.execute({ agent, input: 'Please call chargeCard now', provider, toolRegistry, approvalStore });
    const ended: Span[] = [];
    const exporter = { onSpanStart: () => {}, onSpanEnd: (span: Span) => void ended.push({ ...span }) };
    await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider, { exporter, ...executeOptions });
    return ended.find((span) => span.attributes['gen_ai.operation.name'] === 'execute_tool')!;
  };

  it('keeps the call arguments and result off the span with redactContent, and on it with captureContent', async () => {
    const redacted = await approvedRun({ redactContent: true });
    expect(redacted.attributes.args).toBeUndefined();
    expect(redacted.attributes.result).toBeUndefined();
    expect(redacted.attributes['gen_ai.tool.call.result']).toBeUndefined();

    const captured = await approvedRun({ captureContent: true, redactContent: false });
    expect(captured.attributes.result).toEqual({ charged: true });
    expect(captured.attributes['gen_ai.tool.call.result']).toBe('{"charged":true}');
  });
});
