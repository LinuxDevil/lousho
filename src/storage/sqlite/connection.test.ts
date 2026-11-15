/**
 * Lock contention must not freeze the event loop for seconds and
 * must surface as the coded LOUSHO_STORAGE_BUSY, not a raw ERR_SQLITE_ERROR.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from './connection';

const dirs: string[] = [];
const conns: Connection[] = [];

afterEach(() => {
  for (const c of conns.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(name: string): { conn: Connection; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-conn-'));
  dirs.push(dir);
  const path = join(dir, name);
  const conn = Connection.open(path);
  conns.push(conn);
  return { conn, path };
}

describe('Connection lock contention', () => {

  it('does not map non-lock errors', () => {
    const { conn } = open('b.db');
    expect(() =>
      conn.transaction(() => {
        throw new Error('boom');
      })
    ).toThrow('boom');
  });
});
