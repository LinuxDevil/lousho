import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SUMMARY_PROMPT,
  compactMessages,
  createCompactionHook,
  isPinned,
  pinMessage,
  summarizeStrategy,
  twoPhaseStrategy,
  type CompactionInfo,
  type CompactionStrategy,
} from './compaction';
import type { Message } from '../providers';
import { textOf } from '../providers';
import { estimateTokens, registerModel } from '../models';
import { HookRegistry } from '../execution/hooks';
import { mockModel } from '../testing';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

const call = (id: string, name = 'search') => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });

/** system, user, then `rounds` of assistant tool call + its (large) result. */
function transcript(rounds: number): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'start' },
  ];
  for (let i = 1; i <= rounds; i++) {
    messages.push({ role: 'assistant', content: '', toolCalls: [call(`call_${i}`)] });
    messages.push({ role: 'tool', toolCallId: `call_${i}`, toolName: 'search', content: `${i}:${BIG}` });
  }
  return messages;
}

/** Every tool call has a later result, and every result answers an earlier call. */
function expectValidTranscript(messages: Message[]): void {
  messages.forEach((message, index) => {
    for (const c of message.toolCalls ?? []) {
      const answer = messages.slice(index + 1).find((m) => m.role === 'tool' && m.toolCallId === c.id);
      expect(answer, `result for ${c.id}`).toBeDefined();
    }
    if (message.role === 'tool') {
      const asked = messages.slice(0, index).some((m) => m.toolCalls?.some((c) => c.id === message.toolCallId));
      expect(asked, `call for ${message.toolCallId}`).toBe(true);
    }
  });
}

const summaryOf = (text: string): Message => ({ role: 'user', content: `[Conversation summary]\n${text}` });

describe('summarizeStrategy', () => {
  it('replaces the prefix with one summary message and keeps the system prompt and the tail intact', async () => {
    const summarizer = mockModel(['The user asked for searches; results 1-8 were read.']);
    const original = transcript(10);
    const result = await compactMessages(original, {
      protectedTokens: 2_100,
      strategy: summarizeStrategy({ model: summarizer, maxSummaryTokens: 500 }),
    });

    // The tail (the last two assistant turns with their results) is the original, untouched.
    expect(result.messages).toEqual([original[0], summaryOf('The user asked for searches; results 1-8 were read.'), ...original.slice(-4)]);
    expect(result.messages[0]).toBe(original[0]);
    result.messages.slice(2).forEach((m, i) => expect(m).toBe(original[original.length - 4 + i]));
    expect(result.summary).toBe('The user asked for searches; results 1-8 were read.');
    expect(result.tokensBefore).toBe(estimateTokens(original));
    expect(result.tokensAfter).toBe(estimateTokens(result.messages));
    expectValidTranscript(result.messages);

    // One focused summary call over the folded messages only.
    expect(summarizer.calls).toHaveLength(1);
    const [request] = summarizer.calls;
    expect(request.maxTokens).toBe(500);
    expect(request.messages[0]).toEqual({ role: 'system', content: DEFAULT_SUMMARY_PROMPT });
    expect(request.messages[1].content).toContain('user: start');
    expect(request.messages[1].content).toContain('[called search({})]');
    expect(request.messages[1].content).toContain('tool search: 8:');
    expect(request.messages[1].content).not.toContain('9:');
    expect(request.messages[1].content).not.toContain('You are helpful.');
  });

  it('falls back to pruning and reports the error when the summarizer fails, never throwing', async () => {
    const original = transcript(6);
    const pruned = await compactMessages(original, { protectedTokens: 0 });

    const failing = await compactMessages(original, {
      protectedTokens: 0,
      strategy: summarizeStrategy({ model: mockModel([{ error: new Error('rate limited') }]) }),
    });
    expect(failing.error?.message).toBe('rate limited');
    expect(failing.messages).toEqual(pruned.messages);
    expect(failing.prunedToolCallIds).toEqual(pruned.prunedToolCallIds);
    expect(failing.summary).toBeUndefined();

    const empty = await compactMessages(original, { protectedTokens: 0, strategy: summarizeStrategy({ model: mockModel(['  ']) }) });
    expect(empty.error?.message).toMatch(/empty summary/);
    expect(empty.messages).toEqual(pruned.messages);

    // A model spec that cannot be resolved is a failure too, not a crash.
    const unresolved = await compactMessages(original, { protectedTokens: 0, strategy: summarizeStrategy({ model: 'nosuch/model' }) });
    expect(unresolved.error).toBeInstanceOf(Error);
    expect(unresolved.messages).toEqual(pruned.messages);
  });
});

