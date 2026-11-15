import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildEnvironment, runDoctorCommand, toolNames } from './doctor';
import { satisfiesRange } from './versionRange';

describe('satisfiesRange', () => {
  it.each([
    ['1.0.0', '*', true],
  ])('%s vs %s -> %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});

describe('real environment', () => {

  it('finds commands by path and on PATH', () => {
    const env = buildEnvironment({ json: false });
    expect(env.commandExists(process.execPath)).toBe(true);
    expect(env.commandExists('node')).toBe(true);
    expect(env.commandExists('definitely-not-a-command-xyz')).toBe(false);
  });

  it('loads a spec file with its validated mcpServers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-doctor-'));
    fs.writeFileSync(
      path.join(dir, 'a.yaml'),
      'name: bot\nprompt: hi\nprovider:\n  type: mock\n  model: m\nmcpServers:\n  fs:\n    command: npx\n'
    );
    const env = buildEnvironment({ json: false, specPath: 'a.yaml' }, dir);
    expect(env.specPath).toBe(path.join(dir, 'a.yaml'));
    expect(env.loadSpec(env.specPath as string).name).toBe('bot');
    expect(env.loadSpec(env.specPath as string).mcpServers).toEqual({ fs: { command: 'npx' } });
    expect(env.resolveTool('http')).toBeTruthy();
    expect(() => env.resolveTool('nope')).toThrow();
  });
});

describe('runDoctorCommand', () => {
  it('prints text and returns the exit code; --json prints JSON', async () => {
    const env = buildEnvironment({ json: false });
    const fakeEnv = {
      ...env,
      nodeVersion: '1.0.0',
      dockerReachable: async () => false,
      fetch: async () => ({ ok: true, status: 200 }),
    };
    const out: string[] = [];
    expect(await runDoctorCommand([], fakeEnv, (t) => out.push(t))).toBe(1);
    expect(out[0]).toContain('[FAIL] Node.js');

    const json: string[] = [];
    await runDoctorCommand(['--json'], fakeEnv, (t) => json.push(t));
    expect(JSON.parse(json[0]).exitCode).toBe(1);
  });
});

describe('toolNames', () => {
  it('collects names from tools, nested arrays and records; none for a function or a nameless value', () => {
    expect(toolNames([{ name: 'a' }, [{ name: 'b' }], { group: { name: 'c' }, other: [{ name: 'd' }] }])).toEqual(['a', 'b', 'c', 'd']);
    expect(toolNames(() => [])).toEqual([]);
    expect(toolNames(null)).toEqual([]);
    expect(toolNames({ name: 42 })).toEqual([]);
  });
});
