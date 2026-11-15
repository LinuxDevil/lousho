import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(guardrails: unknown) {
  return { ...base, guardrails };
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

describe('spec v2 guardrails', () => {

  it('rejects onTripped and options.action both set to different values', () => {
    const error = thrown(spec([{ id: 'g1', name: 'pii', onTripped: 'block', options: { action: 'rewrite' } }]));
    expect(error.errors).toHaveProperty('guardrails.0.options.action');
    expect(error.message).toContain('set either onTripped or options.action, not both');
  });

  it('rejects runInParallel on a guardrail that does not check the input', () => {
    const error = thrown(
      spec([{ id: 'g1', name: 'moderation', options: { model: 'openai/gpt-4o-mini' }, on: 'output', runInParallel: true }])
    );
    expect(error.errors).toHaveProperty('guardrails.0.runInParallel');
    expect(error.message).toContain('only input guardrails run in parallel');
  });

  it('rejects runInParallel on a guardrail that rewrites', () => {
    const error = thrown(spec([{ id: 'g1', name: 'pii', onTripped: 'rewrite', runInParallel: true }]));
    expect(error.errors).toHaveProperty('guardrails.0.runInParallel');
    expect(error.message).toContain('a parallel guardrail cannot rewrite');
  });
});
