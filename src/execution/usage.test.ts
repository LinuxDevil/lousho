import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import { createAgent } from '../createAgent';
import { ToolRegistry } from '../tools';
import { defineTool } from '../tools/defineTool';
import type { AgentConfig } from '../types';
import { mockModel } from '../testing';
import { formatUsage, normalizeUsage } from '../models';
import { textOf } from '../providers';

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({}),
  execute: async () => 'echoed',
});

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'a',
  name: 'Agent',
  tools: { echo: { tool: 'echo' } },
  ...overrides,
});

const registry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.registerMany([echo]);
  return r;
};

const callEcho = { toolCalls: [{ name: 'echo' }] };

describe('run usage', () => {
  it('accumulates tokens, calls and cost across steps of a priced model', async () => {
    const provider = mockModel(
      [
        { ...callEcho, usage: { inputTokens: 1000, outputTokens: 200 } },
        { text: 'done', usage: { inputTokens: 1500, outputTokens: 300 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );

    const result = await AgentExecutor.execute({ agent: agent(), input: 'go', provider, toolRegistry: registry() });

    expect(result.usage).toMatchObject({
      inputTokens: 2500,
      outputTokens: 500,
      totalTokens: 3000,
      modelCalls: 2,
      estimated: false,
      // legacy aliases still work
      promptTokens: 2500,
      completionTokens: 500,
    });
    expect(result.usage.costUsd).toBeCloseTo((2500 * 0.15 + 500 * 0.6) / 1e6, 10);
    expect(result.usage.byModel).toEqual({
      'gpt-4o-mini': { inputTokens: 2500, outputTokens: 500, costUsd: result.usage.costUsd, calls: 2 },
    });
    expect(result.stepUsage).toEqual([
      expect.objectContaining({ step: 1, model: 'gpt-4o-mini', estimated: false, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }),
      expect.objectContaining({ step: 2, model: 'gpt-4o-mini', estimated: false, usage: { inputTokens: 1500, outputTokens: 300, totalTokens: 1800 } }),
    ]);
    expect(formatUsage(result.usage)).toBe('2,500 in / 500 out tokens · $0.0007 (2 model calls)');
  });

  it('sums cache reads and writes, and prices them at the cache rates', async () => {
    const provider = mockModel(
      [
        { ...callEcho, usage: { inputTokens: 5000, outputTokens: 10, cacheWriteTokens: 4800 } },
        { text: 'done', usage: { inputTokens: 5100, outputTokens: 10, cachedInputTokens: 4800 } },
      ],
      { defaultModel: 'claude-haiku-4-5' }
    );

    const result = await AgentExecutor.execute({ agent: agent(), input: 'go', provider, toolRegistry: registry() });

    expect(result.usage).toMatchObject({ inputTokens: 10100, cachedInputTokens: 4800, cacheWriteTokens: 4800 });
    // Step 1: 200 uncached at $1 + 4,800 written at $1.25; step 2: 300 uncached + 4,800 read at $0.10; 20 out at $5.
    const expected = (500 * 1 + 4800 * 1.25 + 4800 * 0.1 + 20 * 5) / 1e6;
    expect(result.usage.costUsd).toBeCloseTo(expected, 10);
    expect(result.stepUsage?.[1]).toMatchObject({ usage: { cachedInputTokens: 4800 }, costUsd: expect.closeTo((300 + 4800 * 0.1 + 50) / 1e6, 10) });
  });

  it('rolls a delegated child run up into the parent totals and exposes it as usage.delegated', async () => {
    const parentProvider = mockModel(
      [
        { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'sub', description: 'child task' } }], usage: { inputTokens: 10, outputTokens: 5 } },
        { text: 'done', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );
    const childProvider = mockModel(
      [
        { text: 'sub done', usage: { inputTokens: 100, outputTokens: 50 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );
    const child = createAgent({ provider: childProvider, description: 'Child agent' });

    const result = await AgentExecutor.execute({
      agent: agent(),
      input: 'go',
      provider: parentProvider,
      toolRegistry: registry(),
      subagents: { child },
    });

    expect(result.usage).toMatchObject({ inputTokens: 130, outputTokens: 60, totalTokens: 190, modelCalls: 3 });
    expect(result.usage.delegated).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      modelCalls: 1,
      runs: 1,
      estimated: false,
    });
    expect(result.usage.delegated?.costUsd).toBeCloseTo((100 * 0.15 + 50 * 0.6) / 1e6, 10);
    // the parent's own steps exclude the child
    expect(result.stepUsage).toHaveLength(2);
    // the model sees the child's answer text plus a small footer, not the usage breakdown
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(textOf(toolMessage!)).toContain('sub done');
    expect(textOf(toolMessage!)).toContain("[sub-agent 'child': 1 step(s), finish reason 'stop'");
  });
});

describe('normalizeUsage', () => {
  it('maps provider names, keeps cache/reasoning tokens when present, and rejects NaN or missing usage', () => {
    expect(normalizeUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedInputTokens: 4, reasoningTokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    });
    expect(normalizeUsage({ promptTokens: NaN, completionTokens: NaN, totalTokens: NaN })).toBeUndefined();
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({ promptTokens: 1, completionTokens: 2, totalTokens: NaN })?.totalTokens).toBe(3);
  });
});

describe('formatUsage', () => {
  it('formats singular calls, large costs and estimates', () => {
    const base = { inputTokens: 1234, outputTokens: 567, costUsd: 12.345, modelCalls: 1, estimated: false };
    expect(formatUsage(base)).toBe('1,234 in / 567 out tokens · $12.35 (1 model call)');
    expect(formatUsage({ ...base, costUsd: undefined, estimated: true })).toBe('~1,234 in / 567 out tokens (1 model call)');
  });
});
