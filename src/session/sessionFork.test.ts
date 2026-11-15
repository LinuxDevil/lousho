/**
 * `session.history()` and `session.fork({ fromStep })` on agent sessions,
 * offline with mockModel.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { type SDKError } from '../execution/errors';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockRequest, type MockTurn } from '../testing';
import { AgentSession,  } from './index';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const lookup = defineTool({
  name: 'lookup',
  description: 'look up',
  input: z.object({ q: z.string() }),
  execute: async ({ q }) => `result for ${q}`,
});

const sendEmail = defineTool({
  name: 'send_email',
  description: 'send an email',
  input: z.object({}),
  needsApproval: true,
  execute: async () => 'sent',
});

const convo = (call: Pick<MockRequest, 'messages'> | undefined): string[] =>
  (call?.messages ?? []).filter((m) => m.role !== 'system').map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`);
const lookupTurn: MockTurn = { toolCalls: [{ name: 'lookup', id: 'c1', args: { q: 'x' } }] };

/** A two-turn session: turn 0 calls `lookup` then answers, turn 1 answers. `extra` scripts later calls. */
async function twoTurns(extra: MockTurn[] = [], options: Parameters<ReturnType<typeof createAgent>['session']>[0] = {}) {
  const model = mockModel([lookupTurn, 'It is x.', 'Bye.', ...extra]);
  const agent = createAgent({ provider: model, tools: [lookup, sendEmail] });
  const session = agent.session({ id: 'chat', ...options });
  await session.send('find x');
  await session.send('thanks');
  return { model, agent, session };
}

async function rejection(promise: Promise<unknown>): Promise<SDKError & { field?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as SDKError & { field?: string };
  }
  throw new Error('expected a rejection');
}

describe('session.fork()', () => {

  it('rejects a step outside 0..history().length, listing the range', async () => {
    const { session } = await twoTurns();
    for (const fromStep of [4, -1, 1.5]) {
      const error = await rejection(session.fork({ fromStep }));
      expect(error.code).toBe('LOUSHO_SESSION_STEP_NOT_FOUND');
      expect(error.name).toBe('ConfigurationError');
      expect(error.field).toBe('fromStep');
      expect(error.message).toContain('from 0 to 3');
    }
  });

  it('forks a session whose id is too long for <id>-fork-<n> under a valid, distinct id', async () => {
    const agent = createAgent({ provider: mockModel(['hi'], { onExhausted: 'repeat-last' }), store: memoryStore() });
    for (const length of [122, 128]) {
      const id = 'u'.repeat(length);
      const session = agent.session({ id });
      await session.send('hello');
      const first = await session.fork({ fromStep: 1 });
      const second = await session.fork({ fromStep: 1 });
      for (const fork of [first, second]) {
        expect(fork.id.length).toBeLessThanOrEqual(128);
        expect(fork.id).toMatch(/^u+-[0-9a-f]{8}-fork-\d+$/);
      }
      expect(second.id).not.toBe(first.id);
      expect((await second.send('again')).text).toBe('hi');
    }
  });

  it('replaces a tool result with patch.toolResult and leaves the original alone', async () => {
    const { model, session } = await twoTurns(['patched']);
    const fork = await session.fork({ fromStep: 1, patch: { toolResult: { toolCallId: 'c1', result: { temp: 3 } } } });
    expect((await fork.history())[0].toolCalls[0].result).toBe('{"temp":3}');
    await fork.send('so?');
    expect(convo(model.calls[3])[2]).toBe('tool:{"temp":3}');
    expect((await session.history())[0].toolCalls[0].result).toBe('"result for x"');

    const error = await rejection(session.fork({ fromStep: 1, patch: { toolResult: { toolCallId: 'nope', result: 1 } } }));
    expect(error.field).toBe('patch.toolResult');
  });

  it('rejects with LOUSHO_SESSION_FORK_UNSUPPORTED on a session built without a spawner', async () => {
    const session = new AgentSession(async () => {
      throw new Error('not called');
    });
    await expect(session.fork({ fromStep: 0 })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_FORK_UNSUPPORTED' });
  });
});
