/**
 * AiSdkProvider (shared 'ai'-SDK adapter base) Tests
 *
 * Mocks the 'ai' SDK's generateText/streamText (no live API key required)
 * and drives the shared generate()/stream() logic through concrete
 * providers: the call settings handed to the 'ai' SDK, finish-reason
 * mapping, tool conversion, and message conversion (shared by OpenRouter).
 * Runs on every `ai` major: where the call or result shape differs
 * (v4 `maxTokens`, `args`, `result`; v5+ `maxOutputTokens`, `input`, `output`)
 * the test asserts the installed major's shape, built with aiShapes.testkit.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

import { z as z4 } from 'zod/v4';
import { OpenAIProvider } from './OpenAIProvider';
import { MODEL_SETTING_KEYS } from '../execution/modelSettings';
import { installedAiMajor, itOnAiV4 } from './aiMajor.testkit';
import { mockUsage,  } from './aiShapes.testkit';

const isV4 = installedAiMajor === 4;
/** What the mocked `ai` calls report (the installed major's shape) and what the provider turns it into. */
const usage = mockUsage();
const providerUsage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

function textResult(finishReason: string) {
  return { text: 'ok', finishReason, usage, toolCalls: undefined };
}

describe('AiSdkProvider', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });

  describe('every modelSettings key reaches the AI SDK call', () => {
    const wireName: Record<string, string> = { maxTokens: isV4 ? 'maxTokens' : 'maxOutputTokens', stop: 'stopSequences' };
    const values: Record<(typeof MODEL_SETTING_KEYS)[number], unknown> = {
      temperature: 0.3,
      maxTokens: 12,
      topP: 0.8,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      stop: ['END'],
      seed: 7,
      toolChoice: 'required',
    };
    const tool = { type: 'function' as const, function: { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: {} } } };

    it.each(MODEL_SETTING_KEYS)('%s', async (key) => {
      generateTextMock.mockResolvedValue(textResult('stop'));
      const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', defaultModel: 'gpt-4o' });
      await provider.generate({ model: '', messages: [{ role: 'user', content: 'hi' }], tools: [tool], [key]: values[key] });
      expect(generateTextMock.mock.calls[0][0][wireName[key] ?? key]).toEqual(values[key]);
    });

    it('maps a named function to the SDK shape and drops toolChoice on a call without tools', async () => {
      generateTextMock.mockResolvedValue(textResult('stop'));
      const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', defaultModel: 'gpt-4o' });
      const toolChoice = { type: 'function' as const, function: { name: 'echo' } };
      await provider.generate({ model: '', messages: [{ role: 'user', content: 'hi' }], tools: [tool], toolChoice });
      await provider.generate({ model: '', messages: [{ role: 'user', content: 'hi' }], toolChoice: 'required' });
      expect(generateTextMock.mock.calls[0][0].toolChoice).toEqual({ type: 'tool', toolName: 'echo' });
      expect(generateTextMock.mock.calls[1][0].toolChoice).toBeUndefined();
    });
  });

  it('reports usage as-is, reads cache/reasoning tokens from provider metadata, and no usage when counts are NaN', async () => {
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    // v4 reports cache tokens in the provider metadata, v5+ in the usage details.
    generateTextMock.mockResolvedValue(
      isV4
        ? { ...textResult('stop'), providerMetadata: { openai: { cachedPromptTokens: 1, reasoningTokens: 'n/a' } } }
        : { ...textResult('stop'), usage: { ...usage, inputTokenDetails: { cacheReadTokens: 1 } } }
    );
    expect((await provider.generate({ model: '', messages: [] })).usage).toEqual({
      ...providerUsage,
      cachedInputTokens: 1,
    });

    // Anthropic's cache reads and writes. v4's @ai-sdk/anthropic leaves both out of
    // `promptTokens` (they are added back); v6/v7 count them in `inputTokens` already.
    generateTextMock.mockResolvedValue(
      isV4
        ? { ...textResult('stop'), providerMetadata: { anthropic: { cacheReadInputTokens: 40, cacheCreationInputTokens: 10 } } }
        : {
            ...textResult('stop'),
            usage: { inputTokens: 51, outputTokens: 2, totalTokens: 53, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 40, cacheWriteTokens: 10 } },
          }
    );
    expect((await provider.generate({ model: '', messages: [] })).usage).toEqual({
      promptTokens: 51,
      completionTokens: 2,
      totalTokens: 53,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
    });

    const nan = Number.NaN;
    generateTextMock.mockResolvedValue({
      ...textResult('stop'),
      usage: isV4 ? { promptTokens: nan, completionTokens: nan, totalTokens: nan } : { inputTokens: nan, outputTokens: nan, totalTokens: nan },
    });
    expect((await provider.generate({ model: '', messages: [] })).usage).toBeUndefined();
  });

  it('maps responseFormat to a JSON-mode experimental_output that leaves prompt and text alone', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });
    const schema = { type: 'object', properties: { a: { type: 'number' } } };

    await provider.generate({ messages: [] });
    await provider.generate({ messages: [], responseFormat: { type: 'json', schema } });

    const key = isV4 ? 'experimental_output' : 'output';
    expect(generateTextMock.mock.calls[0][0][key]).toBeUndefined();
    const output = generateTextMock.mock.calls[1][0][key];
    if (isV4) {
      expect(output.type).toBe('object');
      expect(output.responseFormat({ model: { supportsStructuredOutputs: true } })).toEqual({ type: 'json', schema });
      expect(output.responseFormat({ model: { supportsStructuredOutputs: false } })).toEqual({ type: 'json', schema: undefined });
      expect(output.injectIntoSystemPrompt({ system: undefined, model: {} })).toBeUndefined();
      expect(output.parsePartial({ text: '{"a"' })).toEqual({ partial: '{"a"' });
      expect(output.parseOutput({ text: 'raw' }, {})).toBe('raw');
    } else {
      expect(await output.responseFormat).toEqual({ type: 'json', schema });
      expect(await output.parsePartialOutput({ text: '{"a"' })).toEqual({ partial: '{"a"' });
      expect(await output.parseCompleteOutput({ text: 'raw' })).toBe('raw');
    }
  });

  itOnAiV4('sends a zod 4 tool schema to ai v4 as its JSON Schema', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });
    const parameters = z4.object({ q: z4.string() }) as unknown as Record<string, unknown>;

    await provider.generate({
      model: 'gpt-4',
      messages: [],
      tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters } }],
    });

    const { tools } = generateTextMock.mock.calls[0][0];
    expect(tools.search.parameters.jsonSchema).toMatchObject({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  });
});
