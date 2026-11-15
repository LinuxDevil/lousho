/**
 * A tool result JSON cannot encode as it is (a cycle, a BigInt, a Map or a
 * Set) reaches the model encoded as far as it can be, and never fails the run.
 */
import { describe, expect, it } from 'vitest';
import { toolResultContent } from './toolResult';

describe('toolResultContent with values JSON cannot encode', () => {

  it('a BigInt is its decimal string, a Map an object (or entry list), a Set an array', () => {
    expect(JSON.parse(toolResultContent({ n: 10n }))).toEqual({ n: '10' });
    expect(JSON.parse(toolResultContent({ m: new Map([['k', 1]]), s: new Set([1, 2]) }))).toEqual({ m: { k: 1 }, s: [1, 2] });
    expect(JSON.parse(toolResultContent(new Map([[1, 'one']])))).toEqual([[1, 'one']]);
  });

  it('a value that throws while encoding becomes an {error} the model reads', () => {
    const hostile = { toJSON: () => { throw new Error('nope'); } };
    expect(JSON.parse(toolResultContent(hostile))).toEqual({ error: 'The tool result could not be encoded as JSON: nope' });
  });
});
