import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from './fileLock';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const lockIn = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lousho-file-lock-'));
  dirs.push(dir);
  return path.join(dir, 'x.json.lock');
};

describe('withFileLock', () => {

  it('takes over a stale lock for one writer only: concurrent writers that all saw it stale never hold the lock together', async () => {
    const lock = await lockIn();
    for (let trial = 0; trial < 10; trial++) {
      await writeFile(lock, 'crashed');
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      let running = 0;
      let most = 0;
      const task = async () => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
      };
      await Promise.all(Array.from({ length: 8 }, () => withFileLock(lock, task, { staleMs: 1_000 })));
      expect(most).toBe(1);
    }
  }, 30_000);
});
