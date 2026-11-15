import { describe, it, expect } from 'vitest';
import { comparePassRate } from '../compare';
import { isVerbatimEvidence } from '../judge';

describe('comparePassRate', () => {

  it('passes with no baseline to compare against', () => {
    const outcome = comparePassRate(0.5, undefined);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('no baseline');
  });
});

describe('isVerbatimEvidence', () => {
  const sources = ['Use the secure card to share your GitHub token.', 'proposeAgent({"draft":{"name":"Support triage"}})'];

  it('rejects quotes shorter than 8 characters and non-strings', () => {
    expect(isVerbatimEvidence('card to', sources)).toBe(false);
    expect(isVerbatimEvidence(42, sources)).toBe(false);
    expect(isVerbatimEvidence(undefined, sources)).toBe(false);
  });
});
