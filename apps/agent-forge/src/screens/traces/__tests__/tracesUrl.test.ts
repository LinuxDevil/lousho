import { describe, expect, it } from 'vitest';

import { formatTracesQuery, parseTracesQuery,  } from '../tracesUrl';

const parse = (qs: string) => parseTracesQuery(new URLSearchParams(qs));

describe('tracesUrl', () => {
  it('round-trips every key in a stable order', () => {
    const qs = '?agent=a1&status=error&model=m&project=p&q=refund&prompt=mira%402&from=10&to=20&sort=cost&order=asc&offset=50';
    expect(formatTracesQuery(parse(qs.slice(1)))).toBe(qs);
  });

  it('leaves the defaults out, so a default state is a bare #/traces', () => {
    expect(formatTracesQuery({ offset: 0 })).toBe('');
    expect(formatTracesQuery({ offset: 0, sort: { key: 'start', order: 'desc' } })).toBe('');
  });
});
