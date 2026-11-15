import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type { AuthorPatch } from '../schema';
import { applyAuthorPatch, deriveAgentId,  } from '../toSpec';

const BASE: AgentSpecV2 = {
  version: 2,
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You triage support mail and pick the queue.',
  tools: [{ builtin: 'web_fetch' }],
  reasoning: 'low',
  triggers: [{ id: 't1', type: 'chat' }],
};

describe('applyAuthorPatch', () => {
  const apply = (patch: AuthorPatch) => applyAuthorPatch(BASE, patch);

  it("does not mutate the base's triggers list when appending the chat trigger", () => {
    const triggers: AgentSpecV2['triggers'] = [{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Sweep.' }];
    const base: AgentSpecV2 = { ...BASE, triggers };
    const result = applyAuthorPatch(base, {});
    expect(result.ok).toBe(true);
    expect(base.triggers).toBe(triggers);
    expect(base.triggers).toEqual([{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Sweep.' }]);
  });

  it('reports spec issues with [n] paths', () => {
    const result = apply({ guardrails: [{ id: 'g1', name: 'not-a-guardrail' as never }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'guardrails[0].name')).toBe(true);
    }
  });
});

describe('deriveAgentId', () => {
  const cases: Array<[string, ReadonlySet<string>, string]> = [
    ['Support Triage!', new Set(), 'support-triage'],
    ['Support Triage!', new Set(['support-triage']), 'support-triage-2'],
    ['Support Triage!', new Set(['support-triage', 'support-triage-2']), 'support-triage-3'],
    ['', new Set(), 'agent'],
    ['!!!', new Set(), 'agent'],
    ['', new Set(['agent']), 'agent-2'],
    ['Ünïcödé Ægent', new Set(), 'n-c-d-gent'],
    ['x'.repeat(60), new Set(), 'x'.repeat(48)],
    ['--lead and trail--', new Set(), 'lead-and-trail'],
    ['123 Numbers', new Set(), '123-numbers'],
  ];

  it.each(cases)('deriveAgentId(%j) -> %s', (name, taken, expected) => {
    expect(deriveAgentId(name, taken)).toBe(expected);
  });
});
