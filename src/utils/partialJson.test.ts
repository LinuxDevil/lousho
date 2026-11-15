import { describe, expect, it } from 'vitest';
import { parsePartialJson } from './partialJson';

describe('parsePartialJson', () => {
  it.each([
    ['```json\n{"title": "Hi', { title: 'Hi' }],
  ])('%j -> %j', (text, expected) => {
    expect(parsePartialJson(text)).toEqual(expected);
  });

  it.each([ '{"a": nope}'])('%j is not JSON -> undefined', (text) => {
    expect(parsePartialJson(text)).toBeUndefined();
  });

  it('parses every prefix of a document without throwing, ending at the document', () => {
    const doc = JSON.stringify({ title: 'Ünïcode "quoted" \\ text', items: [{ id: 1, ok: false, tags: ['x', 'y'] }, { id: -2.5e3, none: null }], nested: { deep: [[], {}] } }, null, 2);
    let last: unknown;
    for (let end = 1; end <= doc.length; end++) last = parsePartialJson(doc.slice(0, end)) ?? last;
    expect(last).toEqual(JSON.parse(doc));
  });
});
