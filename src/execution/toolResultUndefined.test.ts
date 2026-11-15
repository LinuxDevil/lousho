/**
 * A tool that returns nothing has the result `null`, so the
 * transcript's `tool` message never has `content: undefined`.
 */
import { describe, expect, it } from 'vitest';
import { toolResultContent } from './toolResult';

describe('a tool that returns nothing', () => {
  it('toolResultContent() is always a string', () => {
    expect(toolResultContent(undefined)).toBe('null');
    expect(toolResultContent(() => 1)).toBe('null');
    expect(toolResultContent({ a: 1 })).toBe('{"a":1}');
  });
});
