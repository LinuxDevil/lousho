import { describe, it, expect } from 'vitest';
import { normalizeToolCall, toolCallArgs, toolCallName } from '../providers';
import type { ToolCall } from '../providers';

describe('normalizeToolCall / toolCallName / toolCallArgs', () => {
  const wire: ToolCall = { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"t":"hi"}' } };

  it('reads the wire shape', () => {
    expect(toolCallName(wire)).toBe('echo');
    expect(toolCallArgs(wire)).toEqual({ t: 'hi' });
    expect(normalizeToolCall(wire)).toEqual({ id: 'c1', name: 'echo', args: { t: 'hi' }, rawArgs: '{"t":"hi"}' });
  });

  it('reads the flat mock-script shape', () => {
    expect(toolCallName({ name: 'echo' })).toBe('echo');
    expect(toolCallArgs({ args: { t: 'hi' } })).toEqual({ t: 'hi' });
  });

  it('invalid JSON arguments come back undefined, never throw', () => {
    expect(toolCallArgs({ function: { arguments: 'not json' } })).toBeUndefined();
    expect(toolCallArgs({ function: { arguments: '[1,2]' } })).toBeUndefined();
    expect(toolCallArgs({})).toBeUndefined();
  });
});
