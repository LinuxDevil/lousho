import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit } from './audit';
import { cooldownEnds, readCycles, writeCycle, type HealCycle } from './cycles';

let dir: string;

const cycle = (id: string, over: Partial<HealCycle> = {}): HealCycle => ({ id, trigger: 'failures', approval: 'auto', outcome: 'applied', reason: 'Applied.', startedAt: new Date().toISOString(), tokens: 100, ...over });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-cycles-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cycle records', () => {

  it('round-trips newest first, replaces a cycle saved twice, and skips broken files', () => {
    writeCycle(dir, cycle('20261109T080000Z-aaaaaa', { outcome: 'interrupted' }));
    writeCycle(dir, cycle('20261109T090000Z-bbbbbb'));
    writeCycle(dir, cycle('20261109T080000Z-aaaaaa', { outcome: 'pending' }));
    writeFileSync(path.join(dir, '.lousho', 'cycles', '20261109T100000Z-cccccc.json'), '{ broken');
    writeFileSync(path.join(dir, '.lousho', 'cycles', 'notes.json'), '{}');
    expect(readCycles(dir).map((item) => [item.id, item.outcome])).toEqual([
      ['20261109T090000Z-bbbbbb', 'applied'],
      ['20261109T080000Z-aaaaaa', 'pending'],
    ]);
    expect(() => writeCycle(dir, cycle('../escape'))).toThrow(/not a cycle id/);
  });

  it('refuses a symlinked cycles folder', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'lousho-elsewhere-'));
    mkdirSync(path.join(dir, '.lousho'));
    symlinkSync(elsewhere, path.join(dir, '.lousho', 'cycles'));
    expect(() => readCycles(dir)).toThrow(/symlink/);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('budgets, cooldown and the kill switch', () => {

  it('a rollback starts a cooldown that ends after the set hours', async () => {
    const now = Date.now();
    expect(cooldownEnds(dir, 24, now)).toBeUndefined();
    await appendAudit(dir, { actor: 'guard', action: 'rollback', reason: 'Regressed.' });
    expect(cooldownEnds(dir, 24, now)).toBeGreaterThan(now + 23 * 3_600_000);
    expect(cooldownEnds(dir, 24, now + 25 * 3_600_000)).toBeUndefined();
    expect(cooldownEnds(dir, 0, now + 1000)).toBeUndefined();
  });
});
