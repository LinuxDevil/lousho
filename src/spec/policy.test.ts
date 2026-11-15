/**
 * `spec.policy` is validated and compiled into createAgent options.
 */
import { describe, it, expect } from 'vitest';
import { agentSpecSchema } from './schema';
import { compilePolicy, summarizePolicy } from './policy';

const base = { name: 'bot', prompt: 'hi', provider: { type: 'mock', model: 'm' } };

function policyIssues(policy: unknown): string[] {
  const result = agentSpecSchema.safeParse({ ...base, policy });
  if (result.success) throw new Error('expected validation to fail');
  return result.error.issues.map((issue) => `${(issue.path ?? []).join('.')}: ${issue.message}`);
}

describe('AgentSpec.policy schema', () => {

  it('rejects bad options of the starter-set guardrails', () => {
    expect(policyIssues({ guardrails: [{ name: 'pii', types: ['passport'] }] })[0]).toMatch(/guardrail 'pii' option 'types\.0'/);
    expect(policyIssues({ guardrails: [{ name: 'pii', types: [] }] })[0]).toMatch(/guardrail 'pii' option 'types'/);
    expect(policyIssues({ guardrails: [{ name: 'pii', replacement: 'x' }] })[0]).toMatch(/guardrail 'pii': Unrecognized key/);
    expect(policyIssues({ guardrails: [{ name: 'secrets', extraPatterns: ['('] }] })[0]).toMatch(/extraPatterns has an invalid regular expression/);
    expect(policyIssues({ guardrails: ['moderation'] })[0]).toMatch(/guardrail 'moderation' option 'model'/);
    expect(policyIssues({ guardrails: [{ name: 'moderation', model: 'm', categories: ['spam'] }] })[0]).toMatch(/option 'categories\.0'/);
    expect(policyIssues({ guardrails: [{ name: 'prompt-injection', model: '' }] })[0]).toMatch(/guardrail 'prompt-injection' option 'model'/);
  });
});

describe('compilePolicy', () => {

  it('compiles guardrails by name onto input and output, or the lists `on` names', () => {
    const { guardrails } = compilePolicy({
      guardrails: [
        'secret-scan',
        { name: 'max-length', maxChars: 5, on: 'input' },
        { name: 'deny-topics', topics: ['x'], on: ['tools'] },
        { name: 'regex', pattern: 'a+', flags: 'i' },
        { name: 'llm-judge', model: 'openai/gpt-4o-mini' },
        { name: 'pii', on: 'input' },
        { name: 'secrets', on: ['output', 'tools'] },
        { name: 'prompt-injection', on: 'input' },
        { name: 'moderation', model: 'openai/gpt-4o-mini', on: 'output' },
      ],
    });
    const names = (list?: readonly { name: string }[]) => list?.map((g) => g.name);
    expect(names(guardrails?.input)).toEqual(['secret-scan', 'max-length', 'regex', 'llm-judge', 'pii', 'prompt-injection']);
    expect(names(guardrails?.output)).toEqual(['secret-scan', 'regex', 'llm-judge', 'secrets', 'moderation']);
    expect(names(guardrails?.tools)).toEqual(['deny-topics', 'secrets']);
  });

  it('builds the starter-set guardrails with their spec options', async () => {
    const { guardrails } = compilePolicy({
      guardrails: [
        { name: 'pii', types: ['email'], action: 'rewrite', on: 'input' },
        { name: 'secrets', action: 'block', extraPatterns: ['INTERNAL-\\d{6}'], on: 'output' },
      ],
    });
    const ctx = (text: string) => ({ kind: 'input' as const, text, messages: [] });
    expect(await guardrails?.input?.[0].check(ctx('call 555-123-4567 or a@b.io'))).toMatchObject({
      action: 'rewrite',
      replacement: 'call 555-123-4567 or [email]',
    });
    expect(await guardrails?.output?.[0].check(ctx('id INTERNAL-123456'))).toMatchObject({
      action: 'block',
      info: { category: 'secret', matches: [{ label: 'extra pattern 1' }] },
    });
  });

  it('throws a ValidationError for an unvalidated invalid policy', () => {
    expect(() => compilePolicy({ guardrails: ['nope'] })).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_INVALID' }));
    expect(() => compilePolicy({ guardrails: ['nope'] })).toThrow(/policy\.guardrails\.0.*unknown guardrail 'nope'/);
    expect(() => compilePolicy({ limits: { maxTokens: -1 } })).toThrow(/policy\.limits\.maxTokens/);
  });

  it('summarizePolicy gives one line per block and flags unknown guardrails', () => {
    const lines = summarizePolicy({
      requiresApproval: ['send_email'],
      guardrails: ['max-length', { name: 'oops' }],
      limits: { maxTokens: 10, maxSteps: 2 },
      askQuestion: true,
      compaction: { thresholdPercent: 0.8 },
    });
    expect(lines.map((l) => [l.block, l.text])).toEqual([
      ['approval', 'asks for approval before: send_email'],
      ['guardrails', 'max-length, oops'],
      ['limits', 'maxTokens=10, maxSteps=2'],
      ['askQuestion', 'the agent can ask the user questions'],
      ['compaction', 'on at 80% of the context window'],
    ]);
    expect(lines[1].unknownGuardrails).toEqual(['oops']);
    expect(summarizePolicy(undefined)).toEqual([]);
    expect(summarizePolicy({ requiresApproval: true, compaction: false }).map((l) => l.text)).toEqual(['every tool call asks for approval', 'off']);
  });
});
