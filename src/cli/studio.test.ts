import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudio, resolveAgentForgeDir, studioUrl } from './studio';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-studio-test-'));

function makeApp(root: string, entry?: string): string {
  const appDir = path.join(root, 'apps', 'agent-forge');
  fs.mkdirSync(path.join(appDir, 'dist-server'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), '{}');
  if (entry !== undefined) fs.writeFileSync(path.join(appDir, 'dist-server', 'index.cjs'), entry);
  return appDir;
}

function waitForFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tick = (): void => {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8')) resolve(fs.readFileSync(file, 'utf8'));
      else if (Date.now() > deadline) reject(new Error('timed out waiting for ' + file));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

describe('startStudio', () => {
  it('throws a clear error when apps/agent-forge is not found under repoRoot', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-studio-test-'));
    expect(() => startStudio({ repoRoot, packageRoot: tmp() })).toThrow(/could not find apps\/agent-forge/);
  });

  it("--dev throws a clear error when apps/agent-forge/server source is missing", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-studio-test-'));
    fs.mkdirSync(path.join(repoRoot, 'apps', 'agent-forge'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'apps', 'agent-forge', 'package.json'), '{}');
    expect(() => startStudio({ repoRoot, mode: 'dev' })).toThrow(/dev mode/);
  });

  it('uses the installed package copy when repoRoot has no apps/agent-forge', () => {
    const repoRoot = tmp();
    const packageRoot = tmp();
    const appDir = makeApp(packageRoot, 'process.exit(0);');
    expect(resolveAgentForgeDir(repoRoot, packageRoot)).toBe(appDir);
    const handle = startStudio({ repoRoot, packageRoot, apiPort: 0 });
    try {
      expect(handle.mode).toBe('prod');
      expect(handle.apiProcess.spawnargs[1]).toBe(path.join(appDir, 'dist-server', 'index.cjs'));
    } finally {
      handle.stop();
    }
  });

  it('mints a per-launch token, hands it to the child and puts it in the printed URL', async () => {
    const repoRoot = tmp();
    const packageRoot = tmp();
    const out = path.join(tmp(), 'token.txt');
    makeApp(packageRoot, `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.LOUSHO_STUDIO_TOKEN);`);
    const handle = startStudio({ repoRoot, packageRoot, apiPort: 0 });
    try {
      expect(handle.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(await waitForFile(out)).toBe(handle.token);
    } finally {
      handle.stop();
    }
    expect(studioUrl('0.0.0.0', 4750, 'abc')).toBe('http://127.0.0.1:4750/?token=abc');
    expect(studioUrl('127.0.0.1', 5000, 'a+b')).toBe('http://127.0.0.1:5000/?token=a%2Bb');
  });

  // Actually spawning the real API server + Vite dev server child processes
  // (npm run server:dev / npm run dev in apps/agent-forge) is exercised
  // manually/in the real monorepo rather than here: it needs a full
  // `npm install` in apps/agent-forge and binds real ports, which would
  // make this suite slow and environment-dependent. The server's own
  // behavior (routes, run/stop/approve semantics) is covered directly by
  // apps/agent-forge/server/__tests__/*.test.ts instead - this file only
  // covers startStudio()'s own pure logic (the apps/agent-forge lookup and
  // dev/prod/auto mode resolution).
});
