import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(permissions: unknown) {
  return { ...base, permissions };
}

function rule(fields: Record<string, unknown>) {
  return spec([{ id: 'p1', tool: 'shell', action: 'deny', ...fields }]);
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

describe('spec v2 permissions', () => {

  it("rejects action 'auto' as not supported yet", () => {
    const error = thrown(rule({ action: 'auto' }));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.errors).toHaveProperty('permissions.0.action');
    expect(error.message).toContain("action 'auto'");
  });
});
