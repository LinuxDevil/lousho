import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseSync, type SqlValue } from '../../storage/sqlite/driver';
import { postgresSqlClient, sqliteSqlClient, type PgPool, type PgQueryable, type SqlClient } from '../runtime/sql';
import { postgresWorkspaceSource, sqliteWorkspaceSource } from './dbSource';
import { StaleRevisionError } from './errors';
import { revisionId } from './revision';
import type { SourceWriteOptions } from './types';
import { CONTRACT_FILES, sourceContract } from './__fixtures__/sourceContract';

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
});

function tracked<T extends { close(): Promise<void> }>(item: T): T {
  open.push(item);
  return item;
}

interface PgCall {
  on: 'pool' | 'connection';
  text: string;
  values: unknown[];
}

type PgQuery = PgQueryable['query'];

interface FakePool {
  pool: PgPool;
  calls: PgCall[];
  releases: unknown[];
  onConnect: (hook: () => Promise<void>) => void;
  failRollback: () => void;
}

function fakePool(): FakePool {
  const db = new (loadDatabaseSync())(':memory:');
  const calls: PgCall[] = [];
  const hooks: Array<() => Promise<void>> = [];
  const releases: unknown[] = [];
  let rollbackFails = false;
  const run =
    (on: PgCall['on']): PgQuery =>
    async (text, values = []) => {
      calls.push({ on, text, values });
      if (text === 'ROLLBACK' && rollbackFails) throw new TypeError('connection terminated');
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) {
        db.exec(text);
        return { rows: [], rowCount: null };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
      const statement = db.prepare(text.replace(/\$\d+/g, '?'));
      const bound = [...text.matchAll(/\$(\d+)/g)].map((match) => values[Number(match[1]) - 1]) as SqlValue[];
      if (/^\s*SELECT/i.test(text)) return { rows: statement.all(...bound), rowCount: null };
      return { rows: [], rowCount: Number(statement.run(...bound).changes) };
    };
  const pool: PgPool = {
    query: run('pool'),
    async connect() {
      for (const hook of hooks.splice(0)) await hook();
      return { query: run('connection'), release: (error) => void releases.push(error) };
    },
    end: async () => db.close(),
  };
  return { pool, calls, releases, onConnect: (hook) => void hooks.push(hook), failRollback: () => void (rollbackFails = true) };
}

function edit(expectedRevision: string, by: SourceWriteOptions['by'], extra: Partial<SourceWriteOptions> = {}): SourceWriteOptions {
  return { expectedRevision, by, message: `${by} edits`, ...extra };
}

async function countRows(client: SqlClient, table: string): Promise<number> {
  return Number((await client.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n);
}

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

sourceContract('db (sqlite)', async (files) => tracked(await sqliteWorkspaceSource(':memory:', { files })));

sourceContract('db (postgres client over a fake pool)', async (files) => tracked(await postgresWorkspaceSource(fakePool().pool, { files, ownsPool: true })));

describe('dbSource', () => {

  it('keeps workspaces apart by project and workspace id', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const marketing = await sqliteWorkspaceSource(client, { ref: { projectId: 'acme', workspaceId: 'marketing' }, files: CONTRACT_FILES });
    const sales = await sqliteWorkspaceSource(client, { ref: { projectId: 'acme', workspaceId: 'sales' }, files: CONTRACT_FILES });
    expect(sales.ref).toEqual({ projectId: 'acme', workspaceId: 'sales' });
    await marketing.write({ 'a.md': '1' }, edit(await marketing.revision(), 'person:ann'));
    expect(await sales.revision()).toBe(revisionId(new Map(Object.entries(CONTRACT_FILES))));
    expect(await sales.read('a.md')).toBeUndefined();
    expect(await sales.history()).toEqual([]);
  });

  it('refuses NUL content, which SQLite would cut short and Postgres rejects, and records nothing', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const source = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
    const base = await source.revision();
    await expect(source.write({ 'n.md': 'a\u0000b' }, edit(base, 'person:ann'))).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED' });
    expect(await source.revision()).toBe(base);
    expect(await source.history()).toEqual([]);
    expect(await countRows(client, 'file_blobs')).toBe(Object.keys(CONTRACT_FILES).length);
    await expect(sqliteWorkspaceSource(':memory:', { files: { 'n.md': '\u0000' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED' });
  });

  it('shares one connection between workspaces on one file, and leaves a shared connection open on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-db-source-'));
    try {
      const client = sqliteSqlClient(join(dir, 'ws.db'));
      const ann = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
      const bob = await sqliteWorkspaceSource(client);
      const base = await ann.revision();
      const results = await Promise.allSettled([ann.write({ 'a.md': 'ann' }, edit(base, 'person:ann')), bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      await ann.close();
      expect(await bob.history()).toHaveLength(1);
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses seed files outside the workspace, or that clash', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    await expect(sqliteWorkspaceSource(client, { files: { '../x': 'y' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
    await expect(sqliteWorkspaceSource(client, { files: { 'A.md': '1', 'a.md': '2' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
    await expect(sqliteWorkspaceSource(':memory:', { files: { '.Git/config': 'x' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
  });

  it('retries a write that lost the seq to a concurrent writer, and refuses it once the head moved', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const bob = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
    const base = await bob.revision();
    const failures: Array<() => Promise<void>> = [async () => undefined, async () => void (await bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob')))];
    const flaky: SqlClient = {
      ...client,
      async transaction(work) {
        const before = failures.shift();
        if (!before) return client.transaction(work);
        await before();
        throw uniqueViolation();
      },
    };
    const ann = await sqliteWorkspaceSource(flaky);
    await expect(ann.write({ 'b.md': 'ann' }, edit(base, 'person:ann'))).rejects.toBeInstanceOf(StaleRevisionError);
    expect((await bob.history()).map((meta) => meta.by)).toEqual(['person:bob']);
    failures.push(async () => undefined);
    const meta = await ann.write({ 'b.md': 'ann' }, edit(await ann.revision(), 'person:ann'));
    expect(meta.seq).toBe(2);
  });
});

describe('the Postgres adapter', () => {

  it('tells the pool to discard a connection whose ROLLBACK failed', async () => {
    const { pool, releases, failRollback } = fakePool();
    const client = tracked(postgresSqlClient(pool, { ownsPool: true }, () => pool.connect()));
    failRollback();
    await expect(client.transaction(async () => Promise.reject(new TypeError('boom')))).rejects.toThrow('boom');
    expect(releases.at(-1)).toBeInstanceOf(TypeError);
    expect(String(releases.at(-1))).toContain('connection terminated');
  });
});

const PG_URL = process.env.LOUSHO_TEST_PG_URL;
const PG_MODULE = 'pg';

describe.skipIf(PG_URL === undefined)('db (postgres at LOUSHO_TEST_PG_URL)', () => {
  async function newPool(): Promise<PgPool> {
    const pg = (await import(PG_MODULE)) as { default: { Pool: new (config: { connectionString?: string }) => PgPool } };
    return new pg.default.Pool({ connectionString: PG_URL });
  }

  async function make(files: Record<string, string>) {
    return tracked(await postgresWorkspaceSource(await newPool(), { files, ref: { projectId: 'lousho-test', workspaceId: randomUUID() }, ownsPool: true }));
  }

  sourceContract('db (postgres)', make);
});
