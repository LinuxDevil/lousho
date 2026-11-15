import { describe, expect, it } from 'vitest';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, MemorySpec } from '../../specTypes';
import type { Graph, MemoryNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(memory: MemorySpec[]): ReturnType<typeof specToGraph> {
  return specToGraph(specOf({ memory }));
}

function nodeById(graph: Graph, id: string): MemoryNodeData {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node '${id}'`);
  return node.data as MemoryNodeData;
}

function problem(nodeId: string, severity: 'error' | 'warning', message: string, fieldPath: string): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

function warning(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'warning', message, fieldPath);
}

/** A valid entry the cases below break one field at a time. */
const BASE: MemorySpec = { name: 'notes', scope: 'session', provider: { type: 'in-memory' } };

describe('memoryRules.validate', () => {

  it('rejects an empty metadata key', () => {
    const graph = graphOf([{ ...BASE, scope: { metadataKey: '' } }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('memory:notes', 'Enter the metadata key', 'memory[0].scope.metadataKey'),
    ]);
  });

  it('rejects a file provider with an empty folder', () => {
    const graph = graphOf([{ ...BASE, provider: { type: 'file', dir: '' } }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('memory:notes', 'Enter the folder for memory files', 'memory[0].provider.dir'),
    ]);
  });

  it('rejects a sqlite-vector provider without an embedder', () => {
    const graph = graphOf([{ ...BASE, provider: { type: 'sqlite-vector', embedder: '' } }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('memory:notes', 'Pick an embedding model', 'memory[0].provider.embedder'),
    ]);
  });

  it('reports the name error before the warnings of one entry', () => {
    const graph = graphOf([{ name: 'bad name', scope: 'global', provider: { type: 'in-memory' }, itemKey: 'k' }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('memory:bad name', 'The memory name can use letters, digits, dash or underscore', 'memory[0].name'),
      warning('memory:bad name', 'An item key needs an item schema', 'memory[0].itemKey'),
      warning('memory:bad name', 'In-memory items are lost when Studio restarts', 'memory[0].provider'),
    ]);
  });
});

describe('memoryRules.duplicateData', () => {
  it('gives a copy a fresh <name>-copy slot name', () => {
    const g = graphOf([{ name: 'notes', scope: 'global', provider: { type: 'in-memory' } }]);
    const first = duplicateNode(g, 'memory:notes');
    expect(first.nodeId).toBe('memory:notes-copy');
    expect(nodeById(first.graph, 'memory:notes-copy').item).toStrictEqual({
      name: 'notes-copy',
      scope: 'global',
      provider: { type: 'in-memory' },
    });
    const second = duplicateNode(first.graph, 'memory:notes');
    expect(second.nodeId).toBe('memory:notes-copy-2');
    expect(nodeById(second.graph, 'memory:notes-copy-2').item.name).toBe('notes-copy-2');
  });
});
