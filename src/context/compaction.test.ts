import { describe, it, expect, vi } from 'vitest';
import {
  compactMessages,
  createCompactionHook,
  pruneToolResultsStrategy,
  
} from './compaction';
import type { GenerateOptions, Message } from '../providers';
import { textOf } from '../providers';
import { estimateTokens } from '../models';
import { HookRegistry } from '../execution/hooks';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

/** system, user, then `rounds` of assistant tool call + its (large) result. */
function transcript(rounds: number, firstUser = 'start'): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: firstUser },
  ];
  for (let i = 1; i <= rounds; i++) {
    const id = `call_${i}`;
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }],
    });
    messages.push({ role: 'tool', toolCallId: id, toolName: 'search', content: `${i}:${BIG}` });
  }
  return messages;
}

const isMarker = (m: Message) => /^\[pruned: search\(\{\}\) result, \d+ chars; already read\]$/.test(textOf(m));

/** Every assistant tool call is followed by a tool message answering it. */
function expectValidTranscript(messages: Message[]): void {
  messages.forEach((message, index) => {
    for (const call of message.toolCalls ?? []) {
      const answer = messages.slice(index + 1).find((m) => m.role === 'tool' && m.toolCallId === call.id);
      expect(answer, `result for ${call.id}`).toBeDefined();
    }
  });
}

describe('pruneToolResultsStrategy / compactMessages', () => {
  it('replaces old tool results with a marker and keeps the protected tail intact and in order', async () => {
    const original = transcript(10);
    const result = await compactMessages(original, { protectedTokens: 3_000, strategy: pruneToolResultsStrategy() });

    expect(result.messages).toHaveLength(original.length);
    expect(result.messages.map((m) => m.role)).toEqual(original.map((m) => m.role));
    expect(result.messages.map((m) => m.toolCallId)).toEqual(original.map((m) => m.toolCallId));

    const firstKept = result.messages.findIndex((m, i) => i > 1 && m === original[i] && m.role === 'tool');
    // Everything from the first kept result on is the original tail, untouched and in order...
    expect(result.messages.slice(firstKept)).toEqual(original.slice(firstKept));
    expect(estimateTokens(original.slice(firstKept + 1))).toBeLessThanOrEqual(3_000);
    // ...and every older result is a marker.
    const older = result.messages.slice(0, firstKept).filter((m) => m.role === 'tool');
    expect(older.length).toBeGreaterThan(0);
    expect(older.every(isMarker)).toBe(true);
    expect(result.prunedToolCallIds).toEqual(older.map((m) => m.toolCallId));
    expect(result.messages[3].content).toBe(`[pruned: search({}) result, ${original[3].content.length} chars; already read]`);

    expect(result.tokensBefore).toBe(estimateTokens(original));
    expect(result.tokensAfter).toBe(estimateTokens(result.messages));
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore / 2);
    expectValidTranscript(result.messages);
  });
});

function request(messages: Message[], model = 'compaction-test-model'): GenerateOptions {
  return { model, messages };
}

describe('compaction request size and context window', () => {
  const messages = () => transcript(4);

  async function preGenerate(hook: ReturnType<typeof createCompactionHook>, req: GenerateOptions) {
    const hooks = new HookRegistry();
    hooks.register(hook);
    await hooks.runPreGenerate({ messages: req.messages, request: req });
    return hooks;
  }

  it('reserveOutputTokens lowers the threshold to contextWindow - reserve, never raises it', async () => {
    const tokens = estimateTokens(messages());
    const onCompaction = vi.fn();
    await preGenerate(createCompactionHook({ contextWindow: tokens + 100, thresholdPercent: 1, protectedTokens: 0, onCompaction }), request(messages()));
    expect(onCompaction).not.toHaveBeenCalled();
    await preGenerate(
      createCompactionHook({ contextWindow: tokens + 100, thresholdPercent: 1, reserveOutputTokens: 500, protectedTokens: 0, onCompaction }),
      request(messages())
    );
    expect(onCompaction).toHaveBeenCalledTimes(1);
    // A small reserve does not raise a lower thresholdPercent.
    onCompaction.mockClear();
    await preGenerate(
      createCompactionHook({ contextWindow: tokens * 2, thresholdPercent: 0.4, reserveOutputTokens: 1, protectedTokens: 0, onCompaction }),
      request(messages())
    );
    expect(onCompaction).toHaveBeenCalledTimes(1);
  });
});
