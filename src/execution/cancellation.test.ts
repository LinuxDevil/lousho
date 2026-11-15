/**
 * Cancelling a run with an AbortSignal.
 *
 * Covers the executor loop (abort before start, during a model call, during
 * a tool call, between steps), checkpoint-on-abort + resume, the "an abort is
 * not a failure" rules (no retry, no failure compaction), delegated child
 * agents, createAgent().send() and resumeAfterApproval().
 */

import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import { Checkpoint, CheckpointStore } from './checkpoint';
import { createAgent } from '../createAgent';
import { ToolRegistry } from '../tools';
import { AgentConfig, ToolDescriptor } from '../types';
import type { GenerateOptions, GenerateResult, LLMProvider, ToolCall } from '../providers';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function textResult(text: string): GenerateResult {
  return { text, finishReason: 'stop', usage };
}

function toolCall(name: string, id = `call_${name}`): ToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function toolCallResult(...calls: ToolCall[]): GenerateResult {
  return { text: '', finishReason: 'tool_calls', usage, toolCalls: calls };
}

function scriptedProvider(generate: (options: GenerateOptions) => Promise<GenerateResult>) {
  const spy = vi.fn(generate);
  const provider: LLMProvider = {
    name: 'scripted',
    generate: spy,
    stream: vi.fn() as never,
    supportsTools: () => true,
    supportsStreaming: () => false, // generate-only: `stream` is a stub
    getModels: async () => [],
  };
  return { provider, generate: spy };
}

/** A generate() that never settles on its own - it only rejects once aborted. */
function hangUntilAborted(options: GenerateOptions): Promise<GenerateResult> {
  return new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  });
}

function agentWithTools(...toolNames: string[]): AgentConfig {
  const tools: AgentConfig['tools'] = {};
  for (const name of toolNames) {
    tools[name] = { tool: name };
  }
  return { id: 'agent-1', name: 'Agent', prompt: 'p', tools };
}

function registryWith(tools: Record<string, ToolDescriptor>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, descriptor] of Object.entries(tools)) {
    registry.register(name, descriptor);
  }
  return registry;
}

function simpleTool(
  execute: (args: Record<string, never>, options: { abortSignal?: AbortSignal }) => Promise<unknown>,
  extra: Partial<ToolDescriptor> = {}
): ToolDescriptor {
  return {
    displayName: 'Test tool',
    tool: tool({ description: 'test tool', parameters: z.object({}), execute }),
    ...extra,
  };
}

function createInMemoryCheckpointStore(): CheckpointStore & { checkpoints: Map<string, Checkpoint> } {
  const checkpoints = new Map<string, Checkpoint>();
  return {
    checkpoints,
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

describe('AgentExecutor cancellation', () => {

  it('checkpoints an aborted run so a later run with the same sessionId resumes it', async () => {
    const checkpointStore = createInMemoryCheckpointStore();
    const controller = new AbortController();
    const fast = simpleTool(async () => 'done');
    const first = scriptedProvider(async () => toolCallResult(toolCall('fast')));

    const aborted = await AgentExecutor.execute({
      agent: agentWithTools('fast'),
      input: 'do the thing',
      provider: first.provider,
      toolRegistry: registryWith({ fast }),
      sessionId: 's1',
      checkpointStore,
      signal: controller.signal,
      onAgentEvent: (event) => {
        if (event.type === 'tool.done') controller.abort();
      },
    });

    expect(aborted.finishReason).toBe('aborted');
    const saved = checkpointStore.checkpoints.get('s1');
    expect(saved?.finishReason).toBe('aborted');
    expect(saved?.messages.at(-1)).toMatchObject({ role: 'tool', content: '"done"' });

    let sentRoles: string[] = [];
    const second = scriptedProvider(async (options) => {
      sentRoles = options.messages.map((m) => m.role);
      return textResult('all done');
    });
    const resumed = await AgentExecutor.execute({
      agent: agentWithTools('fast'),
      input: 'do the thing', // a retry of the same request: resumes, nothing appended
      provider: second.provider,
      toolRegistry: registryWith({ fast }),
      sessionId: 's1',
      checkpointStore,
    });

    expect(resumed.finishReason).toBe('stop');
    expect(resumed.text).toBe('all done');
    expect(resumed.steps).toBe(2);
    expect(sentRoles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(checkpointStore.checkpoints.get('s1')?.status).toBe('finished');
  });

  it('a delegated child agent is aborted together with its parent', async () => {
    const controller = new AbortController();
    // Abort once the child is actually running, not on a timer: on a busy runner a
    // fixed delay can fire before the delegated call starts.
    const child = scriptedProvider((options: GenerateOptions) => {
      const pending = hangUntilAborted(options);
      setTimeout(() => controller.abort(), 0);
      return pending;
    });
    const childAgent = createAgent({ name: 'Child', provider: child.provider, description: 'Child agent' });
    const parent = scriptedProvider(async () => ({
      ...toolCallResult({
        id: 'call_delegate',
        type: 'function',
        function: {
          name: 'task',
          arguments: JSON.stringify({ agent: 'child', prompt: 'sub task', description: 'child task' }),
        },
      }),
    }));

    const result = await AgentExecutor.execute({
      agent: agentWithTools(),
      input: 'hi',
      provider: parent.provider,
      subagents: { child: childAgent },
      signal: controller.signal,
    });

    expect(child.generate).toHaveBeenCalledTimes(1);
    expect(child.generate.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(parent.generate).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('aborted');
  });
});
