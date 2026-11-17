import { describe, expect, it } from 'vitest';
import { settledOutcome } from './promptSuggestion';
import type { PromptSuggestion } from '../../shared/wireTypes';

describe('settledOutcome', () => {
  it('tells the waiting tab when there is nothing to suggest or the pass failed', () => {
    expect(settledOutcome({ ok: true, value: null })).toBe('none');
    expect(settledOutcome({ ok: false, outcome: 'failed', error: 'boom' })).toBe('failed');
    expect(settledOutcome({ ok: true, value: {} as PromptSuggestion })).toBeUndefined();
  });
});
