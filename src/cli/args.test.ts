import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { USAGE_EXIT_CODE, exitCodeFor, parseCommand, usageError, type CommandSpec } from './args';
import { runAcp } from './acp';
import { runAdd } from './add';
import { realInitEnvironment, runInit } from './init';
import { runTraces } from './traces';
import { runBuild, parseBuildArgs } from './build';
import { parseChatArgs, runChat } from './chat';
import { parseDevArgs, runDev } from './dev';
import { parseDoctorArgs, runDoctorCommand } from './doctor';
import { parseEvalArgs, runEval } from './eval';
import { parseMcpArgs, runMcp } from './mcp';
import { parseStudioArgs, runStudio } from './studio';

afterEach(() => { vi.restoreAllMocks(); });

const SPEC: CommandSpec = {
  command: 'demo',
  usage: 'Usage: lousho demo [path] [--name n] [--tag t]... [--all]',
  positionals: 1,
  options: { name: { type: 'string' }, tag: { type: 'string', multiple: true }, all: { type: 'boolean' } },
};

describe('parseCommand', () => {

  it('rejects an unknown flag, a missing value and an extra argument with LOUSHO_CONFIG_INVALID and the usage as the hint', () => {
    for (const [args, message] of [
      [['--bogus'], /unknown option '--bogus'\./],
      [['-z'], /unknown option '-z'\./],
      [['--name'], /--name needs a value\./],
      [['--name', '--all'], /--name needs a value\./],
      [['--all=yes'], /--all does not take a value\./],
      [['a', 'b'], /unexpected argument 'b'\./],
    ] as const) {
      expect(() => parseCommand(SPEC, args)).toThrowError(message);
      try {
        parseCommand(SPEC, args);
      } catch (error) {
        expect(error).toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', hint: SPEC.usage });
        expect((error as Error).message).toMatch(/^lousho demo: /);
      }
    }
  });
});

interface Case {
  command: string;
  parse: (args: string[]) => unknown;
  /** Arguments every valid invocation needs (a path). */
  base: string[];
  /** A string flag, the key it lands on and a sample value. */
  flag?: [flag: string, key: string, value: string];
  /** Whether the command takes positionals: how many (Infinity: any). */
  positionals: number;
  run: (args: string[]) => Promise<number>;
}

const CASES: Case[] = [
  { command: 'eval', parse: parseEvalArgs, base: [], flag: ['--junit', 'junit', 'out/j.xml'], positionals: Infinity, run: (a) => runEval(a) },
  { command: 'chat', parse: parseChatArgs, base: ['a.yaml'], flag: ['--session', 'session', 's1'], positionals: 1, run: (a) => runChat(a, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) },
  { command: 'dev', parse: parseDevArgs, base: ['a.yaml'], flag: ['--host', 'host', '0.0.0.0'], positionals: 1, run: runDev },
  { command: 'build', parse: parseBuildArgs, base: [], flag: ['--target', 'target', 'stub'], positionals: 0, run: (a) => runBuild(a, { stdout: () => {}, stderr: () => {} }) },
  // --host and --port need --http (stdio has neither).
  { command: 'mcp', parse: parseMcpArgs, base: ['a.yaml', '--http'], flag: ['--host', 'host', '0.0.0.0'], positionals: 1, run: runMcp },
  { command: 'studio', parse: parseStudioArgs, base: [], flag: ['--host', 'apiHost', '0.0.0.0'], positionals: 0, run: runStudio },
  { command: 'doctor', parse: parseDoctorArgs, base: [], positionals: 1, run: (a) => runDoctorCommand(a, undefined, () => {}) },
];

describe.each(CASES)('lousho $command flag parsing', ({ command, parse, base, run }) => {
  const usage = new RegExp(`Usage: lousho ${command}`);

  it('rejects an unknown flag with LOUSHO_CONFIG_INVALID and the usage line', () => {
    for (const arg of ['--bogus', '--bogus=1', '-z']) {
      expect(() => parse([...base, arg])).toThrowError(/unknown option/);
      expect(() => parse([...base, arg])).toThrowError(usage);
      expect(() => parse([...base, arg])).toThrowError(/LOUSHO_CONFIG_INVALID/);
    }
  });

  it('exits 2 for a usage error (1 is left for a command that ran and failed)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run([...base, '--bogus'])).toBe(2);
  });

  it('prints the usage for -h and --help and exits 0 without running', async () => {
    for (const arg of ['-h', '--help']) {
      expect(parse([arg])).toMatchObject({ help: true });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await run([arg])).toBe(0);
      log.mockRestore();
    }
  });
});

