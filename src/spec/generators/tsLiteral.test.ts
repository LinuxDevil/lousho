import { describe, expect, it } from 'vitest';
import { toTsLiteral } from './tsLiteral';

describe('toTsLiteral', () => {
  it('prints strings single-quoted and escapes backslashes, quotes and newlines', () => {
    expect(toTsLiteral('plain', 0)).toBe("'plain'");
    expect(toTsLiteral("it's \\ fine", 0)).toBe("'it\\'s \\\\ fine'");
    expect(toTsLiteral('a\nb', 0)).toBe("'a\\nb'");
  });

  it('prints nested objects and arrays inline while they fit in 80 columns', () => {
    expect(toTsLiteral({ list: [1, { two: 2 }], empty: {}, none: [] }, 0)).toBe('{ list: [1, { two: 2 }], empty: {}, none: [] }');
  });
});
