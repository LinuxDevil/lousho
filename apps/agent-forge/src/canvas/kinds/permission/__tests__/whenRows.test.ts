import { describe, expect, it } from 'vitest';

import { fromRows, type WhenRow } from '../whenRows';

describe('fromRows', () => {
  const ok = (rows: WhenRow[]) => fromRows(rows).when;

  it.each([
    [{ arg: 'n', op: 'ne', value: '0' } as WhenRow, { ne: 0 }],
  ])('writes %j as %j', (row, matcher) => {
    expect(ok([row])).toStrictEqual({ n: matcher });
  });
});

describe('fromRows row errors', () => {

  it.each(['lt',] as const)('flags a non-number for %s', (op) => {
    const parsed = fromRows([{ arg: 'n', op, value: 'abc' }]);
    expect(parsed.errors).toStrictEqual(['Enter a number']);
    expect(parsed.when).toBeUndefined();
  });
});
