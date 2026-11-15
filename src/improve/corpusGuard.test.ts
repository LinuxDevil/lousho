import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal } from './apply';
import { readAudit } from './audit';
import { addToCorpus, type CorpusCase } from './corpus';
import { guardCorpus } from './corpusGuard';
import { readAgentHarness } from './revisions';
import type { Harness, ImproveResult, ProbeRun } from './types';

let dir: string;

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });
const run = (passed: boolean | null): ProbeRun => ({ passed, transcript: '', tokens: 5, ended: 'final' });
const item = (id: string, baseline = { passed: 6, scored: 6 }): CorpusCase => ({ id, traceId: `t-${id}`, input: id, addedAt: '2026-11-01T00:00:00Z', revision: 'a'.repeat(64), origin: 'protected', baseline });

type Script = (harness: Harness, caseId: string, repeat: number) => boolean | null;

const probeOf = (script: Script) => {
  const calls: { caseId: string; repeat: number }[] = [];
  const probe = async (harness: Harness, caseId: string, repeat: number): Promise<ProbeRun> => {
    calls.push({ caseId, repeat });
    return run(script(harness, caseId, repeat));
  };
  return { probe, calls };
};

async function apply(instructions: string): Promise<{ from: string; to: string }> {
  const base = readAgentHarness(dir);
  return applyProposal(dir, { result: proposal({ ...base, instructions }), base }, { mode: 'auto', by: 'gate' });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-guard-'));
  writeFileSync(path.join(dir, 'instructions.md'), 'Be careful.\n');
  await addToCorpus(dir, [item('a'), item('b')], 30);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('guardCorpus', () => {

  it('one pooled regression rolls back to the last guard-pass revision', async () => {
    const good = await apply('Good.');
    const { probe: passing } = probeOf(() => true);
    await guardCorpus(dir, { probe: passing, runs: 3, rollback: true });
    await apply('Bad.');
    const { probe } = probeOf((harness, caseId) => !(harness.instructions.startsWith('Bad') && caseId === 'a'));
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result).toMatchObject({ passed: false, rolledBackTo: good.to, runs: 15 });
    expect(result.cases.find((c) => c.caseId === 'a')).toMatchObject({ class: 'regressed', final: { passed: 0, scored: 6 } });
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Good.\n');
    expect(readAudit(dir).slice(-2).map((entry) => [entry.action, entry.actor])).toEqual([
      ['guard-fail', 'guard'],
      ['rollback', 'guard'],
    ]);
  });

  it('a single noisy drop that recovers on rerun passes', async () => {
    const { probe } = probeOf((_harness, caseId, repeat) => !(caseId === 'a' && repeat === 200));
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result.passed).toBe(true);
    expect(result.cases[0]).toMatchObject({ class: 'unchanged', final: { passed: 5, scored: 6 } });
    expect(result.runs).toBe(9);
  });

  it('does not roll back over a change that landed during the guard', async () => {
    await apply('Bad.');
    let landed = false;
    const probe = async (harness: Harness): Promise<ProbeRun> => {
      if (!landed) {
        landed = true;
        await apply('Fixed by hand meanwhile.');
      }
      return run(!harness.instructions.startsWith('Bad'));
    };
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/rollback was refused/) });
    expect(result.rolledBackTo).toBeUndefined();
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Fixed by hand meanwhile.\n');
  });

  it('refuses too few runs or a bad first repeat', async () => {
    const { probe } = probeOf(() => true);
    await expect(guardCorpus(dir, { probe, runs: 1, rollback: true })).rejects.toThrow(/runs/);
    await expect(guardCorpus(dir, { probe, runs: 3, firstRepeat: -1, rollback: true })).rejects.toThrow(/firstRepeat/);
  });
});

