/**
 * `ExecuteOptions.onRunEnd` is called exactly once per run,
 * however the run ends.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, type ExecuteOptions } from './AgentExecutor';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, type MockTurn } from '../testing';
import type { AgentConfig } from '../types';

const ping = defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: () => 'pong' });
const gated = defineTool({ name: 'gated', description: 'Gated', input: z.object({}), needsApproval: true, execute: () => 'ok' });

function options(script: MockTurn[], tools: DefinedTool[] = [ping, gated]) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(tools);
  const agent: AgentConfig = { id: 'a', name: 'Agent', prompt: 'p', tools: Object.fromEntries(tools.map((t) => [t.name, { tool: t.name }])) };
  const onRunEnd = vi.fn<Parameters<NonNullable<ExecuteOptions['onRunEnd']>>, void | Promise<void>>();
  return { agent, provider: mockModel(script), toolRegistry, input: 'go', onRunEnd } satisfies ExecuteOptions;
}

describe('ExecuteOptions.onRunEnd', () => {

  it('is called once per stream() run, also with sub-agents (no background task: no backgroundTasks)', async () => {
    const run = options(['hi']);
    const researcher = createAgent({ provider: mockModel([]), description: 'Researches' });
    const stream = AgentExecutor.stream({ ...run, subagents: { researcher } });
    for await (const event of stream) void event;
    const result = await stream.result;
    expect(run.onRunEnd).toHaveBeenCalledTimes(1);
    expect(run.onRunEnd).toHaveBeenCalledWith({ result });
    expect(result.backgroundTasks).toBeUndefined();
  });
});
