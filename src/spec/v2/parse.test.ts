import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('parseAgentSpecV2', () => {

  it('reports an unknown key with no plausible match plainly', () => {
    const error = thrown({ ...base, zzzz: 1 });
    expect(error.message).toContain("unknown field 'zzzz'");
    expect(error.message).not.toContain('did you mean');
  });
});
