/**
 * #298: `kvMemory()` marks a memory provider for late binding to the Worker's
 * KV namespace; `bindWorkerMemoryProvider()` swaps it for the KV-backed (or,
 * unbound, in-memory) provider when a request arrives.
 */
import { describe, it, expect } from 'vitest';
import { bindWorkerMemoryProvider, kvMemory } from './workerMemory';
import type { KVBinding } from './kvCheckpointStore';

/** A KVBinding over a Map, for tests. */
function fakeKv(map = new Map<string, string>()): KVBinding & { map: Map<string, string> } {
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
  };
}

describe('kvMemory (#298)', () => {

  it('keeps items under memory/<scopeKey> of the AGENT_CHECKPOINTS binding by default', async () => {
    const kv = fakeKv();
    const provider = bindWorkerMemoryProvider(kvMemory(), { AGENT_CHECKPOINTS: kv });
    const item = await provider.add('global', { text: 'likes tea' });
    expect(JSON.parse(kv.map.get('memory/global') as string)).toEqual([item]);
    expect((await provider.list('global')).map((i) => i.text)).toEqual(['likes tea']);
    await provider.remove('global', item.id);
    expect(await provider.list('global')).toEqual([]);
  });
});
