import { describe, it, expect } from 'vitest';
import type { AgentEventUsage } from './agentEvents';
import { emptyRunUsage, fromEventUsage, measureUsage, mergeDelegatedUsage, recordStepUsage, restoreRunUsage } from './runUsage';

const event = (inputTokens: number, outputTokens: number, extra: Partial<AgentEventUsage> = {}): AgentEventUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  promptTokens: inputTokens,
  completionTokens: outputTokens,
  estimated: false,
  ...extra,
});

describe('remote sub-agent usage helpers', () => {

  it("flags the lead's cost partial when a remote call sent no cost", () => {
    const run = emptyRunUsage();
    recordStepUsage(run, { model: 'gpt-4o-mini', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, estimated: false });
    mergeDelegatedUsage(run, fromEventUsage(event(10, 5, { costUsd: 0.25 }), 'remote:r'));
    mergeDelegatedUsage(run, fromEventUsage(event(10, 5), 'remote:r'));
    expect(run.byModel['remote:r']).toMatchObject({ costUsd: 0.25, costPartial: true });
    expect(run.costPartial).toBe(true);
    expect(run.costUsd).toBeGreaterThan(0.25);
  });
});

describe('provider-reported cost', () => {
  const generated = (costUsd?: number) => ({ text: 'x', finishReason: 'stop' as const, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, costUsd } });

  it('totals reported costs for a model the registry does not know, and keeps them through a checkpoint', () => {
    const run = emptyRunUsage();
    for (let i = 0; i < 3; i++) recordStepUsage(run, measureUsage('some/unpriced-model', [], generated(2)));
    expect(run.costUsd).toBe(6);
    expect(run.byModel['some/unpriced-model'].costUsd).toBe(6);
    expect(restoreRunUsage(structuredClone(run)).costUsd).toBe(6);
  });
});
