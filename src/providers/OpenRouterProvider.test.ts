/**
 * OpenRouter Provider Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenRouterProvider, OpenRouterProviderConfig } from './OpenRouterProvider';
import { createAgent } from '../createAgent';

describe('OpenRouterProvider', () => {
  let config: OpenRouterProviderConfig;

  beforeEach(() => {
    config = {
      name: 'openrouter',
      apiKey: 'test-api-key',
      defaultModel: 'openai/gpt-3.5-turbo',
      siteUrl: 'https://example.com',
      siteName: 'Test Site',
    };
  });

  describe('model catalog', () => {
    // OpenRouter's GET /models is a public endpoint: it answers 200 with the
    // live catalog even for an invalid API key, so these tests stub fetch
    // instead of depending on the network and on today's catalog contents.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should return fallback models when API fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      ));
      const provider = new OpenRouterProvider({
        name: 'openrouter',
        apiKey: 'invalid-key',
      });

      const models = await provider.getModels();
      expect(models).toBeInstanceOf(Array);
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain('openai/gpt-4o');
      expect(models).toContain('anthropic/claude-sonnet-4.5');
    });

    it('should return model ids from the API when it succeeds', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'a/model-1' }, { id: 'b/model-2' }] }))
      );
      vi.stubGlobal('fetch', fetchMock);
      const provider = new OpenRouterProvider(config);

      expect(await provider.getModels()).toEqual(['a/model-1', 'b/model-2']);
      expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: 'Bearer test-api-key', 'HTTP-Referer': 'https://example.com', 'X-Title': 'Test Site' },
      });
    });
  });

  describe('request path', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('an agent run without a key fails with LOUSHO_PROVIDER_MISSING_API_KEY, not a failed request', async () => {
      vi.stubEnv('OPENROUTER_API_KEY', '');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      try {
        const agent = createAgent({ provider: new OpenRouterProvider({ defaultModel: 'openai/gpt-4o-mini' } as OpenRouterProviderConfig) });
        await expect(agent.send('hi')).rejects.toMatchObject({ code: 'LOUSHO_PROVIDER_MISSING_API_KEY', message: expect.stringMatching(/OPENROUTER_API_KEY/) });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    /**
     * One generate() against a stubbed fetch answering `status` with `body`;
     * returns the error generate() rejected with.
     */
    async function errorOf(status: number, body: string) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status, statusText: 'status text' })));
      const provider = new OpenRouterProvider({ ...config, maxRetries: 0 });
      return provider
        .generate({ messages: [{ role: 'user', content: 'hi' }], model: 'openai/gpt-4o-mini' })
        .then(
          () => {
            throw new Error('generate() unexpectedly resolved');
          },
          (error: unknown) => error as Error
        );
    }

    it('a 401 keeps the body\'s auth explanation on the thrown error', async () => {
      const error = await errorOf(401, JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }));
      expect(error.message).toContain('No auth credentials found');
    });

    it('a non-JSON error body still rejects (status text, nothing to keep)', async () => {
      const error = await errorOf(502, 'bad gateway');
      expect(error).toBeInstanceOf(Error);
    });

    it("keeps the upstream provider's own message (error.metadata.raw) on the thrown error", async () => {
      // What OpenRouter returns when the upstream provider rejects the call:
      // "Provider returned error", with the upstream body verbatim in
      // metadata.raw (the generic message alone
      // hid the real cause).
      const error = await errorOf(
        400,
        JSON.stringify({
          error: {
            message: 'Provider returned error',
            code: 400,
            metadata: {
              raw: JSON.stringify({
                error: { message: "Invalid schema for response_format 'r': 'required' is required to be supplied", type: 'invalid_request_error' },
              }),
              provider_name: 'OpenAI',
            },
          },
        })
      );
      expect(error.message).toContain('Provider returned error');
      expect(error.message).toContain("Invalid schema for response_format 'r'");
    });
  });
});

describe('OpenRouterProvider reported cost', () => {
  it("fills usage.costUsd from the response's usage.cost", async () => {
    const body = {
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0123 },
    };
    const provider = new OpenRouterProvider({ apiKey: 'k', defaultModel: 'anthropic/claude-haiku-4.5', fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, costUsd: 0.0123 });
  });
});

describe('OpenRouterProvider prompt-cache usage', () => {
  it("reads the response's cache reads and writes into usage", async () => {
    const body = {
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5000, completion_tokens: 5, total_tokens: 5005, prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 900 } },
    };
    const provider = new OpenRouterProvider({ apiKey: 'k', defaultModel: 'anthropic/claude-haiku-4.5', fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.usage).toMatchObject({ promptTokens: 5000, cachedInputTokens: 4000, cacheWriteTokens: 900 });
  });
});
