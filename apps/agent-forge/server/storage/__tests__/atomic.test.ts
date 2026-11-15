import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic, withAgentLock } from '../atomic';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d01-atomic-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects after 5 rename attempts and removes the .tmp file', async () => {
    const spy = vi.spyOn(fsPromises, 'rename');
    spy.mockRejectedValue(withCode('denied', 'EACCES'));

    const target = path.join(dir, 'denied.txt');
    await expect(writeFileAtomic(target, 'data')).rejects.toMatchObject({ code: 'EACCES' });

    expect(spy).toHaveBeenCalledTimes(5);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('withAgentLock', () => {

  it('allows nesting under a different id', async () => {
    await expect(withAgentLock('a', () => withAgentLock('b', async () => 'ok'))).resolves.toBe('ok');
  });
});
