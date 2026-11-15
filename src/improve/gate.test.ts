import { describe, expect, it } from 'vitest';
import type { LabelledRun } from './evidence';
import { caseCount, judgeHoldoutCase, judgePooledHoldout, judgeTrainingCase, MIN_CASE_GAIN, trainingFailure, type JudgedCase } from './gate';
import type { CaseCount } from './types';

const runs = (caseId: string, results: (boolean | null)[]): LabelledRun[] =>
  results.map((passed, repeat) => ({ label: 'x', caseId, repeat, run: { passed, transcript: '', tokens: 10, ended: 'stop' } }));

const T = true;
const F = false;

const judged = (caseId: string, base: (boolean | null)[], final: (boolean | null)[]): JudgedCase =>
  judgeTrainingCase(caseId, caseCount(runs(caseId, base), caseId), caseCount(runs(caseId, final), caseId));

describe('judgeTrainingCase', () => {
  it.each([
    { base: [F, null, null], final: [T, null, null], improved: false, dropped: false, scorable: true, reason: /too few scored runs/i },
  ])('judges $base to $final', ({ base, final, improved, dropped, scorable, reason }) => {
    const result = judged('c', base, final);
    expect(result).toMatchObject({ improved, dropped, scorable });
    expect(result.verdict.caseId).toBe('c');
    expect(result.verdict.role).toBe('training');
    expect(result.verdict.reasons).toHaveLength(1);
    expect(result.verdict.reasons[0]).toMatch(reason);
  });

  it('counts a gain of exactly MIN_CASE_GAIN, and nothing below it', () => {
    const gain = (base: CaseCount, final: CaseCount) => judgeTrainingCase('c', base, final).improved;
    expect(MIN_CASE_GAIN).toBe(2 / 3);
    expect(gain({ passed: 1, scored: 3 }, { passed: 3, scored: 3 })).toBe(true);
    expect(gain({ passed: 1, scored: 6 }, { passed: 5, scored: 6 })).toBe(true);
    expect(gain({ passed: 0, scored: 1000 }, { passed: 666, scored: 1000 })).toBe(false);
  });
});

describe('trainingFailure', () => {
  it.each([
    { name: 'one improved and one dropped', cases: [judged('a', [F, F, F], [T, T, T]), judged('b', [T, T, T], [T, T, F])], expected: /got worse \(b\)/ },
  ])('$name', ({ cases, expected }) => {
    const failure = trainingFailure(cases);
    if (expected === undefined) expect(failure).toBeUndefined();
    else expect(failure).toMatch(expected);
  });

  it('never accepts a no-op on a training case', () => {
    const values = [true, false, null] as const;
    const patterns = values.flatMap((a) => values.flatMap((b) => values.map((c) => [a, b, c])));
    expect(patterns).toHaveLength(27);
    for (const pattern of patterns) {
      const count = caseCount(runs('c', pattern), 'c');
      expect(trainingFailure([judgeTrainingCase('c', count, count)])).toBeDefined();
    }
  });
});

const count = (ratio: string): CaseCount => {
  const [passed, scored] = ratio.split('/').map(Number);
  return { passed, scored };
};

describe('judgeHoldoutCase', () => {
  it.each([
    { base: '0/0', final: '3/3', needsRerun: false, reason: /could not be scored/i },
  ])('judges $base to $final', ({ base, final, needsRerun, reason }) => {
    const result = judgeHoldoutCase('h', count(base), count(final));
    expect(result.needsRerun).toBe(needsRerun);
    expect(result.verdict).toMatchObject({ caseId: 'h', role: 'holdout', base: count(base), final: count(final) });
    expect(result.verdict.reasons).toHaveLength(1);
    expect(result.verdict.reasons[0]).toMatch(reason);
  });
});

describe('judgePooledHoldout', () => {
  it.each([
    { base: '6/6', final: '0/0', regressed: false, reason: /could not be scored/i },
  ])('judges pooled $base to $final', ({ base, final, regressed, reason }) => {
    const first = judgeHoldoutCase('h', count('3/3'), count('2/3')).verdict;
    const result = judgePooledHoldout('h', count(base), count(final), 3, first);
    expect(result.regressed).toBe(regressed);
    expect(result.verdict).toMatchObject({ caseId: 'h', role: 'holdout', base: count(base), final: count(final) });
    expect(result.verdict.reasons).toEqual([first.reasons[0], expect.stringMatching(reason)]);
  });
});
