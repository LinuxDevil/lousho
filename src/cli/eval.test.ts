import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LIVE_TEST_TIMEOUT_MS,
  buildVitestConfig,
  createVitestSpawner,
  parseEvalArgs,
  resolveVitestBin,
  runEval,
  toRootRelativeGlob,
  type VitestSpawner,
} from './eval';
import type { EvalResult } from '../evals/evalResult';
import { RESULTS_ENV } from '../evals/recorder';
import { CONFIG_ENV, cassettePath } from '../evals/cassettes';
import { renderJunit, unreportedFailures } from './evalReport';

const FIXTURES = path.resolve(__dirname, '__fixtures__', 'eval');

function tempFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-eval-test-')), name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseEvalArgs', () => {

  it('reads the cassette flags; --drift-usage implies --drift and only one mode is allowed', () => {
    expect(parseEvalArgs(['--record'])).toMatchObject({ record: true });
    expect(parseEvalArgs(['--drift-usage'])).toMatchObject({ drift: true, driftUsage: true });
    expect(() => parseEvalArgs(['--record', '--replay'])).toThrow(/only one of --record, --replay and --drift/);
    expect(() => parseEvalArgs(['--replay', '--drift'])).toThrow(/only one of/);
  });
});

describe('buildVitestConfig', () => {

  it('collects only judge evals and allows the judge with --judge', () => {
    const config = buildVitestConfig({ globs: [], judge: true });
    expect(config).toContain('"**/*.judge.eval.{ts,mts,js,mjs}"');
    expect(config).toContain('"LOUSHO_ALLOW_LLM_JUDGE": "1"');
  });
});

describe('resolveVitestBin', () => {
  it('finds vitest from this project and returns undefined where it is not installed', () => {
    expect(resolveVitestBin(process.cwd())).toMatch(/vitest\.mjs$/);
    expect(resolveVitestBin(os.tmpdir())).toBeUndefined();
  });
});

function result(overrides: Partial<EvalResult>): EvalResult {
  return { name: 'e', tags: [], passed: true, assertions: [], durationMs: 5, steps: 1, toolCalls: [], ...overrides };
}

/** A fake vitest that records its invocation and appends canned results to the results file. */
function fakeVitest(results: EvalResult[], code = 0) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; config: string }[] = [];
  const spawnVitest: VitestSpawner = async (_bin, args, env) => {
    calls.push({ args, env, config: fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8') });
    fs.appendFileSync(env[RESULTS_ENV] as string, results.map((r) => `${JSON.stringify(r)}\n`).join(''));
    return code;
  };
  return { spawnVitest, calls };
}

describe('runEval with a fake vitest', () => {

  it('exits 1 (not a usage error) and prints the install command when vitest is not installed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runEval([], { resolveVitest: () => undefined, cwd: '/proj' })).toBe(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain('vitest was not found from /proj');
    expect(message).toContain('runs your *.eval.ts files through vitest');
    expect(message).toContain('npm install --save-dev vitest');
  });

  it('exits 1, not 2, when a report cannot be written after a passing run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-eval-junit-'));
    fs.writeFileSync(path.join(dir, 'afile'), '');
    const junit = path.join(dir, 'afile', 'x.xml');
    expect(await runEval(['--junit', junit], { resolveVitest: () => 'v', spawnVitest: fakeVitest([result({})]).spawnVitest, log: () => {} })).toBe(1);
    expect(error).toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says no eval files were found when vitest ran none (it exits 1 and writes no report)', async () => {
    const log = vi.fn();
    expect(await runEval([], { resolveVitest: () => 'v', spawnVitest: fakeVitest([], 1).spawnVitest, log })).toBe(1);
    expect(log.mock.calls[0][0]).toContain('lousho eval: no eval files found (looked for **/*.eval.{ts,mts,js,mjs})');
    expect(log.mock.calls[0][0]).not.toContain('1 failed');
  });

  it('says so and exits 1 when no results were recorded, naming the --tag that matched nothing', async () => {
    const log = vi.fn();
    expect(await runEval([], { resolveVitest: () => 'v', spawnVitest: fakeVitest([]).spawnVitest, log })).toBe(1);
    expect(log.mock.calls[0][0]).toContain('no eval results were recorded');
    expect(await runEval(['--tag', 'smok'], { resolveVitest: () => 'v', spawnVitest: fakeVitest([]).spawnVitest, log })).toBe(1);
    expect(log.mock.calls[1][0]).toContain('no eval results were recorded (no eval case has the tag smok)');
  });

  it('passes --judge through as the judge env var and uses the user config with --config', async () => {
    const config = tempFile('v.config.mjs');
    fs.writeFileSync(config, 'export default {};');
    const fake = fakeVitest([result({})]);
    await runEval(['--judge', '--config', config, 'only.judge.eval.ts'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fake.calls[0].env.LOUSHO_ALLOW_LLM_JUDGE).toBe('1');
    expect(fake.calls[0].args).toEqual(['run', '--config', config, '--root', process.cwd(), 'only.judge.eval.ts']);
  });
});

