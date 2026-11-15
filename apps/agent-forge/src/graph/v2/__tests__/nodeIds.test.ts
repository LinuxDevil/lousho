import { describe, expect, it } from 'vitest';

import {
  baseNodeId,
  
} from '../nodeIds';
import type { AgentFields, GraphNode } from '../types';

/** Smallest valid `AgentNodeData.fields` for tests that never inspect the fields. */
const AGENT_FIELDS: AgentFields = { name: 'a', model: 'mock/mock-1', instructions: 'hi' };

describe('baseNodeId', () => {
  const cases: Array<[GraphNode['kind'], GraphNode['data'], string | null, string]> = [
    ['agent', { fields: AGENT_FIELDS, extra: {} }, 'agent', 'agent'],
    ['subagent', { key: 'research', item: { ref: 'agents/r.yaml' } }, 'agent', 'sub:research'],
    ['tool', { item: { builtin: 'http' } }, 'agent', 'tool:http'],
    ['mcp', { key: 'gh', item: { command: 'gh-mcp' } }, 'agent', 'mcp:gh'],
    ['skill', { item: { registry: 'changelog' } }, 'agent', 'skill:changelog'],
    [
      'memory',
      { item: { name: 'mem', scope: 'global', provider: { type: 'in-memory' } } },
      'agent',
      'memory:mem',
    ],
    ['handoff', { item: { agent: 'helper' } }, 'agent', 'handoff:helper'],
    ['guardrail', { item: { id: 'g1', name: 'regex' } }, 'agent', 'guard:g1'],
    ['permission', { item: { id: 'p1', tool: '*', action: 'allow' } }, 'agent', 'perm:p1'],
    ['hook', { item: { id: 'h1', file: 'hooks/a.ts' } }, 'agent', 'hook:h1'],
    ['output', { item: { jsonSchema: { type: 'object' } } }, 'agent', 'output'],
    ['trigger', { item: { id: 't1', type: 'chat' } }, 'agent', 'trigger:t1'],
    [
      'abort',
      { item: { id: 'a1', triggerId: 't1', when: 'w', match: 'm', scope: 'both' } },
      'agent',
      'abort:a1',
    ],
    ['flow', { step: { type: 'agentStep', id: 's1' }, children: { shape: 'none' } }, 'agent', 'flow:s1'],
    ['note', { text: 'hi' }, null, 'note:'],
  ];

  it.each(cases)('kind %s at root -> %s', (kind, data, ownerId, expected) => {
    expect(baseNodeId(kind, data, ownerId)).toBe(expected);
  });
});
