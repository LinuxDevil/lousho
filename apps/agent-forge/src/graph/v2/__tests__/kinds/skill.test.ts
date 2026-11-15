import { describe, expect, it } from 'vitest';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, SkillRef } from '../../specTypes';
import type { Graph, Problem, SkillNodeData } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(skills: SkillRef[]): ReturnType<typeof specToGraph> {
  return specToGraph(specOf({ skills }));
}

function nodeById(graph: Graph, id: string): SkillNodeData {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node '${id}'`);
  return node.data as SkillNodeData;
}

function problem(nodeId: string, severity: 'error' | 'warning', message: string, fieldPath: string): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

describe('skillRules.validate', () => {
  it.each([
    ['/abs/skills', 'skill:skills'],
    ['../skills', 'skill:skills'],
    ['a/../skills', 'skill:skills'],
  ])('rejects the folder path %j', (dir, nodeId) => {
    const graph = graphOf([{ dir }]);
    expect(validateGraph(graph)).toStrictEqual([
      error(nodeId, 'Use a folder inside the agent folder', 'skills[0].dir'),
    ]);
  });

  it('does not flag same-named skills of different owners', () => {
    const graph = specToGraph(
      specOf({
        skills: [{ registry: 'changelog' }],
        subagents: {
          a: {
            inline: {
              name: 'a',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              skills: [{ registry: 'changelog' }],
            },
          },
        },
      }),
    );
    expect(validateGraph(graph)).toStrictEqual([]);
  });
});

describe('skillRules.duplicateData', () => {
  it('gives an inline copy a fresh <name>-copy name', () => {
    const g = graphOf([{ inline: { name: 'tone', description: 'd', content: 'c' } }]);
    const first = duplicateNode(g, 'skill:tone');
    expect(first.nodeId).toBe('skill:tone-copy');
    expect(nodeById(first.graph, 'skill:tone-copy').item).toStrictEqual({
      inline: { name: 'tone-copy', description: 'd', content: 'c' },
    });
    const second = duplicateNode(first.graph, 'skill:tone');
    expect(second.nodeId).toBe('skill:tone-copy-2');
  });

  it('keeps a dir copy\'s name, so the duplicate-name error shows on both', () => {
    const g = graphOf([{ dir: 'skills/tone' }]);
    const r = duplicateNode(g, 'skill:tone');
    expect(r.nodeId).toBe('skill:tone#2');
    expect(nodeById(r.graph, 'skill:tone#2').item).toStrictEqual({ dir: 'skills/tone' });
    expect(validateGraph(r.graph)).toStrictEqual([
      error('skill:tone', "Two skills are named 'tone'", 'skills[0]'),
      error('skill:tone#2', "Two skills are named 'tone'", 'skills[1]'),
    ]);
  });
});
