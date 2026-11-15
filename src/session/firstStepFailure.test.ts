/**
 * A checkpointed session's turn whose FIRST model call fails (a 5xx after the
 * retries, an exhausted 429, a malformed response) kept nothing: the run saves
 * its first checkpoint only after a model response, so `pending()` was `null`
 * and the customer's message was gone. The turn is now kept as an
 * `in-progress` checkpoint holding its input, and the next `send()` (or
 * `resume()`) runs it again, with the user's message in the transcript once.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { SqliteStore } from '../storage/sqlite';
import { mockModel } from '../testing';
import type { Message } from '../providers/llm';
import type { CheckpointStore } from '../execution/checkpoint';
import type { Principal } from '../auth/types';

const unavailable = () => Object.assign(new Error('503 service unavailable'), { status: 503 });
const failing = () => mockModel([{ error: unavailable() }], { onExhausted: 'repeat-last' });
const users = (messages: ReadonlyArray<Pick<Message, 'role'> & { content: unknown }>) => messages.filter((m) => m.role === 'user').map((m) => m.content);

type DurableStore = AgentStore & { checkpoints: CheckpointStore; close?: () => void };
const memory = new Map<string, DurableStore>();
/** Each store, opened again on the same data (the memory store: the same object) as a restarted process would. */
const stores: Array<[string, (dir: string) => DurableStore]> = [
  ['memoryStore()', (dir) => memory.get(dir) ?? memory.set(dir, memoryStore()).get(dir)!],
  ['fileStore(dir)', (dir) => fileStore(dir)],
  ['SqliteStore(file)', (dir) => new SqliteStore(join(dir, 'agent.db'))],
];

describe('a session turn whose first model call fails', () => {
  it.each(stores)('keeps the input as a pending turn and the next send() resumes it once (%s)', async (_name, makeStore) => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-first-step-'));
    try {
      const store = makeStore(dir);
      const session = createAgent({ provider: failing(), store, retry: false, instructions: 'Be brief.' }).session({ id: 'chat' });
      await expect(session.send('Where is my order #123?')).rejects.toThrow('503');

      expect(await session.load()).toEqual([]);
      expect(await session.pending()).toMatchObject({ status: 'in-progress' });
      const checkpoint = await store.checkpoints.load('chat.turn-0');
      expect(checkpoint).toMatchObject({ status: 'in-progress', attempts: 1, lastError: { retryable: true }, unstarted: true });
      expect(users(checkpoint!.messages)).toEqual(['Where is my order #123?']);
      store.close?.();

      // A fresh process: the next send() runs the failed turn first, then the new message.
      const reopened = makeStore(dir);
      const model = mockModel(['It ships today.', 'You are welcome.']);
      const result = await createAgent({ provider: model, store: reopened, instructions: 'Be brief.' }).session({ id: 'chat' }).send('Thanks');
      expect(result.text).toBe('You are welcome.');
      expect(model.calls).toHaveLength(2);
      // The resumed turn ran as a new turn: system prompt first, the original message once.
      expect(model.calls[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
      expect(users(model.calls[0].messages)).toEqual(['Where is my order #123?']);
      const transcript = await createAgent({ provider: model, store: reopened }).session({ id: 'chat' }).load();
      expect(transcript.map((m) => [m.role, m.content])).toEqual([
        ['user', 'Where is my order #123?'],
        ['assistant', 'It ships today.'],
        ['user', 'Thanks'],
        ['assistant', 'You are welcome.'],
      ]);
      expect(await reopened.checkpoints.load('chat.turn-0')).toBeNull();
      reopened.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the metadata and principal the turn was sent with for the rerun', async () => {
    const store = memoryStore();
    const principal: Principal = { id: 'user-1', type: 'user', authenticator: 'test' };
    const session = createAgent({ provider: failing(), store, retry: false }).session({ id: 'chat' });
    await expect(session.send('hi', { metadata: { tenant: 'acme' }, principal })).rejects.toThrow('503');
    expect(await store.checkpoints.load('chat.turn-0')).toMatchObject({ metadata: { tenant: 'acme' }, principal });

    const seen: unknown[] = [];
    const agent = createAgent({ provider: mockModel(['ok']), store, instructions: (ctx) => (seen.push(ctx.metadata), 'Be brief.') });
    await agent.session({ id: 'chat' }).resume();
    expect(seen).toContainEqual({ tenant: 'acme' });
  });
});
