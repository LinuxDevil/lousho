import { describe, expect, it } from 'vitest';
import { isToolFileName } from './collectTools';

describe('isToolFileName', () => {
  it('loads source files and skips hidden files, type declarations and tests', () => {
    expect(['github.ts', 'fs.mjs'].map(isToolFileName)).toEqual([true, true]);
    expect(['._github.js', '.hidden.ts', 'types.d.ts', 'github.test.ts'].map(isToolFileName)).toEqual([false, false, false, false]);
  });
});
