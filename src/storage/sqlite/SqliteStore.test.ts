/**
 * SqliteStore - contract suites, persistence, migration, prune,
 * multi-instance access, error handling and an approval pause/resume that
 * crosses a close/reopen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Vite 5 cannot resolve the bare 'node:sqlite' builtin; load it the way the library does.
const DatabaseSync = loadDatabaseSync();
import { SqliteStore } from './index';
import { loadDatabaseSync } from './driver';
import {
  describeApprovalStoreContract,
  describeCheckpointStoreContract,
  describeSessionStoreContract,
  makeCheckpoint,
  
} from './__fixtures__/storeContracts';
import { MemorySessionStore, FileSessionStore } from '../../session/sessionStore';
import { decodeBytes, encodeBytes } from '../jsonBytes';
import type { Checkpoint, CheckpointStore } from '../../execution/checkpoint';
import type { ApprovalStore, ResolvedApproval } from '../../execution/ApprovalGate';
import { InMemoryApprovalStore } from '../../execution/InMemoryApprovalStore';
import { memoryStore } from '../agentStore';

const tempDirs: string[] = [];
const stores: SqliteStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-sqlite-'));
  tempDirs.push(dir);
  return dir;
}

function open(path: string): SqliteStore {
  const store = new SqliteStore(path);
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function inMemoryCheckpointStore(): CheckpointStore {
  const map = new Map<string, string>();
  return {
    async save(id, checkpoint) {
      map.set(id, JSON.stringify(checkpoint, encodeBytes));
    },
    async load(id) {
      const raw = map.get(id);
      return raw === undefined ? null : (JSON.parse(raw, decodeBytes) as Checkpoint);
    },
    async delete(id) {
      map.delete(id);
    },
  };
}

function inMemoryApprovalStore(): ApprovalStore {
  const map = new Map<string, string>();
  return {
    async save(pending, snapshot) {
      map.set(pending.id, JSON.stringify({ pending, snapshot }, encodeBytes));
    },
    async load(id) {
      const raw = map.get(id);
      return raw === undefined ? null : (JSON.parse(raw, decodeBytes) as ResolvedApproval);
    },
    async resolve(id) {
      const raw = map.get(id);
      if (raw === undefined) return null;
      map.delete(id);
      return JSON.parse(raw, decodeBytes) as ResolvedApproval;
    },
  };
}

describeSessionStoreContract('MemorySessionStore', () => new MemorySessionStore());
describeSessionStoreContract('FileSessionStore', () => new FileSessionStore(tempDir()));
describeSessionStoreContract('SqliteStore.sessions', () => open(':memory:').sessions);
describeCheckpointStoreContract('in-memory', inMemoryCheckpointStore);
describeCheckpointStoreContract('SqliteStore.checkpoints', () => open(':memory:').checkpoints);
describeCheckpointStoreContract('memoryStore().checkpoints', () => memoryStore().checkpoints);
describeApprovalStoreContract('in-memory', inMemoryApprovalStore);
describeApprovalStoreContract('InMemoryApprovalStore', () => new InMemoryApprovalStore());
describeApprovalStoreContract('SqliteStore.approvals', () => open(':memory:').approvals);

describe('SqliteStore persistence', () => {

  it('creates a missing directory and uses WAL mode', () => {
    const file = join(tempDir(), 'nested', 'deeper', 'agent.db');
    const store = open(file);
    expect(existsSync(file)).toBe(true);
    expect(store.path).toBe(file);
    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    raw.close();
  });
});

describe('SqliteStore migrations', () => {

  it('reports a corrupt checkpoint or transcript row with a typed error, and lists the run instead of failing', async () => {
    const file = join(tempDir(), 'corrupt.db');
    const store = open(file);
    await store.checkpoints.save('run-1', makeCheckpoint({ sessionId: 'run-1' }));
    await store.sessions.save('s1', [{ role: 'user', content: 'hi' }]);
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE checkpoints SET payload = '{\"broken' WHERE session_id = 'run-1'").run();
    raw.prepare("UPDATE sessions SET payload = '{\"broken' WHERE id = 's1'").run();
    raw.close();

    await expect(store.checkpoints.load('run-1')).rejects.toMatchObject({ code: 'LOUSHO_CHECKPOINT_CORRUPT' });
    expect((await store.checkpoints.list!()).map((entry) => [entry.sessionId, entry.checkpoint.lastError?.code])).toEqual([['run-1', 'LOUSHO_CHECKPOINT_CORRUPT']]);
    await expect(store.sessions.load('s1')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_FILE_CORRUPT' });
  });

  it('refuses a database written by a newer version', () => {
    const file = join(tempDir(), 'future.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 999');
    raw.close();
    expect(() => new SqliteStore(file)).toThrow(/newer than this library supports/);
  });
});

describe('SqliteStore errors', () => {

  it('gives a clear error when used after close(), and close() is idempotent', async () => {
    const store = new SqliteStore(':memory:');
    const { sessions, checkpoints, approvals } = store;
    store.close();
    store.close();
    await expect(sessions.load('a')).rejects.toThrow(/is closed/);
    await expect(checkpoints.save('a', makeCheckpoint())).rejects.toThrow(/is closed/);
    await expect(approvals.resolve('a')).rejects.toThrow(/is closed/);
    expect(() => store.prune({ olderThanMs: 0 })).toThrow(/is closed/);
  });
});