describe('lousho eval --observe', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('points the worker at the local daemon when LOUSHO_OBSERVE is unset or off', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', '');
    let fake = fakeVitest([result({})]);
    await runEval(['--observe'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fake.calls[0].env.LOUSHO_OBSERVE).toBe('1');

    vi.stubEnv('LOUSHO_OBSERVE', '0');
    fake = fakeVitest([result({})]);
    await runEval(['--observe'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fake.calls[0].env.LOUSHO_OBSERVE).toBe('1');
    vi.stubEnv('LOUSHO_OBSERVE', 'off');
    fake = fakeVitest([result({})]);
    await runEval(['--observe'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fake.calls[0].env.LOUSHO_OBSERVE).toBe('1');
    vi.stubEnv('LOUSHO_OBSERVE', 'banana');
    fake = fakeVitest([result({})]);
    await runEval(['--observe'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fake.calls[0].env.LOUSHO_OBSERVE).toBe('1');
  });
});

describe('lousho eval --url', () => {

  it('rejects --url with --record, --replay and --drift with a coded error', async () => {
    for (const flag of ['--record', '--replay', '--drift']) {
      expect(() => parseEvalArgs(['--url', 'https://a.test', flag])).toThrow(/cannot be combined/);
      expect(() => parseEvalArgs(['--url', 'https://a.test', flag])).toThrowError(
        expect.objectContaining({ code: 'LOUSHO_CONFIG_CONFLICTING_OPTIONS' })
      );
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runEval(['--url', 'https://a.test', '--replay'], { resolveVitest: () => 'v', log: () => {} })).toBe(2);
  });

  it('hands the URL and token to the vitest worker, turns cassettes off, and never prints the token', async () => {
    vi.stubEnv('CI', 'true');
    const fake = fakeVitest([result({})]);
    const log = vi.fn();
    await runEval(['--url', 'https://a.test', '--token', 'tok-123'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log });
    vi.unstubAllEnvs();
    expect(fake.calls[0].env).toMatchObject({ LOUSHO_EVAL_URL: 'https://a.test', LOUSHO_EVAL_TOKEN: 'tok-123', LOUSHO_EVAL_CASSETTES: '' });
    expect(log.mock.calls.join('\n')).not.toContain('tok-123');
  });
});

describe('lousho eval --record / --replay / --drift (real vitest, mockModel as the "real" provider)', () => {
  const fixture = path.join(FIXTURES, 'replay.eval.ts');
  const cassettes = path.join(FIXTURES, '__cassettes__');
  const cassette = cassettePath(fixture, 'recorded refund', 'plain');
  const quietVitest = createVitestSpawner('ignore');
  const cli = (args: string[]) => {
    const log = vi.fn();
    return runEval(args, { log, spawnVitest: quietVitest }).then((code) => ({ code, output: log.mock.calls.map((c) => String(c[0])).join('\n') }));
  };
  const clean = () => fs.rmSync(cassettes, { recursive: true, force: true });

  beforeAll(clean);
  afterAll(clean);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('--record writes one cassette per case; --replay (or a CI run) replays it with no provider call', async () => {
    expect((await cli([fixture, '--record'])).code).toBe(0);
    expect((JSON.parse(fs.readFileSync(cassette, 'utf8')) as { entries: unknown[] }).entries).toHaveLength(2);

    vi.stubEnv('FIXTURE_PROVIDER', 'offline');
    const json = tempFile('results.json');
    expect((await cli([fixture, '--replay', '--json', json])).code).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(json, 'utf8')) as { results: EvalResult[] };
    expect(parsed.results[0]).toMatchObject({ passed: true, cassettes: [cassette], toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }] });

    vi.stubEnv('CI', 'true');
    expect((await cli([fixture])).code).toBe(0);
    // A plain local run keeps today's behaviour: live, so the offline provider fails it.
    vi.stubEnv('CI', '');
    expect((await cli([fixture])).code).toBe(1);
  }, 120_000);

  it('--drift reports a per-case diff table and JUnit entries, failing only with --strict', async () => {
    const same = await cli([fixture, '--drift']);
    expect(same.code).toBe(0);
    expect(same.output).toContain('Drift: none');

    vi.stubEnv('FIXTURE_ORDER_ID', '43');
    const junit = tempFile('junit.xml');
    const drifted = await cli([fixture, '--drift', '--junit', junit]);
    expect(drifted.code).toBe(0);
    expect(drifted.output).toMatch(/recorded refund\s+plain\s+args\s+lookup_order \{"orderId":"42"\}\s+lookup_order \{"orderId":"43"\}/);
    expect(fs.readFileSync(junit, 'utf8')).toContain(`<system-out>soft failure: drift from ${path.basename(cassette)}: args lookup_order`);
    expect(fs.readFileSync(cassette, 'utf8')).toContain('\\"orderId\\":\\"42\\"');

    const strict = await cli([fixture, '--drift', '--strict', '--junit', junit]);
    expect(strict.code).toBe(1);
    expect(fs.readFileSync(junit, 'utf8')).toContain(`<failure message="drift from ${path.basename(cassette)}: args lookup_order`);
  }, 120_000);
});

