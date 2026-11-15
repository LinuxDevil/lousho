import { describe, it, expect } from 'vitest';
import {
  createCompactionHook,
  markContextOverflow,
} from './compaction';
import type { GenerateOptions, Message } from '../providers';
import { textOf } from '../providers';
import { HookRegistry } from '../execution/hooks';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

/** system, user, then `rounds` of assistant tool call + its (large) result. */
function transcript(rounds: number): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'start' },
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

const isMarker = (m: Message) => /^\[pruned: [\s\S]* result, \d+ chars[\s\S]*\]$/.test(textOf(m));

function request(messages: Message[], model = 'compaction-test-model'): GenerateOptions {
  return { model, messages };
}

async function runHook(hook = createCompactionHook(), req = request(transcript(10))) {
  const hooks = new HookRegistry();
  hooks.register(hook);
  const before = req.messages;
  await hooks.runPreGenerate({ messages: req.messages, request: req });
  expect(req.messages).toBe(before); // rewritten in place, never replaced
  return req;
}

describe('server-side context overflow', () => {

  it('keeps the smaller window for the rest of the run', async () => {
    const req = request(transcript(10));
    markContextOverflow(req.messages, 8_192);
    // A later, larger report must not loosen the known ceiling.
    markContextOverflow(req.messages, 16_384);
    const result = await runHook(createCompactionHook({ contextWindow: 32_768, protectedTokens: 1_000 }), req);
    expect(result.messages.filter(isMarker).length).toBeGreaterThan(0);
  });
});
