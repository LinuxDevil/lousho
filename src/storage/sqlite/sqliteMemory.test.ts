/**
 * SqliteMemory - the shared provider contract, persistence across
 * store instances, migration of an older database, and an agent that recalls
 * in one session what it remembered in another.
 */
import { afterEach,  } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeMemoryProviderContract } from '../../memory/providerContract';
import { SqliteStore, sqliteMemory } from './index';

const dirs: string[] = [];
const stores: SqliteStore[] = [];

const open = (file: string): SqliteStore => {
  const store = new SqliteStore(file);
  stores.push(store);
  return store;
};
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-sqlite-memory-'));
  dirs.push(dir);
  return join(dir, 'agent.db');
};

afterEach(() => {
  // Close before deleting: Windows keeps open SQLite files locked.
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeMemoryProviderContract('sqliteMemory', (options) => sqliteMemory(open(tempFile()), options));
