import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('lousho <unknown command>', () => {
  it('suggests the closest command in one line and exits 2', () => {
    const run = spawnSync(process.execPath, ['bin/lousho.js', 'dve'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toBe("lousho: unknown command 'dve'. Did you mean 'dev'? Run 'lousho --help' to see every command.");
  });
});
