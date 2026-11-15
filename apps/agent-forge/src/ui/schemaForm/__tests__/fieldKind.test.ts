import { describe, expect, it } from 'vitest';

import { fieldKind } from '../fieldKind';

describe('fieldKind', () => {

  it('strips null from a type array and falls back to json for real unions', () => {
    expect(fieldKind({ type: ['string', 'null'] })).toBe('string');
    expect(fieldKind({ type: ['string', 'number'] })).toBe('json');
  });

  it('honours x-widget secret and textarea and long maxLength', () => {
    expect(fieldKind({ type: 'string', 'x-widget': 'secret' })).toBe('secret');
    expect(fieldKind({ type: 'string', 'x-widget': 'textarea' })).toBe('text');
    expect(fieldKind({ type: 'string', maxLength: 500 })).toBe('text');
  });
});