describe('lousho eval time limits', () => {
  it('parses --timeout as whole milliseconds, 0 meaning no limit', () => {
    expect(parseEvalArgs(['--timeout', '120000'])).toMatchObject({ timeout: 120_000 });
    expect(parseEvalArgs(['--timeout=0'])).toMatchObject({ timeout: 0 });
    expect(() => parseEvalArgs(['--timeout', '2m'])).toThrow(/--timeout must be a whole number of milliseconds/);
  });

  it('gives live, --record and --drift runs a long default; --replay keeps vitest default; --timeout wins', () => {
    expect(buildVitestConfig({ globs: [], judge: false })).toContain(`"testTimeout": ${LIVE_TEST_TIMEOUT_MS}`);
    expect(buildVitestConfig({ globs: [], judge: false, replay: true })).not.toContain('testTimeout');
    expect(buildVitestConfig({ globs: [], judge: false, replay: true, timeout: 30_000 })).toContain('"testTimeout": 30000');
  });

  it("keeps a --config's own testTimeout unless --timeout is given, and tells the worker the config for hints", async () => {
    const config = tempFile('v.config.mjs');
    fs.writeFileSync(config, 'export default {};');
    const fake = fakeVitest([result({})]);
    await runEval(['--config', config], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    await runEval(['--config', config, '--timeout', '90000', '--record'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fake.calls[0].args.some((a) => a.startsWith('--testTimeout'))).toBe(false);
    expect(fake.calls[1].args).toContain('--testTimeout=90000');
    expect(fake.calls[1].env[CONFIG_ENV]).toBe(toRootRelativeGlob(config, process.cwd()));
  });
});

describe('unreportedFailures', () => {
  const options = { cwd: path.resolve('proj'), strict: false };
  const file = (name: string) => path.join(options.cwd, name);

  it('adds an error per vitest-failed file no eval case reported, naming the load error or failing tests', () => {
    const report = {
      testResults: [
        { name: file('broken.eval.ts'), status: 'failed', message: 'fixture failed to load', assertionResults: [] },
        { name: file('plain.eval.ts'), status: 'failed', message: '', assertionResults: [{ fullName: 'raw test', status: 'failed', failureMessages: ['boom'] }] },
        { name: file('reported.eval.ts'), status: 'failed', message: '', assertionResults: [] },
        { name: file('ok.eval.ts'), status: 'passed', assertionResults: [] },
      ],
    };
    const failed = result({ passed: false, file: file('reported.eval.ts'), error: 'x' });
    const extra = unreportedFailures([failed], report, 1, options);
    expect(extra.map((r) => [r.name, r.case, r.error])).toEqual([
      ['vitest', 'broken.eval.ts', 'fixture failed to load'],
      ['vitest', 'plain.eval.ts', 'raw test: boom'],
    ]);
    expect(renderJunit(extra, false)).toContain('<error message="fixture failed to load" type="EvalError">');
  });

  it('fails a case vitest failed after it recorded a pass (a late timeout) instead of adding a vitest row', () => {
    const timedOut = { status: 'failed', failureMessages: ['Error: Test timed out in 1ms.'] };
    const report = {
      testResults: [
        {
          name: file('refund.eval.ts'),
          status: 'failed',
          message: '',
          assertionResults: [
            { ...timedOut, title: 'refund flow', fullName: 'refund flow' },
            { ...timedOut, title: 'cases [b]', fullName: 'suite cases [b]' },
            { status: 'passed', title: 'cases [a]' },
            { ...timedOut, title: 'repeated' },
          ],
        },
      ],
    };
    const results = [
      result({ name: 'refund flow', file: file('refund.eval.ts') }),
      result({ name: 'cases', case: 'a', file: file('refund.eval.ts') }),
      result({ name: 'cases', case: 'b', file: file('refund.eval.ts') }),
      result({ name: 'repeated', case: 'repeated #1', file: file('refund.eval.ts') }),
      result({ name: 'refund flow', file: file('other.eval.ts') }),
    ];
    expect(unreportedFailures(results, report, 1, options)).toEqual([]);
    expect(results.map((r) => r.passed)).toEqual([false, true, false, false, true]);
    expect(results[0]?.error).toMatch(/^Error: Test timed out in 1ms\. Raise the limit with defineEval/);
  });
});
