/**
 * The built-in providers' `fetch` option, and one retry layer: a
 * provider instance wrapped by createAgent's `retry` sends each attempt once
 * (the 'ai' SDK's own retries are off), and `retry: false` sends one request.
 * No network: every request goes to the configured `fetch`.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { OllamaProvider } from './OllamaProvider';
import { installedAiMajor } from './aiMajor.testkit';
import type { LLMProvider } from './llm';

/** A `fetch` that answers every request with a 500. */
function failingFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ error: { message: 'engine crashed' } }), { status: 500 }));
}

/**
 * Whether the Ollama peer for the installed `ai` major resolves (`ollama-ai-provider` on
 * `ai` 4, `ollama-ai-provider-v2` on 6/7). The zod-3 peer jobs install neither, so the
 * provider would fail before reaching `fetch` there.
 */
const ollamaPeerInstalled: boolean = (() => {
  const peer = installedAiMajor === 4 ? 'ollama-ai-provider' : 'ollama-ai-provider-v2';
  try {
    createRequire(join(process.cwd(), 'package.json')).resolve(peer);
    return true;
  } catch {
    return false;
  }
})();

const providers: Array<[string, (fetch: typeof globalThis.fetch) => LLMProvider]> = [
  ['openai', (fetch) => new OpenAIProvider({ apiKey: 'k', fetch, maxRetries: 0 })],
  ['anthropic', (fetch) => new AnthropicProvider({ apiKey: 'k', fetch, maxRetries: 0 })],
  ['openrouter', (fetch) => new OpenRouterProvider({ apiKey: 'k', fetch, maxRetries: 0 })],
  ...(ollamaPeerInstalled
    ? ([['ollama', (fetch: typeof globalThis.fetch) => new OllamaProvider({ fetch, maxRetries: 0 })]] satisfies Array<
        [string, (fetch: typeof globalThis.fetch) => LLMProvider]
      >)
    : []),
];

describe('provider `fetch` option', () => {
  it.each(providers)('%s sends its model calls through the configured fetch', async (_name, create) => {
    const fetch = failingFetch();
    await expect(create(fetch).generate({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
