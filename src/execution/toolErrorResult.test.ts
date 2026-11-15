import { describe, it, expect, vi } from 'vitest';
import type { Tool } from 'ai';
import type { LLMProvider, GenerateOptions } from '../providers';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';

/** A message as the provider saw it (a JSON copy; tool results are text in these tests). */
type SeenMessage = { role: string; content: string; toolCallId?: string };

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

/** Provider that calls `boom` for `steps` turns, then answers. */
function scriptedProvider(steps: number) {
  const seenMessages: SeenMessage[][] = [];
  let step = 0;
  const provider = {
    name: 'mock',
    async generate(options: GenerateOptions) {
      seenMessages.push(JSON.parse(JSON.stringify(options.messages)));
      if (step++ >= steps) {
        return { text: 'done', finishReason: 'stop' as const, usage };
      }
      return {
        text: '',
        finishReason: 'tool_calls' as const,
        usage,
        toolCalls: [
          {
            id: `call-${step}`,
            type: 'function' as const,
            function: { name: 'boom', arguments: '{}' },
          },
        ],
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
  return { provider: provider as LLMProvider, seenMessages };
}

function setup(execute: () => Promise<unknown>) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register('boom', {
    displayName: 'Boom',
    tool: { parameters: z.object({}), execute } as Tool,
  });
  const agent = AgentBuilder.create()
    .setName('Test Agent')
    .addTool('boom', { tool: 'boom', options: {} })
    .build();
  return { toolRegistry, agent };
}

describe('toolErrorMessage sanitizer', () => {
  const secret = 'DB password=hunter2 connection refused';

  it('replaces the text of a thrown error for the model, events and hooks', async () => {
    const { toolRegistry, agent } = setup(async () => {
      throw new Error(secret);
    });
    const { provider, seenMessages } = scriptedProvider(1);
    const events: AgentEvent[] = [];
    const toolErrorMessage = vi.fn(() => 'the database is unavailable');

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry, toolErrorMessage, onAgentEvent: e => events.push(e) });

    expect(toolErrorMessage).toHaveBeenCalledWith(expect.objectContaining({ message: secret }), { toolName: 'boom', toolCallId: 'call-1' });
    const payload = JSON.parse(seenMessages[1].find(m => m.role === 'tool')!.content);
    expect(payload).toEqual({ error: 'Error', toolName: 'boom', message: 'the database is unavailable', kind: 'execution' });
    expect(JSON.stringify(seenMessages[1])).not.toContain('hunter2');
    expect(events.find(e => e.type === 'tool.error')!.error.message).toBe('the database is unavailable');
  });
});
