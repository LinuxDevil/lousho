import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, type ExecuteOptions } from './AgentExecutor';
import { startBudget, type RunLimits } from './budget';
import { ToolRegistry } from '../tools';
import { defineTool } from '../tools/defineTool';
import type { AgentConfig } from '../types';
import type { RunUsage } from '../models/usage';
import { mockModel, type MockTurn } from '../testing';
import { createAgent } from '../createAgent';
import { MemorySessionStore } from '../session';

let echoRuns = 0;
const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({}),
  execute: async () => {
    echoRuns++;
    return 'echoed';
  },
});

const agent: AgentConfig = { id: 'a', name: 'Agent', tools: { echo: { tool: 'echo' } } };
const registry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.registerMany([echo]);
  return r;
};
const callEcho = (inputTokens: number, outputTokens: number): MockTurn => ({
  toolCalls: [{ name: 'echo' }],
  usage: { inputTokens, outputTokens },
});
// gpt-4o-mini: $0.15 / $0.60 per million input / output tokens.
const priced = (script: MockTurn[]) => mockModel(script, { defaultModel: 'gpt-4o-mini', onExhausted: 'repeat-last' });
const run = (limits: RunLimits, script: MockTurn[], extra: Partial<ExecuteOptions> = {}) =>
  AgentExecutor.execute({ agent, input: 'go', provider: priced(script), toolRegistry: registry(), limits, ...extra });

afterEach(() => {
  echoRuns = 0;
  vi.useRealTimers();
});

describe('limits', () => {

  it('maxDurationMs aborts an in-flight model call', async () => {
    vi.useFakeTimers();
    const hanging: MockTurn = (request) =>
      new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(request.signal?.reason)));
    const pending = run({ maxDurationMs: 5_000 }, [callEcho(10, 10), hanging]);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toEqual({ limit: 'maxDurationMs', value: 5_000, max: 5_000, scope: 'run' });
    expect(result.steps).toBe(2);
  });
});

describe('session limits', () => {
  it('maxCostUsd holds across turns, from the persisted usage', async () => {
    // Each call: (1000 * 0.15 + 1000 * 0.6) / 1e6 = 0.00075
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    const provider = priced([{ text: 'one', usage }, { toolCalls: [{ name: 'echo' }], usage }]);
    const agent = createAgent({ provider, tools: [echo] });
    const store = new MemorySessionStore();
    const limits = { maxCostUsd: 0.0012 };

    const first = await agent.session({ id: 's1', store, limits }).send('first');
    expect(first.finishReason).toBe('stop');

    const second = await agent.session({ id: 's1', store, limits }).send('second');
    expect(second.finishReason).toBe('budget-exceeded');
    expect(second.budget).toMatchObject({ limit: 'maxCostUsd', max: 0.0012, scope: 'session' });
    expect(second.budget?.value).toBeCloseTo(0.0015, 10);
    expect(second.usage.costUsd).toBeCloseTo(0.00075, 10);
    expect(echoRuns).toBe(0);

    // A later turn stops before calling the model.
    const calls = provider.calls.length;
    const third = await agent.session({ id: 's1', store, limits }).send('third');
    expect(third).toMatchObject({ finishReason: 'budget-exceeded', steps: 0 });
    expect(provider.calls.length).toBe(calls);
    const saved = (await store.load('s1'))!;
    expect(saved.at(-1)?.metadata?.sessionUsage).toMatchObject({ totalTokens: 4000, steps: 2 });
  });
});

describe('unknown cost under maxCostUsd', () => {
  it('warns once that the cost limit cannot be enforced', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const budget = startBudget({ maxCostUsd: 1 })!;
    const usage: RunUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: undefined, modelCalls: 1, estimated: false, promptTokens: 1, completionTokens: 1, byModel: {} };
    expect(budget.check(usage, 1)).toBeUndefined();
    budget.check(usage, 2);
    budget.dispose();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('maxCostUsd');
    warn.mockRestore();
  });
});
