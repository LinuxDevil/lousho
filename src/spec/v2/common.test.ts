import { describe, it, expect } from 'vitest';
import { isSafeRelativePath,  } from './common';

describe('isSafeRelativePath', () => {
  it.each([
    ['../a.md', false],
    ['a/../../b', false],
  ])('%j -> %s', (rel, expected) => {
    expect(isSafeRelativePath(rel)).toBe(expected);
  });
});
