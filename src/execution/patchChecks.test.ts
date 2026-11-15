import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runPatchCheckSafely,
  ProposedPatch,
  createDiffSizeCheck,
  secretScanCheck,
  createCommandCheck,
  createTestRunCheck,
  createLintCheck,
  runPatchChecks,
} from './patchChecks';
import { SECRET_PATTERNS } from './secretPatterns';

describe('createDiffSizeCheck', () => {
  it('rejects a diff with N+1 lines against an N-line threshold', async () => {
    const check = createDiffSizeCheck(5);
    const diff = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');

    const result = await check.check({ diff });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('5');
  });
});

describe('secretScanCheck', () => {

  it('never puts the matched secret in the reason: only the pattern label', async () => {
    // One fake secret per SECRET_PATTERNS entry. The rejection reason (and
    // the failure runPatchChecks() reports from it) names the label only -
    // embedding the matched text would copy the secret into events, traces
    // and logs.
    const secrets = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'sk-FakeTestKey1234567890AbCdEfGh',
      'AKIA0123456789ABCDEF',
    ];
    for (const secret of secrets) {
      const diff = `+const key = "${secret}";\n`;
      const matched = SECRET_PATTERNS.map(({ pattern }) => diff.match(pattern)?.[0]).find(Boolean);
      expect(matched).toBe(secret);

      const result = await secretScanCheck.check({ diff });
      expect(result.pass).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).not.toContain(secret);

      const aggregated = await runPatchChecks({ diff }, [secretScanCheck]);
      expect(aggregated.pass).toBe(false);
      for (const failure of aggregated.failures) {
        expect(failure.reason ?? '').not.toContain(secret);
      }
    }
  });
});

describe('command patch checks', () => {
  const fixtureRepo = path.join(__dirname, '__fixtures__', 'sample-repo');
  let scratchDir: string;
  const dummyPatch: ProposedPatch = { diff: '' };

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-checks-fixture-'));
    fs.cpSync(fixtureRepo, scratchDir, { recursive: true });
  });

  afterEach(async () => {
    // The timeout test's child is killed by a taskkill nobody waits for; on
    // Windows its working directory stays locked (EPERM) until it exits.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 50) throw error;
        await new Promise((done) => setTimeout(done, 200));
      }
    }
  }, 15_000);

  it('createLintCheck passes against the unmutated fixture repo', async () => {
    const check = createLintCheck(scratchDir);
    const result = await check.check(dummyPatch);
    expect(result.pass).toBe(true);
  }, 30000);

  it('kills the underlying child process on timeout instead of leaking it', async () => {
    // A long-sleeping child that writes its own PID to a file as soon as
    // it starts, so the test can check afterwards whether that PID is
    // still alive - proving the process was actually terminated, not just
    // abandoned by the outer race. Run from a script file (rather than
    // `node -e "..."` inline) so this doesn't depend on shell-quoting
    // behavior for paths/quotes on Windows.
    const pidFile = path.join(scratchDir, 'child.pid');
    const scriptFile = path.join(scratchDir, 'sleeper.js');
    fs.writeFileSync(
      scriptFile,
      "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 5000);"
    );

    const slowCheck = createCommandCheck(
      'leak-check-command',
      scratchDir,
      'node',
      [scriptFile, pidFile],
      // Long enough for a cold `node` to start and write its pid on a busy runner.
      { timeoutMs: 1500 }
    );

    const result = await runPatchCheckSafely(slowCheck, dummyPatch, 1500);
    expect(result.pass).toBe(false);

    // Give the OS a moment to actually finish tearing the process down
    // after it was signaled (taskkill on Windows, in particular, isn't
    // instantaneous).
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 10000);

  it('applies action.diff to a scratch copy and evaluates the patched result, without mutating the fixture', async () => {
    // A small valid unified diff against the pristine fixture repo that
    // breaks the one existing test when applied.
    const diff = [
      'diff --git a/test/sample.test.js b/test/sample.test.js',
      'index 0000000..1111111 100644',
      '--- a/test/sample.test.js',
      '+++ b/test/sample.test.js',
      '@@ -1,7 +1,7 @@',
      " const test = require('node:test');",
      " const assert = require('node:assert');",
      " const { add } = require('../src/index');",
      ' ',
      " test('add() sums two numbers', () => {",
      '-  assert.strictEqual(add(2, 3), 5);',
      '+  assert.strictEqual(add(2, 3), 999);',
      ' });',
      '',
    ].join('\n');

    const originalFixtureContent = fs.readFileSync(
      path.join(fixtureRepo, 'test', 'sample.test.js'),
      'utf-8'
    );

    // Passed directly against the pristine, checked-in fixture (not the
    // beforeEach-created scratchDir) - createCommandCheck must make
    // its own internal copy to apply the diff into, never touching this.
    const check = createTestRunCheck(fixtureRepo);
    const result = await check.check({ diff });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('test-run');

    // The checked-in fixture must remain byte-for-byte unmutated.
    const afterFixtureContent = fs.readFileSync(
      path.join(fixtureRepo, 'test', 'sample.test.js'),
      'utf-8'
    );
    expect(afterFixtureContent).toBe(originalFixtureContent);
  }, 30000);

  it('rejects a diff that does not apply cleanly with a clear reason', async () => {
    const badDiff = [
      'diff --git a/test/sample.test.js b/test/sample.test.js',
      'index 0000000..1111111 100644',
      '--- a/test/sample.test.js',
      '+++ b/test/sample.test.js',
      '@@ -1,3 +1,3 @@',
      ' this context line does not exist in the real file',
      '-neither does this one',
      '+nor this replacement',
      '',
    ].join('\n');

    const check = createTestRunCheck(scratchDir);
    const result = await check.check({ diff: badDiff });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('does not apply cleanly');
  }, 30000);
});
