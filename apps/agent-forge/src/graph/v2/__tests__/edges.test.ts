import { describe, expect, it } from 'vitest';

import { deriveEdges, globMatch } from '../edges';
import type { Graph, GraphNode, NodeKind } from '../types';

/** Minimal node factory: position and ids are irrelevant to edge derivation. */
function node(kind: NodeKind, id: string, owner: string | null, data: GraphNode['data']): GraphNode {
  return { id, kind, owner, position: { x: 0, y: 0 }, data } as GraphNode;
}

function graphOf(nodes: GraphNode[]): Graph {
  return { version: 2, nodes, emptySections: [], unplaced: [] };
}

const ROOT = node('agent', 'agent', null, {
  fields: { name: 'a', model: 'mock/mock-1', instructions: 'x' },
  extra: {},
});

describe('globMatch', () => {

  it('matches ? as exactly one character', () => {
    expect(globMatch('h?tp', 'http')).toBe(true);
    expect(globMatch('h?tp', 'htp')).toBe(false);
    expect(globMatch('h?tp', 'httpx')).toBe(false);
  });
});

describe('deriveEdges', () => {

  it('draws trigger -> abort cancels edges only when the trigger node exists', () => {
    const abort = node('abort', 'abort:a1', 'agent', {
      item: { id: 'a1', triggerId: 't1', when: 'true', match: 'true', scope: 'both' },
    });
    const withTrigger = graphOf([
      ROOT,
      node('trigger', 'trigger:t1', 'agent', { item: { id: 't1', type: 'chat' } }),
      abort,
    ]);
    expect(deriveEdges(withTrigger).map((e) => e.id)).toEqual([
      'starts:trigger:t1->agent',
      'cancels:trigger:t1->abort:a1',
    ]);
    expect(deriveEdges(graphOf([ROOT, abort]))).toEqual([]);
  });
});
