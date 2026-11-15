/**
 * A rejected summary is retried once the transcript has grown, the
 * summarizer's call is counted in the run (usage, span, budgets), the events
 * report the strategy that ran and the one applied, `createAgent({ compaction })`
 * takes `onCompaction`, and pruned results leave a stub naming the call.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import type { Message } from '../providers';
import { textOf } from '../providers';
import { defineTool } from '../tools/defineTool';
import type { AgentEvent, AgentEventOf } from '../execution';
import { mockModel } from '../testing';
import { compactMessages, type CompactionInfo } from './compaction';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

const fetchPage = defineTool({
  name: 'fetch_page',
  description: 'Fetch a page',
  input: z.object({ n: z.number() }),
  execute: async ({ n }) => `${n}:${BIG}`,
});

function transcript(rounds: number): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'start' },
  ];
  for (let i = 1; i <= rounds; i++) {
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call_${i}`, type: 'function', function: { name: 'search', arguments: `{"query":"q${i}"}` } }],
    });
    messages.push({ role: 'tool', toolCallId: `call_${i}`, toolName: 'search', content: `${i}:${BIG}` });
  }
  return messages;
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

describe('compaction events and options', () => {
  it('compaction.start and compaction.done name the same strategy; done adds appliedStrategy when the summary was rejected', async () => {
    const summarizer = mockModel(['x'.repeat(20_000)], { onExhausted: 'repeat-last' });
    const infos: CompactionInfo[] = [];
    // Big assistant texts cannot be pruned, so two-phase has to summarize.
    const wordy = (n: number) => ({ text: BIG, toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });
    const agent = createAgent({
      provider: mockModel([wordy(1), wordy(2), wordy(3), wordy(4), 'done']),
      tools: [fetchPage],
      maxSteps: 10,
      compaction: { contextWindow: 3_000, protectedTokens: 1_000, thresholdPercent: 0.5, summarizer, onCompaction: (info) => infos.push(info) },
    });
    const events: AgentEvent[] = [];
    const run = agent.stream('read four pages');
    for await (const event of run) events.push(event);
    await run.result;

    const starts = ofType(events, 'compaction.start');
    const dones = ofType(events, 'compaction.done');
    expect(dones.length).toBeGreaterThan(0);
    dones.forEach((done, i) => expect(done.strategy).toBe(starts[i].strategy));
    const rejected = dones.find((done) => done.error?.message.includes('did not compact'));
    expect(rejected).toMatchObject({ strategy: 'two-phase', appliedStrategy: 'prune-tool-results' });
    // The object form passes onCompaction through.
    expect(infos.find((info) => info.error)?.appliedStrategy).toBe('prune-tool-results');
  });
});

describe('pruned results leave a stub naming the call', () => {
  it('names the tool and its arguments and says the result was already seen', async () => {
    const { messages } = await compactMessages(transcript(3), { protectedTokens: 0, contextWindow: 100_000 });
    const stub = textOf(messages[3]);
    expect(stub).toMatch(/^\[pruned: search\(\{"query":"q1"\}\) result, \d+ chars/);
    expect(stub).toMatch(/already/);
    expect(stub.length).toBeLessThan(200);

    // Idempotent: a stub is not pruned again.
    const again = await compactMessages(messages, { protectedTokens: 0, contextWindow: 100_000 });
    expect(again.prunedToolCallIds).toEqual([]);

    // Long arguments are cut short.
    const long = transcript(2);
    long[2].toolCalls![0].function.arguments = JSON.stringify({ query: 'y'.repeat(1_000) });
    const cut = await compactMessages(long, { protectedTokens: 0, contextWindow: 100_000 });
    expect(textOf(cut.messages[3]).length).toBeLessThan(300);
  });
});
