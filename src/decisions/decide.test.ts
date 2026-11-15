import { describe, expect, it } from 'vitest';
import { decide, type DecideOptions } from './decide';

const ok = (answers: unknown) =>
  new Response(JSON.stringify({ answers }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const fakeFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => impl as typeof fetch;

const base: Omit<DecideOptions, 'questions'> = { input: 'I was charged twice.', apiKey: 'sk-test' };

describe('decide()', () => {
  it('POSTs model, input and questions to {baseURL}/decisions with a bearer token', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetch = fakeFetch(async (url, init) => {
      seen = { url: String(url), init };
      return ok([{ type: 'predicate', name: 'spam', probability: 0.8 }]);
    });

    await decide({
      ...base,
      fetch,
      questions: [{ type: 'predicate', name: 'spam', instructions: 'Is this spam?' }],
    });

    expect(seen?.url).toBe('https://api.openai.com/v1/decisions');
    expect(seen?.init.method).toBe('POST');
    expect((seen?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(seen?.init.body));
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input).toBe('I was charged twice.');
    expect(body.questions).toHaveLength(1);
  });

  it('throws LOUSHO_PROVIDER_MISSING_API_KEY without a key', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        decide({ input: 'x', questions: [{ type: 'predicate', name: 'p', instructions: 'y' }] }),
      ).rejects.toMatchObject({ code: 'LOUSHO_PROVIDER_MISSING_API_KEY' });
    } finally {
      if (saved) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('maps 429 to LOUSHO_PROVIDER_RATE_LIMITED and other failures to REQUEST_FAILED', async () => {
    const err = (status: number) =>
      fakeFetch(async () => new Response('rate limited', { status }));
    const q = [{ type: 'predicate', name: 'p', instructions: 'y' }] as const;

    await expect(decide({ ...base, fetch: err(429), questions: [...q] })).rejects.toMatchObject({
      code: 'LOUSHO_PROVIDER_RATE_LIMITED',
    });
    await expect(decide({ ...base, fetch: err(500), questions: [...q] })).rejects.toMatchObject({
      code: 'LOUSHO_PROVIDER_REQUEST_FAILED',
    });
  });

  it('throws LOUSHO_PROVIDER_REQUEST_FAILED on a malformed response', async () => {
    const fetch = fakeFetch(async () => ok([{ type: 'choice', name: 'c' }]));
    await expect(
      decide({
        ...base,
        fetch,
        questions: [{ type: 'choice', name: 'c', instructions: 'x', choices: [{ value: 'a' }] }],
      }),
    ).rejects.toMatchObject({ code: 'LOUSHO_PROVIDER_REQUEST_FAILED' });
  });

  it('maps abort to LOUSHO_OPERATION_TIMEOUT', async () => {
    const fetch = fakeFetch(async (_u, init) => {
      await new Promise((_r, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
      return ok([]);
    });
    await expect(
      decide({ ...base, fetch, timeoutMs: 10, questions: [{ type: 'predicate', name: 'p', instructions: 'y' }] }),
    ).rejects.toMatchObject({ code: 'LOUSHO_OPERATION_TIMEOUT' });
  });

  it('rejects invalid question sets before any request', async () => {
    const fetch = fakeFetch(async () => {
      throw new Error('should not be called');
    });
    const mk = (questions: DecideOptions['questions']) => decide({ ...base, fetch, questions });
    await expect(mk([])).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    await expect(
      mk([
        { type: 'predicate', name: 'a', instructions: 'x' },
        { type: 'predicate', name: 'a', instructions: 'y' },
      ]),
    ).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    await expect(
      mk([{ type: 'score', name: 's', instructions: 'x', levels: [{ label: 'only' }] }]),
    ).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });
});
