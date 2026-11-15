import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { GenerateOptions, LLMProvider } from '../providers';

describe('createAgent modelSettings', () => {

  it("does not override a wrapping provider's injected maxTokens with an undefined one", async () => {
    const model = mockModel(['Hi.']);
    const capped: LLMProvider = { ...model, generate: (options: GenerateOptions) => model.generate({ maxTokens: 2500, ...options }) };
    await createAgent({ provider: capped }).send('Hello');

    expect(model.calls[0].maxTokens).toBe(2500);
  });

  it("sends the agent's settings on every call, a call's own merged over them", async () => {
    const model = mockModel([{ toolCalls: [{ name: 'echo', args: {} }] }, 'one', 'two'], { onExhausted: 'repeat-last' });
    const agent = createAgent({
      provider: model,
      tools: [defineTool({ name: 'echo', description: 'Echo', input: z.object({}), execute: async () => 'ok' })],
      modelSettings: { maxTokens: 1024, temperature: 0.2, stop: ['END'] },
    });

    await agent.send('Hello');
    await agent.send('Again', { modelSettings: { temperature: 0, seed: 7 } });
    await agent.stream('Streamed', { modelSettings: { maxTokens: 64 } }).result;

    expect(model.calls.map((call) => ({ maxTokens: call.maxTokens, temperature: call.temperature, stop: call.stop, seed: call.seed }))).toEqual([
      { maxTokens: 1024, temperature: 0.2, stop: ['END'], seed: undefined },
      { maxTokens: 1024, temperature: 0.2, stop: ['END'], seed: undefined },
      { maxTokens: 1024, temperature: 0, stop: ['END'], seed: 7 },
      { maxTokens: 64, temperature: 0.2, stop: ['END'], seed: undefined },
    ]);
  });
});

describe('modelSettings validation', () => {
  const invalid = (error: unknown) => error as { code?: string; field?: string; message: string };

  it.each([
    [{ maxTokens: 1.5 }, 'modelSettings.maxTokens', 'whole number >= 1'],
    [{ presencePenalty: Number.NaN }, 'modelSettings.presencePenalty', 'must be a number'],
    [{ seed: 0.5 }, 'modelSettings.seed', 'whole number'],
    [{ stop: 'END' }, 'modelSettings.stop', 'array of strings'],
    [{ toolChoice: 'always' }, 'modelSettings.toolChoice', "'auto', 'required', 'none'"],
  ])('createAgent rejects %j with LOUSHO_CONFIG_INVALID naming the key', (modelSettings, field, text) => {
    let thrown: unknown;
    try {
      createAgent({ provider: mockModel(['x']), modelSettings: modelSettings as never });
    } catch (error) {
      thrown = error;
    }
    expect(invalid(thrown).code).toBe('LOUSHO_CONFIG_INVALID');
    expect(invalid(thrown).field).toBe(field);
    expect(invalid(thrown).message).toContain(`createAgent: '${field}'`);
    expect(invalid(thrown).message).toContain(text);
  });

  it('accepts the range ends and undefined keys', () => {
    expect(() =>
      createAgent({
        provider: mockModel(['x']),
        modelSettings: { temperature: 2, topP: 0, maxTokens: 1, frequencyPenalty: -2, presencePenalty: 2, seed: -3, stop: [], toolChoice: { type: 'function', function: { name: 't' } } },
      })
    ).not.toThrow();
    expect(() => createAgent({ provider: mockModel(['x']), modelSettings: { temperature: undefined } })).not.toThrow();
  });
});
