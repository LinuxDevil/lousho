/**
 * A `toolCall` argument that is exactly one `{{name}}` (or `$name`)
 * passes the variable's value, not its text. Running a createAgent()
 * agent in a flow (through a tool), and `step` nodes, which do not run.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AgentFlow, EditorStep } from '../types/flow';
import { FlowExecutor } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';

function flowOf(root: EditorStep): AgentFlow {
  return { code: 'args', name: 'Args', flow: root };
}

function run(root: EditorStep, toolRegistry: ToolRegistry, variables: Record<string, unknown>) {
  return FlowExecutor.execute(flowOf(root), { agent: { name: 'flow-agent' }, provider: new MockLLMProvider({ name: 'mock' }), toolRegistry, variables });
}

describe('toolCall arguments', () => {
  const seen: unknown[] = [];
  const toolRegistry = new ToolRegistry();
  toolRegistry.register('typed', {
    displayName: 'Typed',
    tool: {
      description: 'Takes typed arguments',
      parameters: z.object({ n: z.number(), flag: z.boolean().optional(), tags: z.array(z.string()).optional(), label: z.string().optional() }),
      execute: async (args: unknown) => {
        seen.push(args);
        return 'ok';
      },
    },
  });

  it('still interpolates mixed strings as text, and keeps a $ string with no such variable', async () => {
    seen.length = 0;
    const result = await run(
      { type: 'toolCall', tool: 'typed', arguments: { n: '{{n}}', label: 'n is {{n}}, costs $price' } },
      toolRegistry,
      { n: 5 }
    );
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ n: 5, label: 'n is 5, costs $price' }]);

    seen.length = 0;
    await run({ type: 'toolCall', tool: 'typed', arguments: { n: 1, label: '$USD' } }, toolRegistry, {});
    expect(seen).toEqual([{ n: 1, label: '$USD' }]);
  });
});
