/**
 * `runDeploy` feeds `lousho build` a spec-v1 file, not the v2 working copy:
 * the deploy adapters still parse `--agent=` with the v1 `loadSpec`, which
 * rejects a v2 file outright, so runDeploy writes the stored v2 spec through
 * `toLegacySpec` into a derived `.lousho/build/<agentId>.v1.yaml` first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});
import { spawn } from 'node:child_process';
import { runDeploy } from '../deployRunner';

describe('runDeploy', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-deploy-test-'));
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new EventEmitter() as ChildProcess['stdout'];
      child.stderr = new EventEmitter() as ChildProcess['stderr'];
      process.nextTick(() => child.emit('close', 0));
      // The temp file the facade writes must still exist at spawn time.
      const agentArg = (args as string[]).find((a) => a.startsWith('--agent='));
      expect(agentArg).toBeDefined();
      return child;
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });

  it('reports a failing result without spawning when the agent was never saved', async () => {
    const result = await runDeploy(baseDir, 'ghost', 'node-server');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ghost');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
