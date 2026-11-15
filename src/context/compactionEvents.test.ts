/**
 * `compaction.start` / `compaction.done` stream events and
 * `createAgent({ compaction, hooks })`. No network: scripted `mockModel`s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type CreateAgentConfig } from '../createAgent';
import { LLMProviderRegistry } from '../providers/llm';
import { textOf } from '../providers';
import { defineTool } from '../tools/defineTool';
import type { AgentEvent, AgentEventOf, AgentRun } from '../execution';
import { mockModel } from '../testing';
import { type CompactionStrategy } from './compaction';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens
const HUGE = 'y'.repeat(150_000); // about 37,500 tokens

const fetchPage = (size: string) =>
  defineTool({
    name: 'fetch_page',
    description: 'Fetch a page',
    input: z.object({ n: z.number() }),
    execute: async ({ n }) => `${n}:${size}`,
  });

const pageCall = (n: number) => ({ toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);
const SUMMARIZING = { contextWindow: 3_000, protectedTokens: 1_000, thresholdPercent: 0.5 };

/**
 * A model turn pairing a big assistant text (unprunable) with a fetch call
 * whose result is tiny, so pruning alone stays over the 1,500-token threshold
 * of SUMMARIZING but a summary lands under it.
 */
const wordyCall = (n: number) => ({ text: BIG, toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });

/** An agent whose run fills its transcript with assistant text, not tool results. */
function wordyAgentWith(compaction: CreateAgentConfig['compaction']) {
  const model = mockModel([wordyCall(1), wordyCall(2), wordyCall(3), wordyCall(4), 'done']);
  const agent = createAgent({ provider: model, tools: [fetchPage('ok')], maxSteps: 10, compaction });
  return { agent, model };
}

function agentWith(compaction: CreateAgentConfig['compaction'], size = BIG, extra: Partial<CreateAgentConfig> = {}) {
  const model = mockModel([pageCall(1), pageCall(2), pageCall(3), pageCall(4), 'done']);
  const agent = createAgent({ provider: model, tools: [fetchPage(size)], maxSteps: 10, compaction, ...extra });
  return { agent, model };
}

describe('compaction events when nothing can be compacted', () => {
  it('reports one unchanged compaction.done per transcript, not a start/done pair on every step', async () => {
    // Every request is over the threshold, but the transcript is assistant text and tiny results: nothing to prune.
    const { agent } = wordyAgentWith({ ...SUMMARIZING, strategy: undefined });
    const run = agent.stream('go');
    const events = await collect(run);
    expect((await run.result).text).toBe('done');
    const starts = ofType(events, 'compaction.start');
    const dones = ofType(events, 'compaction.done');
    expect(starts).toHaveLength(1);
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ unchanged: true, prunedToolCallIds: [] });
    expect(dones[0].tokensAfter).toBe(dones[0].tokensBefore);
  });
});

describe('compaction stream events', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('createAgent({ compaction: true }) compacts a long transcript with the defaults', async () => {
    const { agent, model } = agentWith(true, HUGE, { maxToolResultChars: Infinity }); // uncapped, so the results fill the window
    const run = agent.stream('read four pages');
    const events = await collect(run);
    const result = await run.result;

    expect(result.text).toBe('done');
    const [started] = ofType(events, 'compaction.start');
    const [done] = ofType(events, 'compaction.done');
    expect(started).toMatchObject({ strategy: 'prune-tool-results', contextWindow: 128_000 });
    expect(done.prunedToolCallIds.length).toBeGreaterThan(0);
    expect(done.tokensAfter).toBeLessThan(started.thresholdTokens);
    const markers = result.messages.filter((m) => m.role === 'tool' && textOf(m).startsWith('[pruned: fetch_page('));
    expect(markers.map((m) => m.toolCallId)).toEqual(done.prunedToolCallIds);
    expect(model.calls).toHaveLength(5);
  });

  it("resolves a 'provider/model' summarizer with the provider registry", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const summarizer = mockModel(['A summary.'], { onExhausted: 'repeat-last' });
    const create = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(summarizer);
    const { agent } = wordyAgentWith({ ...SUMMARIZING, summarizer: 'openai/gpt-4o-mini' });

    const events = await collect(agent.stream('read four pages'));

    expect(create.mock.calls[0]?.[0]).toBe('openai');
    expect(summarizer.calls.length).toBeGreaterThan(0);
    expect(ofType(events, 'compaction.done').some((e) => e.summary)).toBe(true);
  });
});

describe('createAgent({ hooks, compaction }) options', () => {

  it('rejects a summarizer together with a strategy, and a threshold outside (0, 1]', () => {
    const strategy: CompactionStrategy = {
      name: 's',
      compact: (input) => ({ messages: input.messages, tokensBefore: 0, tokensAfter: 0, prunedToolCallIds: [] }),
    };
    const provider = mockModel(['x']);
    expect(() => createAgent({ provider, compaction: { strategy, summarizer: 'openai/gpt-4o-mini' } })).toThrow(
      /both 'strategy' and 'summarizer'/
    );
    expect(() => createAgent({ provider, compaction: { thresholdPercent: 2 } })).toThrow(RangeError);
  });
});
