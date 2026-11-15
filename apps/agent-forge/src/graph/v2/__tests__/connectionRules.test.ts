import { describe, expect, it } from 'vitest';

import { canConnect, CONNECTION_RULES } from '../connectionRules';
import type { AgentFields, NodeKind, NodeOfKind } from '../types';

/** Smallest valid `AgentNodeData.fields` for tests that never inspect the fields. */
const AGENT_FIELDS: AgentFields = { name: 'a', model: 'mock/mock-1', instructions: 'hi' };

/** One minimal data object per node kind, so tests can build nodes without repeating literals. */
const NODE_DATA: { [K in NodeKind]: NodeOfKind<K>['data'] } = {
  agent: { fields: AGENT_FIELDS, extra: {} },
  subagent: { key: 'research', item: { ref: 'agents/r.yaml' } },
  handoff: { item: { agent: 'helper' } },
  tool: { item: { builtin: 'http' } },
  mcp: { key: 'gh', item: { command: 'gh-mcp' } },
  skill: { item: { registry: 'changelog' } },
  memory: { item: { name: 'mem', scope: 'global', provider: { type: 'in-memory' } } },
  guardrail: { item: { id: 'g1', name: 'regex' } },
  permission: { item: { id: 'p1', tool: '*', action: 'allow' } },
  hook: { item: { id: 'h1', file: 'hooks/a.ts' } },
  output: { item: { jsonSchema: { type: 'object' } } },
  trigger: { item: { id: 't1', type: 'chat' } },
  abort: { item: { id: 'a1', triggerId: 't1', when: 'w', match: 'm', scope: 'both' } },
  flow: { step: { type: 'agentStep', id: 's1' }, children: { shape: 'none' } },
  note: { text: 'hi' },
};

/** Minimal graph node of a kind; ids default to `<kind>:x` and owners to the root agent. */
function node<K extends NodeKind>(kind: K, over: { id?: string; owner?: string | null } = {}): NodeOfKind<K> {
  const base = {
    id: over.id ?? `${kind}:x`,
    kind,
    owner: over.owner === undefined ? 'agent' : over.owner,
    position: { x: 0, y: 0 },
    data: NODE_DATA[kind],
  };
  return base as unknown as NodeOfKind<K>;
}

describe('canConnect kind table', () => {
  /**
   * `trigger > agent` is in the table but can never connect: that edge
   * always exists already, so the instance rules below refuse it. It is
   * asserted separately with its refusal reason. `agent > output` stays in
   * the table — `canConnect` has no graph, so the one-output-per-agent rule
   * is enforced by `agentRules.connectFrom` (see kinds/output.test.ts).
   */
  const ALWAYS_REFUSED = new Set(['trigger>agent']);

  it.each(
    (Object.entries(CONNECTION_RULES) as Array<[NodeKind, readonly NodeKind[]]>).flatMap(
      ([sourceKind, targets]) =>
        targets
          .filter((targetKind) => !ALWAYS_REFUSED.has(`${sourceKind}>${targetKind}`))
          .map((targetKind) => [sourceKind, targetKind] as const),
    ),
  )('allows %s -> %s for a minimal pair of nodes', (sourceKind, targetKind) => {
    const sameOwner = sourceKind === 'tool' || sourceKind === 'mcp';
    const source = node(sourceKind, { id: sourceKind === 'agent' ? 'agent' : `${sourceKind}:s`, owner: 'agent' });
    const target = node(targetKind, { id: `${targetKind}:t`, owner: sameOwner ? 'agent' : 'other' });
    expect(canConnect(source, target)).toEqual({ ok: true });
  });

  it.each([
    ['note', 'agent'],
    ['agent', 'note'],
    ['tool', 'agent'],
    ['output', 'agent'],
    ['abort', 'trigger'],
    ['subagent', 'tool'],
  ] as Array<[NodeKind, NodeKind]>)('refuses %s -> %s', (sourceKind, targetKind) => {
    const source = node(sourceKind, { id: `${sourceKind}:s`, owner: 'agent' });
    const target = node(targetKind, { id: `${targetKind}:t`, owner: 'other' });
    expect(canConnect(source, target)).toEqual({
      ok: false,
      reason: `Can't connect ${sourceKind} → ${targetKind}`,
    });
  });
});

describe('canConnect instance rules', () => {

  it('refuses trigger -> inline agent', () => {
    const source = node('trigger');
    const target = node('agent', { id: 'sub:research' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: 'Triggers start the main agent only' });
  });

  it('allows agent -> output when the agent already owns one (connectFrom refuses it)', () => {
    // `canConnect` cannot see the graph, so a second output is only refused
    // by `connectNodes` → `agentRules.connectFrom`; the kind pair itself is fine.
    const source = node('agent', { id: 'agent' });
    const own = node('output', { id: 'output', owner: 'agent' });
    const other = node('output', { id: 'output#2', owner: 'other' });
    expect(canConnect(source, own)).toEqual({ ok: false, reason: 'Already attached to this agent' });
    expect(canConnect(source, other)).toEqual({ ok: true });
  });
});
