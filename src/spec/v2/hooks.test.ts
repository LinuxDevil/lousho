import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(hooks: unknown) {
  return { ...base, hooks };
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('spec v2 hooks', () => {

  it('requires exactly one of file and inline', () => {
    for (const hooks of [
      [{ id: 'x', file: 'a.ts', inline: { name: 'n', point: 'preToolCall', code: 'c' } }],
      [{ id: 'x' }],
      ['a.ts'],
    ]) {
      const error = thrown(spec(hooks));
      expect(error.errors).toHaveProperty('hooks.0');
      expect(error.message).toContain('exactly one of file, inline');
    }
  });
});
