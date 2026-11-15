/**
 * The 'ai'-SDK providers' stream() on `ai` v7, through the real
 * `ai` v7 (the `ai-v7` dev alias) and scripted `MockLanguageModelV4`
 * streams: a text reply, a tool call, an error mid-stream, and a tool loop
 * through `agent.stream()`, whose events are asserted with one helper on
 * `ai` v7 and on the installed `ai` (v4: `MockLanguageModelV1`; v7: the same
 * scripted `MockLanguageModelV4` streams, with the provider on its own `ai`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { z } from 'zod';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider, StreamChunk } from './llm';
import type { AiSdkModule } from './aiSdkCompat';

type V7Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];
type V7Part = V7Stream extends ReadableStream<infer P> ? P : never;
type V7CallOptions = Parameters<MockLanguageModelV4['doStream']>[0];

/** One scripted model step, written once for both majors. */
interface Step {
  text?: string[];
  toolCall?: { id: string; name: string; input: string };
  finish: 'stop' | 'tool-calls';
  usage: { input: number; output: number; cached: number; reasoning: number };
}

const usage = { input: 10, output: 5, cached: 4, reasoning: 2 };

function streamOf<P>(parts: P[]): ReadableStream<P> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** A step as `ai` v7 model parts: text in a text block, a tool call's input streamed in two deltas, then the whole call. */
function v7Parts(step: Step): V7Part[] {
  const parts: V7Part[] = [{ type: 'stream-start', warnings: [] }];
  if (step.text) {
    parts.push({ type: 'text-start', id: 't1' });
    for (const delta of step.text) parts.push({ type: 'text-delta', id: 't1', delta });
    parts.push({ type: 'text-end', id: 't1' });
  }
  if (step.toolCall) {
    const { id, name, input } = step.toolCall;
    const half = Math.floor(input.length / 2);
    parts.push(
      { type: 'tool-input-start', id, toolName: name },
      { type: 'tool-input-delta', id, delta: input.slice(0, half) },
      { type: 'tool-input-delta', id, delta: input.slice(half) },
      { type: 'tool-input-end', id },
      { type: 'tool-call', toolCallId: id, toolName: name, input }
    );
  }
  const { input, output, cached, reasoning } = step.usage;
  parts.push({
    type: 'finish',
    finishReason: { unified: step.finish, raw: step.finish },
    usage: {
      inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined },
      outputTokens: { total: output, text: output - reasoning, reasoning },
    },
  });
  return parts;
}

/** Give `provider` this model instead of its peer package's. */
function useModel(provider: LLMProvider, model: unknown): void {
  const target = provider as unknown as { createModel: (id: string) => Promise<unknown> };
  vi.spyOn(target, 'createModel').mockResolvedValue(model);
}

/**
 * Run `provider` on `ai` v7, one scripted model stream per call; returns the call options the model got.
 * `ai` is the `ai-v7` alias by default; pass `undefined` to leave the provider on the installed `ai`.
 */
function onV7(provider: LLMProvider, steps: Array<Step | V7Part[]>, ai: AiSdkModule | undefined = aiV7): V7CallOptions[] {
  const calls: V7CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      return { stream: streamOf(Array.isArray(step) ? step : v7Parts(step)) };
    },
  });
  if (ai) Object.assign(provider, { ai });
  useModel(provider, model);
  return calls;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const providers: Array<[string, () => LLMProvider]> = [
  ['openai', () => new OpenAIProvider({ name: 'openai', apiKey: 'k', maxRetries: 0 })],
  ['anthropic', () => new AnthropicProvider({ name: 'anthropic', apiKey: 'k', maxRetries: 0 })],
  ['ollama', () => new OllamaProvider({ name: 'ollama', maxRetries: 0 })],
  ['openrouter', () => new OpenRouterProvider({ name: 'openrouter', apiKey: 'k', maxRetries: 0 })],
];

const weatherTool = {
  type: 'function' as const,
  function: { name: 'get_weather', description: 'W', parameters: z.object({ city: z.string() }) },
};

const providerUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedInputTokens: 4, reasoningTokens: 2 };

