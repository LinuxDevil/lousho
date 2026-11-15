/**
 * A `send()` / `stream()` call's own `maxSteps` and
 * `instructions` (appended to the agent's), validated like createAgent's.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { textOf } from '../providers/content';
import type { Message } from '../providers/llm';
import type { MockRequest } from '../testing';

const ping = defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: async () => 'pong' });
const systemOf = (messages: readonly Message[] | MockRequest['messages']) => (messages as readonly Message[]).filter((message) => message.role === 'system').map((message) => textOf(message));

describe('per-call maxSteps', () => {
  it("a call's maxSteps replaces the agent's for that run only", async () => {
    const model = mockModel([{ toolCalls: [{ name: 'ping' }] }], { onExhausted: 'repeat-last' });
    const agent = createAgent({ provider: model, tools: [ping], maxSteps: 10 });

    const short = await agent.send('go', { maxSteps: 2 });
    expect(short.finishReason).toBe('max-steps');
    expect(model.calls).toHaveLength(2);

    model.reset();
    const long = await agent.send('go');
    expect(long.finishReason).toBe('max-steps');
    expect(model.calls).toHaveLength(10);
  });

  it.each([0,])('rejects maxSteps %s with LOUSHO_CONFIG_INVALID before any model call', async (maxSteps) => {
    const model = mockModel(['x']);
    const agent = createAgent({ provider: model });
    await expect(agent.send('go', { maxSteps })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', field: 'maxSteps' });
    expect(() => agent.stream('go', { maxSteps })).toThrow(/send: 'maxSteps' must be a whole number >= 1/);
    expect(model.calls).toHaveLength(0);
  });
});

describe('per-call instructions', () => {

  it('stream() takes them too, and a non-string is rejected with LOUSHO_CONFIG_INVALID', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({ provider: model, instructions: 'Base.' });

    await agent.stream('hi', { instructions: 'Be brief.' }).result;
    expect(systemOf(model.calls[0].messages)).toEqual(['Base.\n\nBe brief.']);

    await expect(agent.send('hi', { instructions: 42 as never })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', field: 'instructions' });
  });
});
