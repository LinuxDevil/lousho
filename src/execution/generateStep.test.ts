import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';

describe('a provider error compacted once keeps its classification', () => {
  it('a Retry-After past backoff.maxMs fails at once with retryAfterMs, statusCode and category through createAgent', async () => {
    const { APICallError } = await import('ai');
    let calls = 0;
    const provider = {
      name: 'openai',
      defaultModel: 'gpt-4o-mini',
      generate: async () => {
        calls++;
        throw new APICallError({
          message: 'Too Many Requests',
          url: 'https://api.openai.com/v1/responses',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'retry-after': '120' },
          isRetryable: true,
        });
      },
      stream: async () => {
        throw new Error('not used');
      },
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => [],
    };
    const error = await createAgent({ provider, instructions: 'x', retry: { maxRetries: 2 } })
      .send('hi')
      .catch((caught: unknown) => caught);

    expect(calls).toBe(1);
    expect(error).toMatchObject({
      code: 'LOUSHO_PROVIDER_RATE_LIMITED',
      compacted: { category: 'rate-limit', retryable: true, statusCode: 429, retryAfterMs: 120_000, providerName: 'openai' },
    });
  });
});
