import { describe, expect, it } from 'vitest';
import { canaryReplay } from './canary';
import type { Harness, ProbeRun } from './types';

const base: Harness = { instructions: 'base', skills: {} };
const candidate: Harness = { instructions: 'candidate', skills: {} };

type Outcomes = Record<string, (boolean | null)[]>;

function probeFrom(outcomes: { base?: Outcomes; candidate: Outcomes }) {
  const calls: { harness: string; caseId: string; repeat: number }[] = [];
  const probe = async (harness: Harness, caseId: string, repeat: number): Promise<ProbeRun> => {
    calls.push({ harness: harness.instructions, caseId, repeat });
    const table = harness === candidate ? outcomes.candidate : (outcomes.base ?? {});
    const results = table[caseId] ?? [];
    const passed = results[(repeat - 100) % Math.max(results.length, 1)] ?? null;
    return { passed, transcript: '', tokens: 1, ended: 'stop' };
  };
  return { probe, calls };
}

const T = true;
const F = false;
const N = null;

describe('canaryReplay', () => {

  it('fails a training case below 5/6', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, F, F] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: [], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/fix/);
  });

  it('fails a protected case 2 below a base that also misses the bar', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], flaky: [T, T, F, F, F, F] }, base: { flaky: [T, T, T, T, F, F] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['flaky'], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/flaky/);
  });

  it('does not run the base on a protected case with too few scored runs', async () => {
    const { probe, calls } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], keep: [T, F, N, N, N, N] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/too few scored runs on keep/i);
    expect(calls.some((call) => call.harness === 'base')).toBe(false);
  });

  it('gives one sentence per case reason', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, N, N, N], keep: [T, T, T, T, F, F], ok: [T, T, T, T, T, T] }, base: { keep: [T, T, T, T, T, T] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep', 'ok'], probe });
    for (const verdict of result.cases) {
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0]).toMatch(/^[^.]+\.$/);
    }
    expect(result.reason).toMatch(/^[^.]+\.$/);
  });
});
