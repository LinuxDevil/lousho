/**
 * `AgentStore.tokens` on every shipped store. The shared contract runs
 * against memoryStore(), fileStore(), SqliteStore and KVStore; the rest checks
 * what only persistent stores do: encryption at rest, the key, migrations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { SqliteStore } from '../storage/sqlite';
import { KVStore } from '../deploy/kvStore';
import type { KVBinding, KVListOptions, KVPutOptions } from '../deploy/kvCheckpointStore';
import { generateTokenKey, tokenStoreKey, type OAuthTokenStore, type TokenOwner } from './index';
import { describeTokenStoreContract, errorText, SENTINEL_ACCESS, SENTINEL_REFRESH, sentinelToken } from './tokenStore.contract';

const KEY = generateTokenKey();
const APP: TokenOwner = { owner: 'app' };
const STATE = 'state-0123456789abcdef';

const dirs: string[] = [];
const sqliteStores: SqliteStore[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-oauth-'));
  dirs.push(dir);
  return dir;
}
function sqlite(options: ConstructorParameters<typeof SqliteStore>[1] = { tokenKey: KEY }, file = ':memory:'): SqliteStore {
  const store = new SqliteStore(file, options);
  sqliteStores.push(store);
  return store;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const store of sqliteStores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An in-memory KV namespace with list() pages of two keys, and the ttl of each put. */
function fakeKV(withList = true) {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv: KVBinding = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value, options?: KVPutOptions) => {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key) => void data.delete(key),
  };
  if (withList) {
    kv.list = async ({ prefix = '', cursor }: KVListOptions) => {
      const names = [...data.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const end = start + 2;
      return { keys: names.slice(start, end).map((name) => ({ name })), list_complete: end >= names.length, cursor: String(end) };
    };
  }
  return { kv, data, ttls };
}

describeTokenStoreContract('memoryStore().tokens', () => memoryStore().tokens);
describeTokenStoreContract('fileStore(dir).tokens', () => fileStore(tempDir(), { tokenKey: KEY }).tokens);
describeTokenStoreContract('SqliteStore.tokens', () => sqlite().tokens);
describeTokenStoreContract('KVStore.tokens', () => new KVStore(fakeKV().kv, { tokenKey: KEY, prefix: 'app/' }).tokens);

/** Every persistent store, with a way to read everything it wrote, raw. */
const persistent: Array<{ name: string; make: (tokenKey?: string) => { tokens: OAuthTokenStore; raw: () => string } }> = [
  {
    name: 'fileStore',
    make: (tokenKey) => {
      const dir = tempDir();
      const raw = (): string => {
        const read = (path: string): string[] =>
          readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? read(join(path, entry.name)) : [readFileSync(join(path, entry.name), 'utf8')]
          );
        try {
          return read(dir).join('\n');
        } catch {
          return '';
        }
      };
      return { tokens: fileStore(dir, { tokenKey }).tokens, raw };
    },
  },
  {
    name: 'SqliteStore',
    make: (tokenKey) => {
      const store = sqlite({ tokenKey });
      const raw = (): string => {
        const db = store.connection.db;
        const rows = [...db.prepare('SELECT key, payload FROM oauth_tokens').all(), ...db.prepare('SELECT state, payload FROM oauth_pending').all()];
        return JSON.stringify(rows);
      };
      return { tokens: store.tokens, raw };
    },
  },
  {
    name: 'KVStore',
    make: (tokenKey) => {
      const { kv, data } = fakeKV();
      return { tokens: new KVStore(kv, { tokenKey }).tokens, raw: () => JSON.stringify([...data]) };
    },
  },
];

describe.each(persistent)('$name tokens at rest', ({ make }) => {
  it('stores no access token, refresh token, PKCE verifier or client secret in plaintext', async () => {
    const { tokens, raw } = make(KEY);
    await tokens.set('github', { owner: 'user', principalId: 'alice', issuer: 'https://id.example.com' }, sentinelToken());
    await tokens.set('github', APP, sentinelToken());
    await tokens.setClient('github', { client_id: 'abc', client_secret: SENTINEL_REFRESH });
    await tokens.putPending(STATE, { provider: 'github', owner: APP, codeVerifier: SENTINEL_ACCESS, redirectUri: 'https://x.example/cb', createdAt: 1 }, 60_000);
    const stored = raw();
    expect(stored).toMatch(/v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+/);
    expect(stored).not.toContain(SENTINEL_ACCESS);
    expect(stored).not.toContain(SENTINEL_REFRESH);
    expect(stored).not.toContain('repo read:user'); // the scope is inside the sealed record too
  });

  it('throws LOUSHO_TOKEN_KEY_MISSING on the first write without a key; reads of nothing need no key', async () => {
    vi.stubEnv('LOUSHO_TOKEN_KEY', '');
    const { tokens } = make(undefined);
    expect(await tokens.get('github', APP)).toBeUndefined();
    expect(await tokens.getClient('github')).toBeUndefined();
    expect(await tokens.takePending(STATE)).toBeUndefined();
    expect(await tokens.list()).toEqual([]);
    await expect(tokens.delete('github', APP)).resolves.toBeUndefined();
    for (const write of [
      tokens.set('github', APP, sentinelToken()),
      tokens.setClient('github', { client_id: 'abc' }),
      tokens.putPending(STATE, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 60_000),
    ]) {
      await expect(write).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_KEY_MISSING' });
    }
    const text = await errorText(tokens.set('github', APP, sentinelToken()));
    expect(text).toMatch(/no OAuth token key/);
    expect(text).not.toContain(SENTINEL_ACCESS);
    expect(text).not.toContain(SENTINEL_REFRESH);
  });

  it('uses LOUSHO_TOKEN_KEY when no tokenKey is given', async () => {
    vi.stubEnv('LOUSHO_TOKEN_KEY', KEY);
    const { tokens } = make(undefined);
    await tokens.set('github', APP, sentinelToken());
    expect(await tokens.get('github', APP)).toEqual(sentinelToken());
  });

  it('refuses a malformed tokenKey when the store is built', () => {
    expect(() => make('too-short')).toThrow(/must be 32 random bytes as base64/);
  });
});

describe('tokenStoreKey', () => {
  it('is <provider>|app or <provider>|user|<issuer>|<principalId>, percent-encoded', () => {
    expect(tokenStoreKey('github', APP)).toBe('github|app');
    expect(tokenStoreKey('github', { owner: 'user', principalId: 'u-1' })).toBe('github|user||u-1');
    expect(tokenStoreKey('github', { owner: 'user', principalId: 'a|b', issuer: 'https://id.example.com' })).toBe(
      'github|user|https%3A%2F%2Fid.example.com|a%7Cb'
    );
  });
});