describe('pinned messages', () => {

  function withPins(): Message[] {
    const messages = transcript(8);
    messages[1] = pinMessage({ role: 'user', content: 'PINNED-GOAL' });
    messages[5] = pinMessage(messages[5]); // call_2's result
    return messages;
  }

  it('survive the two-phase strategy', async () => {
    const original = withPins();
    const result = await compactMessages(original, {
      protectedTokens: 0,
      contextWindow: 1_000,
      strategy: twoPhaseStrategy({ model: mockModel(['S']) }),
    });
    expect(result.summary).toBe('S');
    expect(result.messages.filter(isPinned)).toEqual([original[1], original[5]]);
    expectValidTranscript(result.messages);
  });
});

describe('twoPhaseStrategy', () => {
  it('only prunes when pruning gets under the threshold', async () => {
    const summarizer = mockModel([]);
    const original = transcript(10);
    // ~10,100 tokens; pruning all but the last result leaves ~1,200, under 90% of 2,000.
    const result = await compactMessages(original, {
      protectedTokens: 0,
      contextWindow: 2_000,
      strategy: twoPhaseStrategy({ model: summarizer }),
    });
    expect(summarizer.calls).toHaveLength(0);
    expect(result.summary).toBeUndefined();
    expect(result.prunedToolCallIds).toHaveLength(9);
    expect(result.tokensAfter).toBeLessThan(1_800);
  });
});

describe('async strategies in the hook', () => {
  async function runHook(strategy: CompactionStrategy, onCompaction: (info: CompactionInfo) => void) {
    const hooks = new HookRegistry();
    // A 1,200 window so a compacted transcript ([system, summary, last turn], ~1,030 tokens) lands under the threshold.
    hooks.register(createCompactionHook({ strategy, contextWindow: 1_200, protectedTokens: 0, onCompaction }));
    const messages = transcript(4);
    await hooks.runPreGenerate({ messages, request: { messages } });
    return messages;
  }

  it('leaves the run alone and reports the error when a strategy throws', async () => {
    const onCompaction = vi.fn<[CompactionInfo], void>();
    const throwing: CompactionStrategy = { name: 'broken', compact: async () => Promise.reject(new Error('bad strategy')) };
    const messages = await runHook(throwing, onCompaction);
    expect(messages).toEqual(transcript(4));
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(onCompaction.mock.calls[0][0]).toMatchObject({ strategy: 'broken', prunedToolCallIds: [] });
    expect(onCompaction.mock.calls[0][0].error?.message).toBe('bad strategy');
  });
});

describe('summarizeStrategy with a summarizer smaller than the history', () => {
  it('summarizes in parts that fit half the summarizer model\'s window, folding each into the summary so far', async () => {
    registerModel({ id: 'tiny-summarizer', provider: 'mock', contextWindow: 4_000 });
    const summarizer = mockModel(Array.from({ length: 20 }, (_, i) => `S${i + 1}`), { defaultModel: 'tiny-summarizer' });
    const original = transcript(10);
    const result = await compactMessages(original, { protectedTokens: 0, strategy: summarizeStrategy({ model: summarizer }) });

    expect(summarizer.calls.length).toBeGreaterThan(1);
    for (const call of summarizer.calls) expect(estimateTokens(call.messages as Message[])).toBeLessThan(4_000);
    expect(textOf(summarizer.calls[1].messages[1])).toMatch(/^\[Conversation summary\]\nS1\n/);
    expect(result.summary).toBe(`S${summarizer.calls.length}`);
    expectValidTranscript(result.messages);
  });
});