describe.each(CASES.filter((c) => c.positionals < Infinity))('lousho $command extra arguments', ({ parse, base }) => {
  it('rejects an extra positional argument', () => {
    expect(() => parse([...base, 'extra-one', 'extra-two'])).toThrowError(/unexpected argument|unknown option/);
  });
});

describe.each(CASES.filter((c) => c.flag))('lousho $command flag values', ({ parse, base, flag }) => {
  it('takes a value as --flag value or --flag=value, and a repeated flag keeps the last', () => {
    const [name, key, value] = flag!;
    expect(parse([...base, name, value])).toMatchObject({ [key]: value });
    expect(parse([...base, `${name}=${value}`])).toMatchObject({ [key]: value });
    expect(parse([...base, `${name}=first`, `${name}=${value}`])).toMatchObject({ [key]: value });
  });

  it('does not let a flag without its value swallow the next flag', () => {
    const [name] = flag!;
    expect(() => parse([...base, name])).toThrowError(new RegExp(`${name} needs a value`));
    expect(() => parse([...base, name, '--bogus'])).toThrowError(new RegExp(`${name} needs a value`));
    expect(() => parse([...base, name, '-h'])).toThrowError(new RegExp(`${name} needs a value`));
  });

  it('takes a value starting with - in the = form only', () => {
    const [name, key] = flag!;
    expect(parse([...base, `${name}=-x`])).toMatchObject({ [key]: '-x' });
    expect(() => parse([...base, name, '-x'])).toThrowError(new RegExp(`${name} needs a value`));
  });
});

describe.each(CASES.filter((c) => c.positionals >= 1))('lousho $command --', ({ parse }) => {
  it('ends the flags at --', () => {
    const args = parse(['--', '--looks-like-a-flag']) as { path?: string; configPath?: string; specPath?: string; globs?: string[] };
    expect(args.path ?? args.configPath ?? args.specPath ?? args.globs?.[0]).toBe('--looks-like-a-flag');
  });
});

describe('usage errors exit 2 in every command', () => {
  const io = () => ({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });

  it('acp, add, traces and init too; the shared helper marks only usage errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runAcp(['a.yaml', '--bogus'], io())).toBe(2);
    expect(await runAdd(['--bogus'], io())).toBe(2);
    expect(await runTraces(['--limit', 'abc'])).toBe(2);
    const errors: string[] = [];
    const init = { ...realInitEnvironment(), writeError: (text: string) => void errors.push(text) };
    expect(await runInit(['--bogus'], init)).toBe(2);
    expect(errors.join('')).toContain('lousho init');
    expect(exitCodeFor(usageError({ command: 'x', usage: 'Usage: lousho x' }, 'bad'))).toBe(2);
    expect(exitCodeFor(new Error('a failure'))).toBe(1);
    expect(USAGE_EXIT_CODE).toBe(2);
  });
});

describe('lousho mcp, dev and studio ports', () => {

  it('studio rejects --prod with --dev', () => {
    expect(parseStudioArgs(['--prod']).mode).toBe('prod');
    expect(parseStudioArgs(['--dev']).mode).toBe('dev');
    expect(() => parseStudioArgs(['--prod', '--dev'])).toThrowError(/cannot be combined/);
  });
});

describe('--traces[=dir] (#282)', () => {
  it('is bare for the default directory and takes a directory only in the = form', () => {
    expect(parseChatArgs(['a.yaml']).traces).toBeUndefined();
    expect(parseChatArgs(['a.yaml', '--traces']).traces).toBe(true);
    expect(parseChatArgs(['--traces', 'a.yaml'])).toMatchObject({ path: 'a.yaml', traces: true });
    expect(parseChatArgs(['a.yaml', '--traces=./t']).traces).toBe('./t');
    expect(parseDevArgs(['a.yaml', '--traces', '--port', '4000'])).toMatchObject({ path: 'a.yaml', port: 4000, traces: true });
    expect(parseDevArgs(['a.yaml', '--traces=out/t']).traces).toBe('out/t');
    expect(parseDevArgs(['a.yaml', '--allowed-hosts', 'devbox.local, agent.test']).allowedHosts).toEqual(['devbox.local', 'agent.test']);
    expect(parseDevArgs(['a.yaml']).allowedHosts).toBeUndefined();
  });

  it('rejects an empty directory and leaves what follows -- alone', () => {
    expect(() => parseChatArgs(['a.yaml', '--traces='])).toThrowError(/LOUSHO_CONFIG_INVALID/);
    expect(() => parseDevArgs(['a.yaml', '--traces='])).toThrowError(/needs a directory/);
    expect(parseDevArgs(['--', '--traces']).path).toBe('--traces');
  });
});
