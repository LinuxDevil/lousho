import { describe, expect, it } from 'vitest';

import type { AgentListItem } from '../../../../shared/wireTypes';
import { filterAgents, parseAgentListQuery } from '../agentListUrl';

const item = (over: Partial<AgentListItem>): AgentListItem => ({
  id: 'agent',
  name: 'Agent',
  description: '',
  model: 'anthropic/claude-sonnet-5-5',
  enabled: true,
  labels: [],
  updatedAt: '2026-10-29T11:00:00Z',
  publishedVersion: null,
  counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  ...over,
});

describe('parseAgentListQuery', () => {
  it('reads q, the comma-separated label set and enabled', () => {
    expect(parseAgentListQuery(new URLSearchParams('q=Bot&label=b,a&enabled=off'))).toEqual({
      q: 'Bot',
      labels: ['b', 'a'],
      enabled: 'off',
    });
  });

  it('drops an unknown enabled value and absent keys', () => {
    expect(parseAgentListQuery(new URLSearchParams('enabled=maybe'))).toEqual({
      q: '',
      labels: [],
      enabled: undefined,
    });
    expect(parseAgentListQuery(new URLSearchParams())).toEqual({ q: '', labels: [], enabled: undefined });
  });
});

describe('filterAgents', () => {
  const items = [
    item({ id: 'support-bot', name: 'Support bot', labels: ['billing'], enabled: true }),
    item({
      id: 'pr-reviewer',
      name: 'PR reviewer',
      labels: ['github', 'billing'],
      enabled: false,
      model: 'anthropic/claude-opus-5',
    }),
    item({ id: 'docs-qa', name: 'Docs QA', model: 'openai/gpt-5', enabled: true }),
  ];

  const ids = (filter: Parameters<typeof filterAgents>[1]) => filterAgents(items, filter).map((a) => a.id);

  it('requires every selected label', () => {
    expect(ids({ q: '', labels: ['billing', 'github'], enabled: undefined })).toEqual(['pr-reviewer']);
    expect(ids({ q: '', labels: ['billing'], enabled: undefined })).toEqual(['pr-reviewer', 'support-bot']);
  });

  it('filters on enabled', () => {
    expect(ids({ q: '', labels: [], enabled: 'on' })).toEqual(['docs-qa', 'support-bot']);
    expect(ids({ q: '', labels: [], enabled: 'off' })).toEqual(['pr-reviewer']);
  });
});
