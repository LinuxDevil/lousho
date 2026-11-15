import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(memory: unknown) {
  return { ...base, memory };
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

describe('spec v2 memory', () => {

  it('rejects itemKey without itemJsonSchema', () => {
    const error = thrown(spec([{ name: 'notes', scope: 'global', provider: { type: 'in-memory' }, itemKey: 'topic' }]));
    expect(error.errors).toHaveProperty('memory.0.itemKey');
    expect(error.message).toContain('itemKey needs itemJsonSchema');
  });
});
