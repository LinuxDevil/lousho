/**
 * KVStore, the AgentStore on a Workers KV namespace, against a fake
 * binding (the same store runs once under workerd in adapters/cloudflare.test.ts).
 */
import { describe, it, expect } from 'vitest';
import type { ExecutionSnapshot, PendingApproval } from '../execution/ApprovalGate';
import type { KVBinding, KVPutOptions } from './kvCheckpointStore';
import { KVStore } from './kvStore';
import {
  describeApprovalStoreContract,
  describeCheckpointStoreContract,
  describeSessionStoreContract,
} from '../storage/sqlite/__fixtures__/storeContracts';

function fakeKV() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv: KVBinding = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value, options?: KVPutOptions) => {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key) => void data.delete(key),
    // One key per page, so the cursor loop is exercised.
    list: async ({ prefix = '', cursor }) => {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
      const at = cursor === undefined ? 0 : Number(cursor);
      const done = at + 1 >= keys.length;
      return { keys: keys.slice(at, at + 1).map((name) => ({ name })), list_complete: done, ...(!done && { cursor: String(at + 1) }) };
    },
  };
  return { kv, data, ttls };
}

// The shared store contracts, including the Uint8Array round-trip.
describeSessionStoreContract('KVStore.sessions', () => new KVStore(fakeKV().kv).sessions);
describeCheckpointStoreContract('KVStore.checkpoints', () => new KVStore(fakeKV().kv).checkpoints);
describeApprovalStoreContract('KVStore.approvals', () => new KVStore(fakeKV().kv).approvals);

const pending: PendingApproval = { id: 'ap-1', toolCallId: 'call-1', toolName: 'ping', args: { n: 1 }, createdAt: '2026-01-01T00:00:00.000Z' };
const snapshot = { currentMessages: [{ role: 'user', content: 'hi' }], pendingToolCall: pending, steps: 1 } as unknown as ExecutionSnapshot;

describe('KVStore options', () => {

  it('expires each kind of record with its own TTL, and none by default', async () => {
    const { kv, ttls } = fakeKV();
    const store = new KVStore(kv, { ttl: { sessions: 86_400, checkpoints: 3_600, approvals: 600 }, historyLimit: 0 });
    await store.sessions.save('a', []);
    await store.approvals.save(pending, snapshot);
    await store.checkpoints.save('a', { agentId: 'a', sessionId: 'a', stepIndex: 0, messages: [], toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    expect(Object.fromEntries(ttls)).toEqual({ 'sessions/a': 86_400, 'approvals/ap-1': 600, 'checkpoints/a': 3_600 });

    const plain = fakeKV();
    await new KVStore(plain.kv).sessions.save('a', []);
    expect(plain.ttls.get('sessions/a')).toBeUndefined();
  });
});

describe('KVStore approvals: two decisions of one approval at once', () => {

  it('hands the record to exactly one caller when operations take a random 0-3 ms (one location)', async () => {
    const fake = fakeKV();
    const jitter = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
    const kv: KVBinding = {
      get: async (key) => (await jitter(), fake.kv.get(key)),
      put: async (key, value, options) => (await jitter(), fake.kv.put(key, value, options)),
      delete: async (key) => (await jitter(), fake.kv.delete(key)),
    };
    const { approvals } = new KVStore(kv);
    for (let trial = 0; trial < 30; trial++) {
      await approvals.save(pending, snapshot);
      const results = await Promise.all([approvals.resolve('ap-1'), approvals.resolve('ap-1')]);
      expect(results.filter((record) => record !== null)).toHaveLength(1);
    }
    // 30 trials of ~8 sequential jittered KV ops plus the 50 ms settle window: ~2 s on Linux, ~5.5 s on
    // Windows, whose timers round a 0-3 ms delay up to its ~15.6 ms clock tick.
  }, 30_000);
});
