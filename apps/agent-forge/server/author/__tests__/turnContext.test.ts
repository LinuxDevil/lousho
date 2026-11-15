import { describe, it, expect } from 'vitest';
import { buildTurnContext, specSummary, type TurnContextInput } from '../turnContext';
import type { AgentSpecV2 } from 'lousho';

/**
 * buildTurnContext: the per-turn block the runner prepends to the user
 * message (PLAN 8.1: the system prompt is byte-stable, so everything that
 * changes per turn rides here). Same input must give the same bytes and the
 * Date line changes at most daily - a time of day would bust the prompt
 * cache every second.
 */
describe('buildTurnContext', () => {
  const NOW = new Date('2026-10-29T14:37:22.000Z');

  it('lists open proposal cards newest last', () => {
    const input: TurnContextInput = {
      focus: { mode: 'edit', agentId: 'support-triage' },
      focusedAgent: { id: 'support-triage', name: 'Support triage', enabled: true, latestVersion: 4, summary: 's' },
      openProposals: [
        { proposalId: 'tc_1', kind: 'create', name: 'Support triage' },
        { proposalId: 'tc_2', kind: 'update', agentId: 'support-triage', name: 'Support triage' },
      ],
      now: NOW,
    };
    const block = buildTurnContext(input);
    expect(block).toContain(
      'Open proposal cards (newest last):\n- tc_1 · create · "Support triage"\n- tc_2 · update · support-triage · "Support triage"'
    );
  });
});

describe('specSummary', () => {
  const base: AgentSpecV2 = {
    version: 2,
    name: 'Support triage',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'Triage inbound mail.',
  };

  it('lists model, tool display names, mcp keys, guardrail names, trigger types and the instructions head', () => {
    const spec: AgentSpecV2 = {
      ...base,
      tools: [{ builtin: 'web_fetch' }, { registry: 'github-issues' }, { hosted: 'web_search' }],
      mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } },
      guardrails: [{ id: 'g1', name: 'pii' }],
      triggers: [{ id: 't1', type: 'cron', cron: '0 9 * * *', prompt: 'go' }],
    };
    expect(specSummary(spec)).toBe(
      'model anthropic/claude-sonnet-5-5; tools: web_fetch, github-issues (registry), web_search (hosted); mcp: linear; guardrails: pii; triggers: cron; instructions: Triage inbound mail.'
    );
  });

  it('uses the AA16 display names for every tool ref kind', () => {
    const spec: AgentSpecV2 = {
      ...base,
      tools: [
        { builtin: 'todo' },
        { registry: 'github-issues' },
        { file: 'tools/lookup.ts' },
        { integration: 'slack', credentials: { webhookUrl: { secret: 'SLACK_HOOK' } } },
        { openapi: { url: 'https://api.example.com/openapi.json' } },
        { hosted: 'code_interpreter' },
        { hub: true },
      ],
    };
    expect(specSummary(spec)).toContain(
      'tools: todo, github-issues (registry), lookup.ts, slack integration, api.example.com, code_interpreter (hosted), Context hub'
    );
  });

  it('caps the whole summary at 600 chars', () => {
    const spec: AgentSpecV2 = {
      ...base,
      model: 'm'.repeat(400),
      instructions: 'y'.repeat(400),
    };
    expect(specSummary(spec).length).toBeLessThanOrEqual(600);
    expect(specSummary(spec).endsWith('…')).toBe(true);
  });
});
