import { describe, expect, it } from 'vitest';

import { MAX_DIFF_LINES, lineDiff } from '../lineDiff';

const NL = '\n';
const kinds =(a: string, b: string) => lineDiff(a, b).lines.map((l) => `${l.kind[0]} ${l.text}`);

describe('lineDiff', () => {
  it('marks kept, removed and added lines with both sides line numbers', () => {
    const { lines, wholeBlock } = lineDiff('a\nb\nc', 'a\nc\nd');
    expect(wholeBlock).toBe(false);
    expect(lines).toEqual([
      { kind: 'same', text: 'a', a: 1, b: 1 },
      { kind: 'removed', text: 'b', a: 2 },
      { kind: 'same', text: 'c', a: 3, b: 2 },
      { kind: 'added', text: 'd', b: 3 },
    ]);
  });

  it('handles identical, empty and one-sided inputs', () => {
    expect(kinds('same\ntext', 'same\ntext')).toEqual(['s same', 's text']);
    expect(kinds('', 'new')).toEqual(['a new']);
    expect(kinds('old', '')).toEqual(['r old']);
    expect(lineDiff('', '').lines).toEqual([]);
    // CRLF and LF texts compare by line content.
    expect(kinds('a\r\nb', 'a\nb')).toEqual(['s a', 's b']);
  });

  it(`falls back to a whole-block diff when the changed middle is over ${MAX_DIFF_LINES} lines`, () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join(NL);
    const { lines, wholeBlock } = lineDiff(big, big.toUpperCase());
    expect(wholeBlock).toBe(true);
    expect(lines.filter((l) => l.kind === 'removed')).toHaveLength(MAX_DIFF_LINES + 1);
    expect(lines.filter((l) => l.kind === 'added')).toHaveLength(MAX_DIFF_LINES + 1);
    expect(lines.some((l) => l.kind === 'same')).toBe(false);
  });
});
