import { describe, expect, it } from 'vitest';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(guardrails: Record<string, unknown>[], over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ guardrails, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

describe('guardrailRules.validate', () => {

  it.each([
    ['deny-topics', 'topics', { topics: [] }],
  ] as const)('requires the %s option %s (options %j)', (name, option, options) => {
    const g = graphOf([{ id: 'g1', name, options }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', `This guardrail needs the '${option}' option`, `guardrails[0].options.${option}`),
    ]);
  });

  it('refuses a parallel check that rewrites', () => {
    const g = graphOf([
      { id: 'g1', name: 'prompt-injection', on: 'input', runInParallel: true, onTripped: 'rewrite' },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      // prompt-injection cannot rewrite at all, and a parallel check cannot rewrite either.
      error('guard:g1', "'prompt-injection' cannot rewrite; use 'block'", 'guardrails[0].onTripped'),
      error('guard:g1', 'A parallel check cannot rewrite', 'guardrails[0].onTripped'),
    ]);
  });

  it('refuses a parallel check whose options.action rewrites', () => {
    const g = graphOf([
      { id: 'g1', name: 'prompt-injection', on: 'input', runInParallel: true, options: { action: 'rewrite' } },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', 'A parallel check cannot rewrite', 'guardrails[0].options.action'),
    ]);
  });

  it('refuses onTripped and options.action disagreeing', () => {
    const g = graphOf([{ id: 'g1', name: 'pii', onTripped: 'block', options: { action: 'rewrite' } }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', 'set either onTripped or options.action, not both', 'guardrails[0].options.action'),
    ]);
  });

  it('refuses a regex pattern that does not compile', () => {
    const g = graphOf([{ id: 'g1', name: 'regex', options: { pattern: '[' } }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', 'The pattern is not a valid regular expression', 'guardrails[0].options.pattern'),
    ]);
  });
});