describe.each(providers)('%s provider on ai v7: stream()', (_name, make) => {
  it('streams a text reply as text deltas, then the finish reason and usage', async () => {
    const provider = make();
    const calls = onV7(provider, [{ text: ['Hel', 'lo'], finish: 'stop', usage }]);

    const result = await provider.stream({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], maxTokens: 64 });

    expect(await collect(result.fullStream)).toEqual([
      { type: 'text-delta', textDelta: 'Hel' },
      { type: 'text-delta', textDelta: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: providerUsage },
    ]);
    expect(await collect(result.textStream)).toEqual(['Hel', 'lo']);
    expect(await result.text).toBe('Hello');
    expect(await result.usage).toEqual(providerUsage);
    expect(await result.finishReason).toBe('stop');
    expect(await result.toolCalls).toEqual([]);
    expect(calls[0]).toMatchObject({ maxOutputTokens: 64, prompt: [{ role: 'system', content: 'Be brief.' }, { role: 'user' }] });
  });

  it('streams a tool call once, from its streamed input and the whole call', async () => {
    const provider = make();
    const calls = onV7(provider, [
      { toolCall: { id: 'call_A', name: 'get_weather', input: '{"city":"Paris"}' }, finish: 'tool-calls', usage },
    ]);

    const result = await provider.stream({ messages: [{ role: 'user', content: 'Weather?' }], tools: [weatherTool] });

    const toolCall = { id: 'call_A', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } };
    expect(await collect(result.fullStream)).toEqual([
      { type: 'tool-call', toolCall },
      { type: 'finish', finishReason: 'tool-calls', usage: providerUsage },
    ]);
    expect(await result.toolCalls).toEqual([toolCall]);
    expect(calls[0]!.tools).toMatchObject([{ type: 'function', name: 'get_weather', inputSchema: { properties: { city: { type: 'string' } } } }]);
  });

  it('rejects the stream with the error a model reports mid-stream', async () => {
    const provider = make();
    const failure = new Error('connection reset');
    onV7(provider, [
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hal' },
        { type: 'error', error: failure },
      ],
    ]);
    const error = vi.spyOn(console, 'error');

    const result = await provider.stream({ messages: [{ role: 'user', content: 'hi' }] });
    const chunks: StreamChunk[] = [];
    const reading = (async () => {
      for await (const chunk of result.fullStream) chunks.push(chunk);
    })();

    await expect(reading).rejects.toBe(failure);
    expect(chunks).toEqual([{ type: 'text-delta', textDelta: 'Hal' }]);
    await expect(collect(result.textStream)).rejects.toBe(failure);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('stream() on ai v7: edge cases', () => {
  it('assembles a tool call from streamed input the model never sent whole, and reports no usage when there is none', async () => {
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', maxRetries: 0 });
    onV7(provider, [
      [
        { type: 'tool-input-start', id: 'call_B', toolName: 'get_weather' },
        { type: 'tool-input-delta', id: 'call_B', delta: '{"city":' },
        { type: 'tool-input-delta', id: 'call_B', delta: '"Rome"}' },
        { type: 'tool-input-end', id: 'call_B' },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'a thought' },
        { type: 'reasoning-end', id: 'r1' },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: {
            inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined },
          },
        },
      ],
    ]);

    const result = await provider.stream({ messages: [{ role: 'user', content: 'Weather?' }], tools: [weatherTool] });

    // Reasoning is reported as reasoning chunks, never as text.
    expect(await collect(result.fullStream)).toEqual([
      { type: 'reasoning-delta', textDelta: 'a thought' },
      { type: 'reasoning-end', reasoning: {} },
      { type: 'tool-call', toolCall: { id: 'call_B', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } } },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    expect(await result.usage).toBeUndefined();
  });

  it('rejects the stream with the abort reason, and the final values it leaves unread are no unhandled rejections', async () => {
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', maxRetries: 0 });
    onV7(provider, [{ text: ['never'], finish: 'stop', usage }]);
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    controller.abort(reason);

    const result = await provider.stream({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal });

    await expect(collect(result.fullStream)).rejects.toBe(reason);
    await expect(result.text).rejects.toBe(reason);
  });
});
