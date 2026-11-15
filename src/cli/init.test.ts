import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import prompts from 'prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, type InitEnvironment } from './init';

interface Harness {
  environment: InitEnvironment;
  out: string[];
  err: string[];
  commands: string[];
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-init-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function harness(overrides: Partial<InitEnvironment> = {}, execCode = 0): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const commands: string[] = [];
  const environment: InitEnvironment = {
    env: {},
    cwd: root,
    interactive: false,
    sdk: { version: '1.0.0-alpha.8', peerDependencies: { ai: '^4.3.19', zod: '^3.25.76' } },
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    exec: async (command, args) => {
      commands.push([command, ...args].join(' '));
      return execCode;
    },
    ...overrides,
  };
  return { environment, out, err, commands };
}

const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('runInit --yes', () => {

  it('lets --provider and --template override detection and defaults', async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    await runInit(['demo', '--yes', '--provider', 'ollama', '--template', 'yaml', '--no-install', '--no-git'], h.environment);
    expect(read('demo', 'agent.yaml')).toContain('type: ollama');
    expect(fs.existsSync(path.join(root, 'demo', 'src', 'agent.ts'))).toBe(false);
  });

  it('uses the package manager from npm_config_user_agent, or --package-manager', async () => {
    const detected = harness({ env: { npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22.19.0 linux x64' } });
    await runInit(['a', '--yes', '--no-git'], detected.environment);
    expect(detected.commands).toEqual(['pnpm install']);
    expect(detected.out.join('')).toContain('pnpm run dev');

    const forced = harness({ env: { npm_config_user_agent: 'pnpm/9.1.0' } });
    await runInit(['b', '--yes', '--no-git', '--package-manager', 'yarn'], forced.environment);
    expect(forced.commands).toEqual(['yarn install']);
  });

  it('writes a caret range of the SDK version, or a tarball with --sdk-path', async () => {
    await runInit(['plain', '--yes', '--no-install', '--no-git'], harness().environment);
    expect(JSON.parse(read('plain', 'package.json')).dependencies['lousho']).toBe('^1.0.0-alpha.8');

    const tarball = path.join(root, 'sdk-9.9.9.tgz');
    fs.writeFileSync(tarball, 'tgz');
    await runInit(['local', '--yes', '--no-install', '--no-git', '--sdk-path', tarball], harness().environment);
    expect(JSON.parse(read('local', 'package.json')).dependencies['lousho']).toBe('file:./sdk-9.9.9.tgz');
    expect(fs.existsSync(path.join(root, 'local', 'sdk-9.9.9.tgz'))).toBe(true);
    // The vendored tarball is a local build, not source: it is git-ignored.
    expect(read('local', '.gitignore')).toMatch(/^sdk-9\.9\.9\.tgz$/m);
    expect(read('plain', '.gitignore')).not.toMatch(/tgz/);
  });
});

describe('runInit guards', () => {
  it('refuses a non-empty directory, naming it and the --force escape hatch, and writes nothing', async () => {
    fs.mkdirSync(path.join(root, 'taken'));
    fs.writeFileSync(path.join(root, 'taken', 'notes.txt'), 'mine');
    const h = harness();

    expect(await runInit(['taken', '--yes'], h.environment)).toBe(1);

    expect(h.err.join('')).toMatch(/taken' is not empty.*--force/);
    expect(fs.readdirSync(path.join(root, 'taken'))).toEqual(['notes.txt']);
    expect(h.commands).toEqual([]);
  });

  it.each([
    [['--sdk-path', '/nonexistent/lousho-sdk'], /--sdk-path '\/nonexistent\/lousho-sdk' does not exist/],
  ])('rejects bad flags %j with a clear message', async (flags, message) => {
    const h = harness();
    expect(await runInit(['x', '--yes', ...flags], h.environment)).toBe(2);
    expect(h.err.join('')).toMatch(message);
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
  });

  it('prints usage for --help', async () => {
    const h = harness();
    expect(await runInit(['--help'], h.environment)).toBe(0);
    expect(h.out.join('')).toContain('Usage: lousho init');
  });

  it('reports a failed install, still prints next steps, and exits 1', async () => {
    const h = harness({}, 1);
    expect(await runInit(['demo', '--yes'], h.environment)).toBe(1);
    expect(h.err.join('')).toContain('`npm install` failed');
    expect(h.err.join('')).toContain('--sdk-path');
    expect(h.out.join('')).toContain('Next steps:');
    expect(h.out.join('')).toMatch(/\n {2}npm install\n/);
  });
});

describe('runInit interactive', () => {

  it('exits 1 when the user cancels', async () => {
    prompts.inject([new Error('cancel')]);
    const h = harness({ interactive: true });
    expect(await runInit([], h.environment)).toBe(1);
    expect(h.err.join('')).toContain('cancelled');
  });
});
