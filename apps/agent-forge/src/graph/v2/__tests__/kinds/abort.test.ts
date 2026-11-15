import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { connectNodes, removeNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, TriggerSpec } from '../../specTypes';
import type { AbortNodeData, Graph, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';
import { ABORT_VIEW } from '../../../../canvas/kinds/abort';

/** The ticket's worked example: a webhook trigger and the listener that cancels its runs. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
triggers:
  - { id: t3, type: webhook, path: /hooks/github, promptTemplate: 'Review {{event.pr}}' }
abortListeners:
  - { id: a1, triggerId: t3, when: "event.action == 'closed'", match: 'event.pr == run.event.pr', scope: both }
`;

const WEBHOOK: TriggerSpec = { id: 't3', type: 'webhook', path: '/hooks/github', promptTemplate: 'x' };
const CHANNEL: TriggerSpec = {
  id: 't4',
  type: 'channel',
  channel: 'slack',
  secrets: { signingSecret: { secret: 's' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
};

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(
  abortListeners: Record<string, unknown>[],
  triggers: TriggerSpec[] = [WEBHOOK],
  over: Record<string, unknown> = {}
): Graph {
  return specToGraph(specOf({ triggers, abortListeners, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

const abortNode = (graph: Graph, id = 'abort:a1') =>
  graph.nodes.find((n) => n.id === id) as Extract<Graph['nodes'][number], { kind: 'abort' }>;

describe('specToGraph: abort listener worked example', () => {
  const spec = parse(WORKED) as AgentSpecV2;
  const graph = specToGraph(spec);

  it('gives the card its title, scope chip, rows and in-only ports', () => {
    const node = abortNode(graph);
    expect(ABORT_VIEW.title(node, graph)).toBe('Cancel on Webhook');
    expect(ABORT_VIEW.chip?.(node)).toBe('queued + running');
    expect(ABORT_VIEW.rows(node)).toEqual([
      { k: 'when', v: "event.action == 'closed'" },
      { k: 'match', v: 'event.pr == run.event.pr' },
    ]);
    expect(ABORT_VIEW.ports).toStrictEqual({ in: true, out: false });
  });
});

describe('connectNodes: trigger → abort', () => {
  const listener = { id: 'a1', triggerId: 't3', when: 'w', match: 'm', scope: 'both' };

  it('rewires triggerId to the dragged channel trigger', () => {
    const g = graphOf([listener], [WEBHOOK, CHANNEL]);
    const result = connectNodes(g, 'trigger:t4', 'abort:a1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((abortNode(result.graph).data as AbortNodeData).item.triggerId).toBe('t4');
      const ids = deriveEdges(result.graph).map((e) => e.id);
      expect(ids).toContain('cancels:trigger:t4->abort:a1');
      expect(ids).not.toContain('cancels:trigger:t3->abort:a1');
    }
  });
});

describe('abortRules.validate', () => {
  const valid = { id: 'a1', triggerId: 't3', when: 'w', match: 'm', scope: 'both' };

  it('flags empty when and match expressions', () => {
    const g = graphOf([{ ...valid, when: '', match: ' ' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('abort:a1', 'Write when an event should cancel runs', 'abortListeners[0].when'),
      error('abort:a1', 'Write how to match the run to cancel', 'abortListeners[0].match'),
    ]);
  });

  it('leaves the listener with the no-trigger error when its trigger is removed', () => {
    const g = removeNode(graphOf([valid], [WEBHOOK, CHANNEL]), 'trigger:t3');
    // No cascade delete: the listener stays and reports the missing trigger.
    expect(g.nodes.some((n) => n.id === 'abort:a1')).toBe(true);
    expect(validateGraph(g)).toStrictEqual([
      error('abort:a1', "There is no trigger 't3'", 'abortListeners[0].triggerId'),
    ]);
  });
});
