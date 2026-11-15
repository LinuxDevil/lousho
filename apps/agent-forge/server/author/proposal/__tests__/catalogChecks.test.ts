import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type { AuthorToolFailure } from '../../../../shared/authorWire';
import { checkCatalogs, type CatalogFacts } from '../catalogChecks';

function spec(over: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return {
    version: 2,
    name: 'Test agent',
    description: 'does a thing',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'do a thing',
    ...over,
  };
}

function facts(over: Partial<CatalogFacts> = {}): CatalogFacts {
  return {
    modelIds: new Set(['anthropic/claude-sonnet-5-5', 'openai/gpt-5']),
    builtinTools: new Set(['web_fetch', 'run_command']),
    guardrails: new Set(['pii', 'regex']),
    triggerTypes: new Set(['chat', 'cron', 'webhook', 'channel', 'agent']),
    agentIds: new Set(['billing-bot', 'support-triage']),
    ...over,
  };
}

function failure(result: AuthorToolFailure | null): AuthorToolFailure {
  expect(result).not.toBeNull();
  expect(result!.ok).toBe(false);
  return result!;
}

describe('checkCatalogs', () => {

  it('UNKNOWN_GUARDRAIL for a guardrail name the catalog lacks', () => {
    const result = failure(
      checkCatalogs(spec({ guardrails: [{ id: 'g1', name: 'pii' }, { id: 'g2', name: 'not-a-guardrail' as never }] }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_GUARDRAIL');
    expect(result.error).toContain('guardrails[1] name "not-a-guardrail" does not exist');
  });

  it('UNKNOWN_TRIGGER_TYPE for a trigger type the catalog lacks', () => {
    const result = failure(
      checkCatalogs(spec({ triggers: [{ id: 't1', type: 'chat' }, { id: 't2', type: 'smoke' as never }] }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_TRIGGER_TYPE');
    expect(result.error).toContain('triggers[1] type "smoke" does not exist');
  });

  it('UNKNOWN_AGENT_REF for a subagents.<key>.ref that is not a workspace agent', () => {
    const result = failure(
      checkCatalogs(spec({ subagents: { helper: { ref: 'billing-bot' }, ghost: { ref: 'gone' } } }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_AGENT_REF');
    expect(result.error).toContain('subagents.ghost.ref agent "gone" does not exist');
  });

  it('UNKNOWN_AGENT_REF for a handoffs[i].agent that is not a workspace agent', () => {
    const result = failure(checkCatalogs(spec({ handoffs: [{ agent: 'gone' }] }), facts(), 'proposeAgent'));
    expect(result.code).toBe('UNKNOWN_AGENT_REF');
    expect(result.error).toContain('handoffs[0].agent agent "gone" does not exist');
  });
});
