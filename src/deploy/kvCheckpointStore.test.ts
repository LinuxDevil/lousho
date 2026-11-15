/**
 * KVCheckpointStore unit tests, plus proof it satisfies whatever
 * resumeAfterApproval() expects from a CheckpointStore (the same contract
 * LocalStorageCheckpointStore/FileCheckpointStore already satisfy - see
 * src/execution/checkpoint.ts and apps/agent-forge/server/checkpointStore.ts).
 *
 * The real "does this work on an actual built Worker bundle" proof lives in
 * src/deploy/adapters/cloudflare.checkpoint.test.ts; this file exercises the
 * store directly (in-memory mock KVBinding - no real Cloudflare account/KV
 * namespace needed, same "reasonable mock object" approach the ticket calls
 * out since Miniflare/workers-types aren't already devDependencies here).
 */
import { describe, it, expect, vi } from 'vitest';
import { KVBinding, KVCheckpointStore, DEFAULT_KV_KEY_PREFIX } from './kvCheckpointStore';
import { Checkpoint } from '../execution/checkpoint';

/** Simple in-memory stand-in for a real Cloudflare KV namespace binding. */
function createMockKV(): KVBinding & { data: Map<string, string>; putCalls: [string, string][] } {
  const data = new Map<string, string>();
  const putCalls: [string, string][] = [];
  return {
    data,
    putCalls,
    async get(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    async put(key: string, value: string) {
      putCalls.push([key, value]);
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    stepIndex: 1,
    messages: [{ role: 'user', content: 'hi' }],
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ...overrides,
  };
}

describe('KVCheckpointStore', () => {

  it('only touches the injected KVBinding (get/put/delete) - proves this module has no hidden platform dependency', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const put = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn().mockResolvedValue(undefined);
    const store = new KVCheckpointStore({ get, put, delete: del }, undefined, undefined, { historyLimit: 0 });

    await store.load('s');
    await store.save('s', makeCheckpoint());
    await store.delete('s'); // delete also reads and removes the (empty) history index

    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(2);
  });
});

describe('KVCheckpointStore history layout', () => {
  const sessionId = 'session-1';
  const base = `${DEFAULT_KV_KEY_PREFIX}${sessionId}`;

  it('survives a crash between writes: an orphan entry, a row without its entry or a corrupt index is harmless', async () => {
    const kv = createMockKV();
    const store = new KVCheckpointStore(kv);
    await store.save(sessionId, makeCheckpoint({ stepIndex: 1 }));
    await store.save(sessionId, makeCheckpoint({ stepIndex: 2 }));
    const index = JSON.parse(kv.data.get(`${base}#history`)!) as string[];
    kv.data.delete(`${base}#history/${index[1]}`); // not propagated yet
    kv.data.set(`${base}#history/orphan`, '{}'); // entry saved, index write lost
    expect((await store.history(sessionId)).map((entry) => entry.step)).toEqual([1]);
    kv.data.set(`${base}#history`, 'not json');
    expect(await store.history(sessionId)).toEqual([]);
    expect((await store.load(sessionId))?.stepIndex).toBe(2);
  });
});
