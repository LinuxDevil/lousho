import { describe, expect, it } from 'vitest';
import { InitUsageError, parseInitArgs } from './options';

describe('parseInitArgs', () => {

  it('rejects unknown flags and more than one directory', () => {
    expect(() => parseInitArgs(['--bogus'], {})).toThrow(InitUsageError);
    expect(() => parseInitArgs(['--bogus'], {})).toThrow(/--bogus/);
    expect(() => parseInitArgs(['a', 'b'], {})).toThrow(/at most one directory/);
  });
});
