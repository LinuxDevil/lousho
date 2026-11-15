/**
 * Exhausting `maxSteps` while the model still wants to continue
 * reports `finishReason: 'max-steps'` (on the result and on `run.done`).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { createAgent } from '../createAgent';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, MockTurn } from '../testing';
import { AgentConfig } from '../types';

const ping = defineTool({
  name: 'ping',
  description: 'Ping',
  input: z.object({}),
  execute: async () => 'pong',
});

function registryOf(tools: DefinedTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(tools);
  return registry;
}

function options(tools: DefinedTool[], script: MockTurn[]) {
  const config: AgentConfig['tools'] = {};
  for (const t of tools) config[t.name] = { tool: t.name };
  const agent: AgentConfig = { id: 'a', name: 'Agent', prompt: 'p', tools: config };
  return { agent, provider: mockModel(script, { onExhausted: 'repeat-last' }), toolRegistry: registryOf(tools), input: 'go' };
}

async function events(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of run) all.push(event);
  return all;
}

const alwaysPing: MockTurn = { toolCalls: [{ name: 'ping', id: 'call_ping' }] };

describe("finishReason 'max-steps'", () => {

  it('the finish event and run.done (AgentExecutor.stream) carry max-steps', async () => {
    const finishReasons: Array<string | undefined> = [];
    const run = AgentExecutor.stream({
      ...options([ping], [alwaysPing]),
      maxSteps: 2,
      onAgentEvent: (e) => {
        if (e.type === 'run.done') finishReasons.push(e.finishReason);
      },
    });
    const all = await events(run);
    expect(all.find((e) => e.type === 'run.done')).toMatchObject({ type: 'run.done', finishReason: 'max-steps' });
    expect((await run.result).finishReason).toBe('max-steps');
    expect(finishReasons).toEqual(['max-steps']);
  });
});

describe('limits.maxSteps and maxSteps validation', () => {
  const answer = z.object({ answer: z.string() });
  const script = () =>
    mockModel([(req) => (req.tools?.length && req.toolChoice !== 'none' ? { toolCalls: [{ name: 'ping' }] } : '{"answer":"from gathered data"}')], {
      onExhausted: 'repeat-last',
    });

  it('limits.maxSteps exhaustion with output makes the forced answer call and keeps result.budget', async () => {
    const model = script();
    const result = await createAgent({ provider: model, tools: [ping], output: answer, limits: { maxSteps: 1 } }).send('go');

    expect(result.object).toEqual({ answer: 'from gathered data' });
    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toMatchObject({ limit: 'maxSteps', max: 1 });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].toolChoice).toBe('none');
  });
});
