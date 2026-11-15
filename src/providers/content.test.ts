import { describe, it, expect } from 'vitest';
import { toolResultText } from './content';

describe('toolResultText', () => {

  it('keeps a non-string result as its JSON', () => {
    expect(toolResultText({ role: 'tool', content: '{"tier":"gold","revenue":1300}' })).toBe('{"tier":"gold","revenue":1300}');
    expect(toolResultText({ role: 'tool', content: 'null' })).toBe('null');
    expect(toolResultText({ role: 'tool', content: '42' })).toBe('42');
  });
});
