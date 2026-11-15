import { describe, expect, it } from 'vitest';

import type { CanvasLayout } from '../../../../shared/wireTypes';
import { KIND_VIEWS } from '../../../canvas/kinds';
import { graphToSpec } from '../graphToSpec';
import {
  addNode,
  connectNodes,
  duplicateNode,
  moveNode,
  ownerForNewNode,
  patchNode,
  removeNode,
  reownNode,
  setCollapsed,
  setNodeData,
} from '../mutations';
import { uniqueName } from '../nodeIds';
import type { AgentSpecV2 } from '../specTypes';
import { specToGraph } from '../specToGraph';
import type {
  AgentNodeData,
  Graph,
  GraphNode,
  GuardrailNodeData,
  McpNodeData,
  MemoryNodeData,
  NodeKind,
  SkillNodeData,
  SubagentNodeData,
} from '../types';
import { ROOT_ONLY_KINDS } from '../types';
import { arbSpec } from './arbitraries';
import { int, mulberry32, pick } from './prng';

type Rng = () => number;

function minimalSpec(over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

/** A minimal inline subagent spec entry (description is required on inline agents). */
function inlineAgent(over: Record<string, unknown> = {}): { inline: Record<string, unknown> } {
  return {
    inline: { name: 's', description: 'd', model: 'mock/mock-1', instructions: 'x', ...over },
  };
}

/**
 * `agent` → `tool:http`; `agent` → `sub:r` → (`tool:x`, `sub:s` → `tool:y`) —
 * the tree the owner/descendant cases walk.
 */
function treeSpec(): AgentSpecV2 {
  return minimalSpec({
    tools: [{ builtin: 'http' }],
    subagents: {
      r: inlineAgent({
        name: 'r',
        tools: [{ builtin: 'x' }],
        subagents: { s: inlineAgent({ name: 's', tools: [{ builtin: 'y' }] }) },
      }),
    },
  });
}

function nodeById(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node '${id}'`);
  return node;
}

/** Object.freeze every object in `value`, recursively. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const AT = { x: 10, y: 20 };

describe('removeNode', () => {
  it('returns the same reference for the root agent', () => {
    const g = specToGraph(treeSpec());
    expect(removeNode(g, 'agent')).toBe(g);
  });
});

describe('duplicateNode', () => {
  const layout: CanvasLayout = {
    schemaVersion: 1,
    nodes: { 'tool:http': { x: 10, y: 20 } },
    notes: [{ id: 'n1', x: 0, y: 0, text: 't' }],
  };
  const g = specToGraph(minimalSpec({ tools: [{ builtin: 'http' }] }), layout);

  it('refuses the root agent and notes', () => {
    expect(duplicateNode(g, 'agent')).toStrictEqual({ graph: g, nodeId: undefined });
    expect(duplicateNode(g, 'note:n1')).toStrictEqual({ graph: g, nodeId: undefined });
  });
});

describe('palette create (C04 subagent entries)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const inline = entries.find((e) => e.id === 'subagent-inline');
  const ref = entries.find((e) => e.id === 'subagent-ref');

  it('names the first subagent "helper" and the second "helper-2"', () => {
    const first = inline!.create(g0, 'agent');
    expect((first.data as AgentNodeData).subagentKey).toBe('helper');
    const g1 = addNode(g0, first, AT, 'agent').graph;
    const second = ref!.create(g1, 'agent');
    expect((second.data as SubagentNodeData).key).toBe('helper-2');
  });
});

describe('palette create (C06 tool entries)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const tool = entries.find((e) => e.id === 'tool');
  const openapi = entries.find((e) => e.id === 'tool-openapi');
  const integration = entries.find((e) => e.id === 'tool-integration');

  it('creates the empty item each entry describes', () => {
    expect(tool!.create(g0, 'agent').data).toStrictEqual({ item: { builtin: '' } });
    expect(openapi!.create(g0, 'agent').data).toStrictEqual({ item: { openapi: { url: '' } } });
    expect(integration!.create(g0, 'agent').data).toStrictEqual({
      item: { integration: 'github', credentials: {} },
    });
  });
});

describe('palette create (C08 skill entry)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const skill = entries.find((e) => e.id === 'skill');

  it('names two creates skill and skill-2 with ids skill:skill and skill:skill-2', () => {
    const first = addNode(g0, skill!.create(g0, 'agent'), AT, 'agent');
    expect(first.nodeId).toBe('skill:skill');
    const second = addNode(first.graph, skill!.create(first.graph, 'agent'), AT, 'agent');
    expect(second.nodeId).toBe('skill:skill-2');
    expect((nodeById(second.graph, 'skill:skill-2').data as SkillNodeData).item).toStrictEqual({
      inline: { name: 'skill-2', description: '', content: '' },
    });
  });
});

describe('palette create (C09 memory entry)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const memory = entries.find((e) => e.id === 'memory');

  it('names two creates memory:notes and memory:notes-2', () => {
    const first = addNode(g0, memory!.create(g0, 'agent'), AT, 'agent');
    expect(first.nodeId).toBe('memory:notes');
    const second = addNode(first.graph, memory!.create(first.graph, 'agent'), AT, 'agent');
    expect(second.nodeId).toBe('memory:notes-2');
    expect((nodeById(second.graph, 'memory:notes-2').data as MemoryNodeData).item).toStrictEqual({
      name: 'notes-2',
      scope: 'session',
      provider: { type: 'in-memory' },
    });
  });
});

describe('palette create (trigger entries)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const byId = (id: string) => entries.find((e) => e.id === id);

  it('creates each type\'s empty value with a fresh t-item id', () => {
    expect(byId('trigger-chat')!.create(g0, 'agent').data).toStrictEqual({
      item: { id: 't1', type: 'chat' },
    });
    expect(byId('trigger-cron')!.create(g0, 'agent').data).toStrictEqual({
      item: { id: 't1', type: 'cron', cron: '0 9 * * 1-5', prompt: '' },
    });
    expect(byId('trigger-webhook')!.create(g0, 'agent').data).toStrictEqual({
      item: { id: 't1', type: 'webhook', path: '/hooks/t1', promptTemplate: '' },
    });
    expect(byId('trigger-channel')!.create(g0, 'agent').data).toStrictEqual({
      item: { id: 't1', type: 'channel', channel: 'slack', secrets: {} },
    });
    expect(byId('trigger-agent')!.create(g0, 'agent').data).toStrictEqual({
      item: { id: 't1', type: 'agent', after: '', on: 'done', promptTemplate: '{{run.resultText}}' },
    });
  });
});

describe('palette create (C13 note entry)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const note = entries.find((e) => e.id === 'note');

  it('creates an ownerless note:n node that lands in layout.notes, not the spec', () => {
    const created = note!.create(g0, ownerForNewNode(g0, 'note'));
    const added = addNode(g0, created, AT, null);
    expect(added.nodeId).toMatch(/^note:n/);
    const node = nodeById(added.graph, added.nodeId);
    expect(node.owner).toBeNull();
    const r = graphToSpec(added.graph);
    expect(r.layout.notes).toStrictEqual([
      { id: added.nodeId.slice('note:'.length), x: AT.x, y: AT.y, text: '' },
    ]);
    expect(r.spec).toStrictEqual(minimalSpec());
  });
});

describe('palette create (C13 hook entry)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const hook = entries.find((e) => e.id === 'hook');

  it('creates the audit-log inline hook with the first free h id', () => {
    const first = addNode(g0, hook!.create(g0, 'agent'), AT, 'agent');
    expect(first.nodeId).toBe('hook:h1');
    const second = addNode(first.graph, hook!.create(first.graph, 'agent'), AT, 'agent');
    expect(second.nodeId).toBe('hook:h2');
    const data = nodeById(second.graph, 'hook:h2').data as { item: { id: string; inline: { name: string; point: string; code: string } } };
    expect(data.item.id).toBe('h2');
    expect(data.item.inline.name).toBe('audit-log');
    expect(data.item.inline.point).toBe('postToolCall');
    expect(data.item.inline.code).not.toBe('');
  });
});

describe('palette create (C10 guardrail entry)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const guardrail = entries.find((e) => e.id === 'guardrail');

  it('names two creates guard:g1 and guard:g2', () => {
    const first = addNode(g0, guardrail!.create(g0, 'agent'), AT, 'agent');
    expect(first.nodeId).toBe('guard:g1');
    const second = addNode(first.graph, guardrail!.create(first.graph, 'agent'), AT, 'agent');
    expect(second.nodeId).toBe('guard:g2');
    expect((nodeById(second.graph, 'guard:g2').data as GuardrailNodeData).item).toStrictEqual({
      id: 'g2',
      name: 'max-length',
      on: ['input', 'output'],
    });
  });
});

describe('immutability', () => {
  it('every mutation returns a new graph and never mutates a deep-frozen input', () => {
    const g = deepFreeze(specToGraph(treeSpec()));
    const results: Array<unknown> = [
      addNode(g, { kind: 'tool', data: { item: { builtin: 'z' } } }, AT, 'agent'),
      removeNode(g, 'tool:http'),
      duplicateNode(g, 'tool:http'),
      moveNode(g, 'tool:http', { x: 1, y: 1 }),
      setNodeData<'tool'>(g, 'tool:http', { item: { builtin: 'z' } }),
      patchNode(g, 'tool:http', { approval: 'always' }),
      setCollapsed(g, 'sub:r', true),
      reownNode(g, 'tool:http', 'sub:r'),
      connectNodes(g, 'agent', 'sub:r/tool:x'),
    ];
    for (const result of results) {
      const resultGraph = typeof result === 'object' && result !== null && 'graph' in result ? result.graph : result;
      expect(resultGraph).not.toBe(g);
    }
    expect(g.nodes.map((n) => n.id)).toEqual([
      'agent',
      'tool:http',
      'sub:r',
      'sub:r/tool:x',
      'sub:r/sub:s',
      'sub:r/sub:s/tool:y',
    ]);
  });
});

/* --- mutation round-trip property test --- */

/** Section kinds the property test adds (flow is C15's; notes are not a section). */
const ADD_KINDS: readonly NodeKind[] = [
  'tool', 'mcp', 'skill', 'memory', 'subagent', 'agent', 'handoff',
  'guardrail', 'permission', 'hook', 'trigger', 'abort', 'output',
];

/** Ids of every live agent node (owner candidates). */
function agentIds(g: Graph): string[] {
  return g.nodes.filter((n) => n.kind === 'agent' && n.proposed !== 'remove').map((n) => n.id);
}

/** Keys of the owner's `subagents` entries: `data.key` for refs, `data.subagentKey` for inline agents. */
function siblingSubagentKeys(g: Graph, owner: string): string[] {
  return g.nodes
    .filter((n) => n.owner === owner && (n.kind === 'subagent' || (n.kind === 'agent' && n.owner !== null)))
    .map((n) =>
      n.kind === 'subagent' ? (n.data as SubagentNodeData).key : ((n.data as AgentNodeData).subagentKey ?? '')
    );
}

/** Keys of the owner's `mcpServers` entries. */
function siblingMcpKeys(g: Graph, owner: string): string[] {
  return g.nodes
    .filter((n) => n.owner === owner && n.kind === 'mcp')
    .map((n) => (n.data as McpNodeData).key);
}

/** A minimal valid `data` for `kind` owned by `owner`; record keys are unique so graphToSpec cannot throw. */
function minimalData(g: Graph, kind: NodeKind, owner: string): GraphNode['data'] {
  switch (kind) {
    case 'tool':
      return { item: { builtin: 'http' } };
    case 'mcp':
      return { key: uniqueName('m', siblingMcpKeys(g, owner)), item: { command: 'x' } };
    case 'skill':
      return { item: { dir: 'skills/a' } };
    case 'memory':
      return { item: { name: 'm', scope: 'session', provider: { type: 'in-memory' } } };
    case 'subagent':
      return { key: uniqueName('s', siblingSubagentKeys(g, owner)), item: { ref: 'agents/x.yaml' } };
    case 'agent': {
      const key = uniqueName('s', siblingSubagentKeys(g, owner));
      return {
        fields: { name: key, description: 'd', model: 'mock/mock-1', instructions: 'x' },
        extra: {},
        subagentKey: key,
      };
    }
    case 'handoff':
      return { item: { agent: 'b' } };
    case 'guardrail':
      return { item: { id: 'g1', name: 'max-length', on: 'input' } };
    case 'permission':
      return { item: { id: 'p1', tool: '*', action: 'allow' } };
    case 'hook':
      return { item: { id: 'h1', inline: { name: 'n', point: 'preToolCall', code: 'return ctx;' } } };
    case 'trigger':
      return { item: { id: 't1', type: 'chat' } };
    case 'abort':
      return { item: { id: 'a1', triggerId: 't1', when: 'true', match: 'true', scope: 'both' } };
    case 'output':
      return { item: { jsonSchema: { type: 'object' } } };
    default:
      throw new Error(`no minimal data for ${kind}`);
  }
}

/** Whether `owner` already has an output node (an agent can have only one). */
function hasOutput(g: Graph, owner: string): boolean {
  return g.nodes.some((n) => n.kind === 'output' && n.owner === owner && n.proposed !== 'remove');
}

/** A random valid add: a random section kind, a fitting owner, minimal data. */
function randomAdd(rng: Rng, g: Graph): { kind: NodeKind; data: GraphNode['data']; owner: string } {
  let kind = pick(rng, ADD_KINDS);
  if (kind === 'output' && agentIds(g).every((id) => hasOutput(g, id))) kind = 'tool';
  const owner = ROOT_ONLY_KINDS.has(kind)
    ? 'agent'
    : kind === 'output'
      ? pick(rng, agentIds(g).filter((id) => !hasOutput(g, id)))
      : pick(rng, agentIds(g));
  return { kind, owner, data: minimalData(g, kind, owner) };
}

/** One random mutation from the ticket's list. */
function randomMutation(rng: Rng, g: Graph): Graph {
  const op = pick(rng, ['add', 'remove', 'move', 'patch'] as const);
  switch (op) {
    case 'add': {
      const { kind, data, owner } = randomAdd(rng, g);
      return addNode(g, { kind, data }, { x: int(rng, -500, 500), y: int(rng, -500, 500) }, owner).graph;
    }
    case 'remove': {
      const removable = g.nodes.filter((n) => n.id !== 'agent');
      return removable.length === 0 ? g : removeNode(g, pick(rng, removable).id);
    }
    case 'move':
      return moveNode(g, pick(rng, g.nodes).id, { x: int(rng, -500, 500), y: int(rng, -500, 500) });
    case 'patch': {
      const candidates = g.nodes.filter((n) => n.kind !== 'note');
      return patchNode(g, pick(rng, candidates).id, { description: 'd' + int(rng, 0, 99) });
    }
  }
}

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

describe.each(SEEDS)('mutation round trip, seed %i', (seed) => {
  const rng = mulberry32(seed);
  let g = specToGraph(arbSpec(rng));
  for (let i = 0; i < 10; i += 1) g = randomMutation(rng, g);
  const r1 = graphToSpec(g);
  const g2 = specToGraph(r1.spec, r1.layout);
  const r2 = graphToSpec(g2, r1.spec);

  it('spec and layout are identical after a spec→graph→spec cycle', () => {
    expect(r2.spec).toStrictEqual(r1.spec);
    expect(r2.layout).toStrictEqual(r1.layout);
  });
});
