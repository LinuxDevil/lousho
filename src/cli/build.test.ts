import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBuild, stubAdapter, stubAdapterCalls, BuildIO } from './build';
import { registerAdapter } from '../deploy';
import { missingProviderPeerWarning } from './buildPeers';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function captureIO(): BuildIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

describe('runBuild', () => {
  beforeAll(() => {
    registerAdapter('stub', stubAdapter);
  });
  beforeEach(() => {
    stubAdapterCalls.length = 0;
  });

  it('warns when --out names a directory that is not empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-build-out-'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    const io = captureIO();
    expect(await runBuild(['--target=stub', '--agent=agent.yaml', `--out=${dir}`], io)).toBe(0);
    expect(io.err.join('\n')).toMatch(/^Warning: --out .* is not empty/);
  });

  it('exits 2 (usage error) with "unknown target" on stderr for an unregistered target', async () => {
    const io = captureIO();
    const code = await runBuild(['--target=doesnotexist'], io);

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('lousho build: unknown target "doesnotexist"');
    expect(stubAdapterCalls).toEqual([]);
  });

  it('exits 2 (usage error) when --target or the agent path is missing, or a flag is unknown', async () => {
    const io = captureIO();
    expect(await runBuild([], io)).toBe(2);
    expect(io.err.join('\n')).toContain('--target is required');
    expect(await runBuild(['--target=stub', '--bogus'], captureIO())).toBe(2);
    const noAgent = captureIO();
    expect(await runBuild(['--target=stub'], noAgent)).toBe(2);
    expect(noAgent.err.join('\n')).toMatch(/^lousho build: an agent path is required.\n\[LOUSHO_CONFIG_INVALID\] Usage: lousho build/);
    expect(stubAdapterCalls).toEqual([]);
  });

  it("warns when the provider package of the spec's provider is not installed, and builds anyway", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-build-peer-'));
    const spec = path.join(dir, 'agent.yaml');
    fs.writeFileSync(spec, 'name: a\nprompt: p\nprovider:\n  type: openai\n  model: gpt-4o-mini\n');
    const io = { ...captureIO(), resolveFrom: dir };
    expect(await runBuild(['--target=stub', `--agent=${spec}`], io)).toBe(0);
    expect(io.err.join('\n')).toMatch(/'openai' provider, but its package @ai-sdk\/openai is not installed[\s\S]*npm install @ai-sdk\/openai@/);

    // An agent directory's agent.json model prefix counts too; with the package installed there is no warning.
    const agentDir = path.join(dir, 'agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({ model: 'anthropic/claude-x' }));
    const missing = { ...captureIO(), resolveFrom: dir };
    await runBuild(['--target=stub', `--agent=${agentDir}`], missing);
    expect(missing.err.join('\n')).toContain('@ai-sdk/anthropic is not installed');
    const installed = { ...captureIO(), resolveFrom: REPO_ROOT };
    await runBuild(['--target=stub', `--agent=${agentDir}`], installed);
    expect(installed.err).toEqual([]);

    // The mock provider needs no package.
    fs.writeFileSync(spec, 'name: a\nprompt: p\nprovider:\n  type: mock\n  model: m\n');
    const mock = { ...captureIO(), resolveFrom: dir };
    await runBuild(['--target=stub', `--agent=${spec}`], mock);
    expect(mock.err).toEqual([]);
  });

  it('words the peer warning for the target: node-server and docker builds list the package in their package.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-build-peer-'));
    const spec = path.join(dir, 'agent.yaml');
    fs.writeFileSync(spec, 'name: a\nprompt: p\nprovider:\n  type: openai\n  model: gpt-4o-mini\n');
    const worker = missingProviderPeerWarning(spec, dir, 'cloudflare-worker');
    expect(worker).toMatch(/would fail every request[\s\S]*Install it before building/);
    const server = missingProviderPeerWarning(spec, dir, 'node-server');
    expect(server).toContain("The build's package.json lists it");
    expect(server).toContain('run `npm install` in the build folder before `node dist/server.js`');
    expect(server).not.toContain('would fail every request');
    expect(missingProviderPeerWarning(spec, dir, 'docker')).toContain('the Docker image installs it');
  });
});
