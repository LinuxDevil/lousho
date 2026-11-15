import { describe, expect, it } from 'vitest';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(over: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return specToGraph(specOf(over));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

describe('handoffRules.validate', () => {

  it('flags two handoffs resolving to the same tool name', () => {
    const graph = graphOf({
      handoffs: [{ agent: 'billing' }, { agent: 'refunds', toolName: 'transfer_to_billing' }],
    });
    expect(validateGraph(graph)).toStrictEqual([
      error(
        'handoff:billing',
        "Two handoffs use the tool name 'transfer_to_billing'",
        'handoffs[0].toolName',
      ),
      error(
        'handoff:refunds',
        "Two handoffs use the tool name 'transfer_to_billing'",
        'handoffs[1].toolName',
      ),
    ]);
  });
});
