import { describe, it, expect } from 'vitest';
import type { Cassette } from '../testing/cassette';
import type { Message } from '../providers';
import { compareTrajectories, diffTrajectories, trajectoryOf, type Trajectory } from './drift';

type Entry = Cassette['entries'][number];

const request: Entry['request'] = { model: 'm', messages: [], tools: [], temperature: null, maxTokens: null };

function toolStep(calls: Array<[string, string]>, totalTokens = 10): Entry {
  return {
    kind: 'generate',
    request,
    response: {
      text: '',
      finishReason: 'tool_calls',
      usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens },
      toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: args } })),
    },
  };
}

const stop = (totalTokens = 5): Entry => ({
  kind: 'generate',
  request,
  response: { text: 'done', finishReason: 'stop', usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens } },
});

describe('diffTrajectories', () => {
  const base: Trajectory = trajectoryOf({ entries: [toolStep([['lookup', '{"id":"42"}'], ['refund', '{"id":"42"}']]), stop()] });

  it('ignores token (cost) drift unless asked for it', () => {
    const pricier = trajectoryOf({ entries: [toolStep([['lookup', '{"id":"42"}'], ['refund', '{"id":"42"}']], 900), stop()] });
    expect(diffTrajectories(base, pricier)).toEqual([]);
    expect(diffTrajectories(base, pricier, { usage: true })).toEqual([{ field: 'tokens', committed: '15', current: '905' }]);
  });
});

describe('compareTrajectories', () => {
  const transcript = (callId: string, args: string, result: string): Message[] => [
    { role: 'user', content: 'refund order 42' },
    { role: 'assistant', content: '', toolCalls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: args } }] },
    { role: 'tool', content: result, toolCallId: callId, toolName: 'lookup' },
    { role: 'assistant', content: 'Done.' },
  ];

  it('matches transcripts that differ only in call ids and argument key order', () => {
    const diff = compareTrajectories(transcript('a', '{"id":42,"x":1}', 'ok'), transcript('b', '{"x":1,"id":42}', 'ok'));
    expect(diff.divergedAt).toBeUndefined();
    expect(diff.drift).toEqual([]);
    expect(diff.a).toEqual([
      { text: '', tools: [{ id: 'a', name: 'lookup', args: '{"id":42,"x":1}', result: 'ok' }] },
      { text: 'Done.', tools: [] },
    ]);
  });
});
