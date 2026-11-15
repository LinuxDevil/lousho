import { describe, expect, it } from 'vitest';

import { collectionKey, formatChangeValue } from '../changeValue';

describe('formatChangeValue', () => {
  it('ellipsises strings past 120 chars with a single …', () => {
    const value = formatChangeValue('a'.repeat(130));
    expect(value).toHaveLength(121);
    expect(value?.endsWith('…')).toBe(true);
  });

  it('formats numbers, booleans and null', () => {
    expect(formatChangeValue(0.7)).toBe('0.7');
    expect(formatChangeValue(false)).toBe('false');
    expect(formatChangeValue(null)).toBeNull();
  });

  it('prefers id over name and falls back through the tag fields', () => {
    expect(formatChangeValue({ builtin: 'http' })).toBe('http');
    expect(formatChangeValue({ id: 'g1', name: 'pii' })).toBe('g1');
  });
});

describe('collectionKey', () => {
  it('keys items by the same tag precedence as formatChangeValue, then JSON', () => {
    expect(collectionKey('a')).toBe('a');
    expect(collectionKey({ id: 'g1', name: 'pii' })).toBe('g1');
    expect(collectionKey({ builtin: 'http' })).toBe('http');
    expect(collectionKey({ approval: 'always' })).toBe('{"approval":"always"}');
  });
});
