/**
 * CreateAgent()'s `model`, `instructions` and `tools` as functions
 * of the run, resolved once when each run (or session turn) starts.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent, type RunConfigContext } from './createAgent';
import { defineTool, type DefinedTool } from './tools/defineTool';
import { memoryStore } from './storage/agentStore';
import { mockModel, type MockModel } from './testing';

function namedTool(name: string, options: { needsApproval?: boolean } = {}): DefinedTool {
  return defineTool({ name, description: name, input: z.object({}), needsApproval: options.needsApproval, execute: async () => `${name} done` });
}

describe('createAgent dynamic config', () => {

  it('a run resumed after approval keeps its model and re-resolves its tools with the same ctx', async () => {
    const store = memoryStore();
    const send = namedTool('send_email', { needsApproval: true });
    const options = (provider: MockModel, picked: string[]) => ({
      provider,
      store,
      // Not deterministic on purpose: a resumed run must not switch model.
      model: () => `model-${picked.push('x')}`,
      tools: ({ metadata }: RunConfigContext) => (metadata?.role === 'admin' ? [send] : []),
    });
    const first = mockModel([{ toolCalls: [{ name: 'send_email' }] }]);
    const paused = await createAgent(options(first, [])).send('Email Sam', { sessionId: 'job', metadata: { role: 'admin' } });
    expect(paused.finishReason).toBe('awaiting-approval');

    // A fresh agent (e.g. after a restart) resumes from the stored approval.
    const second = mockModel(['Sent.']);
    const result = await createAgent(options(second, ['already', 'moved'])).approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('Sent.');
    expect(result.messages.find((m) => m.role === 'tool')?.content).toBe(JSON.stringify('send_email done'));
    expect(first.calls[0].model).toBe('model-1');
    expect(second.calls[0].model).toBe('model-1');
  });
});
