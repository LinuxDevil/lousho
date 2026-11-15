/**
 * The `reasoning` option as each built-in provider sends it, on `ai`
 * v7 (the `ai-v7` alias, `MockLanguageModelV4`: `providerOptions`) and on the
 * installed `ai` v4 (`MockLanguageModelV1`: `providerMetadata`); the
 * reasoning a model returns; and Anthropic's signed thinking sent back with
 * its tool-call turn.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { MockLanguageModelV1 } from 'ai/test';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider, Message } from './llm';
import type { AiSdkModule } from './aiSdkCompat';
import { itOnAiV4 } from './aiMajor.testkit';
import { reasoningProviderOptions, supportsReasoning } from './reasoning';

describe('supportsReasoning', () => {
  it('reports whether a provider/model pair is in a known reasoning family', () => {
    expect(supportsReasoning('anthropic', 'claude-sonnet-4-5')).toBe(true);
    expect(supportsReasoning('openai', 'gpt-4o')).toBe(false);
    expect(supportsReasoning('unknown', 'x')).toBe(false);
  });
});

type V7Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type V7Result = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type V4Options = Parameters<MockLanguageModelV1['doGenerate']>[0];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function useModel(provider: LLMProvider, model: unknown, ai?: AiSdkModule): void {
  if (ai) Object.assign(provider, { ai });
  vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue(model);
}

const v7Result = (content: V7Result['content'] = [{ type: 'text', text: 'ok' }]): V7Result => ({
  content,
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: 9, text: 2, reasoning: 7 },
  },
  warnings: [],
});

/** Runs `provider` on `ai` v7; returns the options the model got. */
function onV7(provider: LLMProvider, result = v7Result()): V7Options[] {
  const calls: V7Options[] = [];
  useModel(provider, new MockLanguageModelV4({ doGenerate: async (options) => (calls.push(options), result) }), aiV7);
  return calls;
}

/** Runs `provider` on the installed `ai` v4; returns the options the model got. */
function onV4(provider: LLMProvider, reasoning?: Array<{ type: 'text'; text: string; signature?: string }>): V4Options[] {
  const calls: V4Options[] = [];
  const model = new MockLanguageModelV1({
    doGenerate: async (options) => {
      calls.push(options);
      return { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 }, rawCall: { rawPrompt: null, rawSettings: {} }, reasoning };
    },
  });
  useModel(provider, model);
  return calls;
}

const user: Message[] = [{ role: 'user', content: 'Think about it.' }];

describe('reasoning options per provider', () => {

  it('sends nothing for `none`, a model outside the known reasoning families, or an unknown provider, unless forced', () => {
    expect(reasoningProviderOptions('openai', 'o3', 'none')).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'gpt-4o', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'o1-mini', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'gpt-5-chat-latest', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('anthropic', 'claude-3-5-sonnet-latest', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('ollama', 'llama3.1', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('mock', 'o3', { effort: 'high', force: true })).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'my-finetune', { effort: 'low', force: true })).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(reasoningProviderOptions('openai', 'o3', undefined)).toBeUndefined();
  });

  itOnAiV4('ai v4: sends them as providerOptions (the model gets providerMetadata); Ollama warns once and sends nothing', async () => {
    const anthropic = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls = onV4(anthropic);
    await anthropic.generate({ messages: user, model: 'claude-3-7-sonnet-latest', reasoning: { budgetTokens: 3000 } });
    expect(calls[0]!.providerMetadata).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 3000 } } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ollama = new OllamaProvider({ maxRetries: 0 });
    const ollamaCalls = onV4(ollama);
    await ollama.generate({ messages: user, model: 'deepseek-r1', reasoning: 'high' });
    await ollama.generate({ messages: user, model: 'deepseek-r1', reasoning: 'high' });
    expect(ollamaCalls[0]!.providerMetadata).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('OpenRouter adds `reasoning` to the request body for a reasoning model only', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: 'stub' } }), { status: 400 });
    }));
    const provider = new OpenRouterProvider({ apiKey: 'k', maxRetries: 0 });
    await expect(provider.generate({ messages: user, model: 'deepseek/deepseek-r1', reasoning: 'high' })).rejects.toThrow();
    await expect(provider.generate({ messages: user, model: 'qwen/qwen3-32b', reasoning: { budgetTokens: 2000 } })).rejects.toThrow();
    await expect(provider.generate({ messages: user, model: 'openai/gpt-4o-mini', reasoning: 'high' })).rejects.toThrow();
    expect(bodies.map((body) => body.reasoning)).toEqual([{ effort: 'high' }, { max_tokens: 2000 }, undefined]);
    expect(bodies[0]!.model).toBe('deepseek/deepseek-r1');
  });
});

describe('reasoning returned and replayed', () => {
  const turn: Message = {
    role: 'assistant',
    content: '',
    reasoning: [{ text: 'I should look it up.', signature: 'sig-1' }, { text: '', redactedData: 'opaque' }],
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  const history: Message[] = [...user, turn, { role: 'tool', content: '"found"', toolCallId: 'call_1', toolName: 'lookup' }];

  it('ai v7: returns reasoning blocks with their signature, and sends them back first in the tool-call turn', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls = onV7(
      provider,
      v7Result([
        { type: 'reasoning', text: 'Hmm.', providerMetadata: { anthropic: { signature: 'sig-2' } } },
        { type: 'text', text: 'ok' },
      ])
    );
    const result = await provider.generate({ messages: history, model: 'claude-sonnet-4-5' });

    expect(result.reasoning).toEqual([{ text: 'Hmm.', signature: 'sig-2' }]);
    expect(result.usage?.reasoningTokens).toBe(7);
    expect(result.text).toBe('ok');
    expect(calls[0]!.prompt[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I should look it up.', providerOptions: { anthropic: { signature: 'sig-1' } } },
        { type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: 'opaque' } } },
        { type: 'tool-call', toolCallId: 'call_1' },
      ],
    });
  });

  itOnAiV4('ai v4: returns reasoning details as blocks, and sends signed thinking back as reasoning parts', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls = onV4(provider, [{ type: 'text', text: 'Hmm.', signature: 'sig-2' }]);
    const result = await provider.generate({ messages: history, model: 'claude-sonnet-4-5' });

    expect(result.reasoning).toEqual([{ text: 'Hmm.', signature: 'sig-2' }]);
    expect(calls[0]!.prompt[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I should look it up.', signature: 'sig-1' },
        { type: 'redacted-reasoning', data: 'opaque' },
        { type: 'tool-call', toolCallId: 'call_1' },
      ],
    });
  });
});
