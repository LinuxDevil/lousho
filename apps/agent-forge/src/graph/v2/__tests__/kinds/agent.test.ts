import { describe, expect, it } from 'vitest';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function graphOf(over: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return specToGraph({
    version: 2,
    name: 'a',
    model: 'mock/mock-1',
    instructions: 'x',
    ...over,
  } as AgentSpecV2);
}

function inlineGraph(inlineOver: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return graphOf({
    subagents: {
      r: {
        inline: {
          name: 'r',
          description: 'd',
          model: 'mock/mock-1',
          instructions: 'x',
          ...inlineOver,
        },
      },
    },
  });
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

describe('agentRules.validate: root agent', () => {
  it.each<[Record<string, unknown>, string, string]>([
    [{ instructions: { file: '' } }, 'The agent needs instructions', 'instructions'],
  ])('spec %j → "%s" at "%s"', (over, message, fieldPath) => {
    expect(validateGraph(graphOf(over))).toStrictEqual([error('agent', message, fieldPath)]);
  });
});

describe('agentRules.validate: inline subagent', () => {

  it('maps field problems to the inline spec path', () => {
    expect(validateGraph(inlineGraph({ name: 'bad!', model: 'x' }))).toStrictEqual([
      error('sub:r', 'The name can use letters, digits, space, dot, dash or underscore', 'subagents.r.inline.name'),
      error('sub:r', 'Pick a model', 'subagents.r.inline.model'),
    ]);
  });

  it('nests the spec path for a subagent inside a subagent', () => {
    const graph = graphOf({
      subagents: {
        a: {
          inline: {
            name: 'a',
            description: 'd',
            model: 'mock/mock-1',
            instructions: 'x',
            subagents: {
              b: { inline: { name: 'b', model: 'mock/mock-1', instructions: 'x' } },
            },
          },
        },
      },
    });
    expect(validateGraph(graph)).toStrictEqual([
      error('sub:a/sub:b', 'A subagent needs a description', 'subagents.a.inline.subagents.b.inline.description'),
      {
        nodeId: 'sub:a/sub:b',
        severity: 'warning',
        message: "This subagent is deeper than the agent's max subagent depth (1)",
        fieldPath: 'subagents.a.inline.subagents.b.inline',
      },
    ]);
  });
});
