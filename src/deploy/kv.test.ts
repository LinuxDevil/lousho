/**
 * R2: `lousho/kv` must bundle for a hand-written Cloudflare
 * Worker, which has no shim for Node builtins. This guards the barrel's
 * import graph: no module it reaches may import a `node:` path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { stop } from 'esbuild';
import * as kv from './kv';

// esbuild keeps a service process alive after build(); end it so it does not outlive this file.
afterAll(() => stop());

describe('lousho/kv (R2)', () => {

  it('exports KVStore, KVCheckpointStore, CHECKPOINT_KV_BINDING and kvMemory', () => {
    expect(Object.keys(kv).sort()).toEqual(['CHECKPOINT_KV_BINDING', 'KVCheckpointStore', 'KVStore', 'kvMemory']);
    expect(kv.CHECKPOINT_KV_BINDING).toBe('AGENT_CHECKPOINTS');
    const memory = new Map<string, string>();
    const binding: kv.KVBinding = {
      get: async (key) => memory.get(key) ?? null,
      put: async (key, value, _options?: kv.KVPutOptions) => void memory.set(key, value),
      delete: async (key) => void memory.delete(key),
    };
    const options: kv.KVStoreOptions = { prefix: 'app/' };
    expect(new kv.KVStore(binding, options).checkpoints).toBeInstanceOf(kv.KVCheckpointStore);
  });
});
