/**
 * Provider resilience wrappers: withRetry, withFallback,
 * resilientProvider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError, JSONParseError, TypeValidationError } from 'ai';
import type { GenerateOptions, LLMProvider, StreamChunk } from './llm';
import { MockLLMProvider } from './mock';
import { isRetryableProviderError, resilientProvider, withFallback, withRetry } from './resilience';
import { CompactedLLMProviderError, compactProviderError } from '../execution/errors';

function apiError(statusCode: number, headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    isRetryable: statusCode >= 500 || statusCode === 429,
  });
}

/** A provider that throws `failures` in order (one per call, generate or stream), then answers `reply`. */
function flaky(failures: unknown[], name = 'flaky', reply = `${name} ok`) {
  const inner = new MockLLMProvider({ responses: [reply], defaultModel: `${name}-model` });
  const calls: GenerateOptions[] = [];
  const next = (call: GenerateOptions) => {
    calls.push(call);
    if (failures.length > 0) {
      throw failures.shift();
    }
  };
  const provider: LLMProvider = {
    name,
    defaultModel: inner.defaultModel,
    generate: async (call) => (next(call), inner.generate(call)),
    stream: async (call) => (next(call), inner.stream(call)),
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [`${name}-model`],
  };
  return { provider, calls };
}

/**
 * A provider whose `stream()` resolves, then fails inside the stream the way
 * a streaming provider reports a request error: the fullStream's first read
 * throws, or its first chunk is an `error` chunk.
 */
function flakyStream(failures: unknown[], name = 'flaky', reply = `${name} ok`) {
  const inner = new MockLLMProvider({ responses: [reply], defaultModel: `${name}-model` });
  const calls: GenerateOptions[] = [];
  const provider: LLMProvider = {
    name,
    defaultModel: inner.defaultModel,
    generate: (call) => inner.generate(call),
    stream: async (call) => {
      calls.push(call);
      const failure = failures.shift();
      if (failure === undefined) return inner.stream(call);
      if (failure === 'error-chunk') {
        return {
          fullStream: (async function* (): AsyncGenerator<StreamChunk> {
            yield { type: 'error', error: apiError(503) };
          })(),
          textStream: (async function* (): AsyncGenerator<string> {
            yield* [];
          })(),
          text: Promise.reject(apiError(503)),
          usage: Promise.resolve(undefined),
          finishReason: Promise.resolve('error'),
          toolCalls: Promise.resolve([]),
        };
      }
      return {
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          throw failure;
        })(),
        textStream: (async function* (): AsyncGenerator<string> {
          throw failure;
        })(),
        text: Promise.reject(failure),
        usage: Promise.reject(failure),
        finishReason: Promise.reject(failure),
        toolCalls: Promise.reject(failure),
      };
    },
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [`${name}-model`],
  };
  return { provider, calls };
}

/**
 * A provider whose n-th stream() yields the n-th script: chunks in order, and
 * a thrown error where the script has an Error. Its `text` is `attempt <n>`.
 */
function scriptedStream(scripts: Array<Array<StreamChunk | Error>>) {
  const calls: GenerateOptions[] = [];
  const provider: LLMProvider = {
    name: 'scripted',
    generate: async () => ({ text: '', finishReason: 'stop' }),
    stream: async (call) => {
      calls.push(call);
      const script = scripts[calls.length - 1] ?? [];
      const failure = script.find((step): step is Error => step instanceof Error);
      return {
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          for (const step of script) {
            if (step instanceof Error) throw step;
            yield step;
          }
        })(),
        textStream: (async function* (): AsyncGenerator<string> {})(),
        text: failure ? Promise.reject(failure) : Promise.resolve(`attempt ${calls.length}`),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      };
    },
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [],
  };
  return { provider, calls };
}

/**
 * A provider whose stream() emits `gaps.length` text chunks, waiting `gaps[i]`
 * ms before chunk i, and ends the way a real fetch stream does on an abort:
 * by throwing the signal's reason.
 */
function pacedStream(gaps: number[]) {
  const calls: GenerateOptions[] = [];
  const provider: LLMProvider = {
    name: 'paced',
    generate: async () => ({ text: '', finishReason: 'stop' }),
    stream: async (call) => {
      calls.push(call);
      const wait = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          call.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(call.signal?.reason)), { once: true });
        });
      return {
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          for (const [index, gap] of gaps.entries()) {
            await wait(gap);
            yield { type: 'text-delta', textDelta: `w${index} ` };
          }
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        textStream: (async function* (): AsyncGenerator<string> {})(),
        text: Promise.resolve(''),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      };
    },
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [],
  };
  return { provider, calls };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The text of a collected stream's `text-delta` chunks. */
function textOf(chunks: StreamChunk[]): string {
  return chunks.map((chunk) => chunk.textDelta ?? '').join('');
}

const fast = { backoff: { initialMs: 1, jitter: false } };
const request: GenerateOptions = { messages: [{ role: 'user', content: 'hi' }] };

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry', () => {

  it('classifies errors like the executor does, including compacted ones', () => {
    expect(isRetryableProviderError(apiError(500))).toBe(true);
    expect(isRetryableProviderError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableProviderError(apiError(400))).toBe(false);
    expect(isRetryableProviderError(new Error('boom'))).toBe(false);
    const contextLength = new CompactedLLMProviderError(
      compactProviderError(new Error('maximum context length exceeded'))
    );
    expect(isRetryableProviderError(contextLength)).toBe(false);
  });

  it('classifies a malformed or cut-off provider response as retryable, bare or wrapped in a cause', () => {
    const parse = new JSONParseError({ text: '{"id":"x', cause: new SyntaxError('Unterminated string in JSON at position 8') });
    const validation = new TypeValidationError({ value: { bad: 1 }, cause: new Error('invalid chunk') });
    const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const terminated = new TypeError('terminated', { cause: socket });
    const bareTerminated = new TypeError('terminated');
    const wrap = (cause: unknown) => new Error('stream failed', { cause });

    for (const error of [parse, validation, socket, terminated, bareTerminated, new Error('Premature close')]) {
      expect(isRetryableProviderError(error)).toBe(true);
      expect(isRetryableProviderError(wrap(error))).toBe(true);
    }
    expect(isRetryableProviderError(Object.assign(new Error('x'), { name: 'AI_JSONParseError' }))).toBe(true);
    expect(isRetryableProviderError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableProviderError(new Error('boom', { cause: new Error('nope') }))).toBe(false);
  });

  it('reads retry-after-ms, and honors Retry-After on a 503', async () => {
    expect(compactProviderError(apiError(503, { 'retry-after-ms': '2000', 'retry-after': '9' })).retryAfterMs).toBe(2_000);
    expect(compactProviderError(apiError(503, { 'Retry-After': '2' })).retryAfterMs).toBe(2_000);
    expect(compactProviderError(apiError(429, { 'Retry-After-Ms': '250' })).retryAfterMs).toBe(250);
    expect(compactProviderError(apiError(500, { 'retry-after': '2' })).retryAfterMs).toBeUndefined();
  });

  it('retries a stream() whose first chunk is an error chunk', async () => {
    const { provider, calls } = flakyStream(['error-chunk']);

    const stream = await withRetry(provider, fast).stream(request);
    const chunks = await collect(stream.fullStream);

    expect(calls).toHaveLength(2);
    expect(textOf(chunks)).toBe('flaky ok');
  });

  it('retries a stream that fails after only an empty reasoning-end (LM Studio)', async () => {
    const { provider, calls } = scriptedStream([
      [{ type: 'reasoning-end' }, { type: 'error', error: apiError(500) }],
      [{ type: 'text-delta', textDelta: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const onRetry = vi.fn();

    const stream = await withRetry(provider, { ...fast, onRetry }).stream(request);
    const chunks = await collect(stream.fullStream);

    expect(calls).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(textOf(chunks)).toBe('ok');
    await expect(stream.text).resolves.toBe('attempt 2');
  });

  it('passes on a non-retryable error chunk that follows reasoning', async () => {
    const { provider, calls } = scriptedStream([[{ type: 'reasoning-delta', textDelta: 'hmm' }, { type: 'error', error: apiError(400) }]]);

    const stream = await withRetry(provider, fast).stream(request);
    const chunks = await collect(stream.fullStream);

    expect(calls).toHaveLength(1);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['reasoning-delta', 'error']);
  });

  describe('stream timeouts', () => {

    it('timeoutMs still times out a stream that never produces a first chunk, and retries it', async () => {
      const { provider, calls } = pacedStream([500]);
      const onRetry = vi.fn();

      const failure = await withRetry(provider, { ...fast, timeoutMs: 30, maxRetries: 1, onRetry })
        .stream(request)
        .then((streamed) => collect(streamed.fullStream))
        .catch((error: unknown) => error);

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      expect(failure).toMatchObject({ name: 'TimeoutError' });
    });

    it('idleTimeoutMs fails a stream that goes quiet between chunks', async () => {
      const { provider, calls } = pacedStream([5, 5, 500]);

      const failure = await withRetry(provider, { idleTimeoutMs: 60, maxRetries: 2 })
        .stream(request)
        .then((streamed) => collect(streamed.fullStream))
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ name: 'TimeoutError' });
      // Text was already out, so the stream is not replayed.
      expect(calls).toHaveLength(1);
    });
  });

});

describe('resilientProvider', () => {
  it("applies the config's maxRetries and per-attempt timeout", async () => {
    const slow = new MockLLMProvider({ delay: 1_000 });
    const generate = vi.spyOn(slow, 'generate');

    await expect(resilientProvider(slow, { maxRetries: 1, timeout: 5 }).generate(request)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe('withFallback', () => {

  it('starts every call with the first provider and forwards an explicit model to it only', async () => {
    const primary = flaky([apiError(500)], 'primary');
    const backup = flaky([], 'backup');
    const provider = withFallback([primary.provider, backup.provider]);
    await provider.generate(request);

    const result = await provider.generate({ ...request, model: 'gpt-x' });

    expect(result.text).toBe('primary ok');
    expect(primary.calls[1].model).toBe('gpt-x');
    expect(result.servedBy).toEqual({ provider: 'primary', model: 'gpt-x' });
  });

  it('does not fall back when fallbackOn says no or the call was aborted', async () => {
    const first = flaky([apiError(500), apiError(500)], 'a');
    const second = flaky([], 'b');
    const noFallback = withFallback([first.provider, second.provider], { fallbackOn: () => false });
    await expect(noFallback.generate(request)).rejects.toMatchObject({ statusCode: 500 });

    const controller = new AbortController();
    const aborting = withFallback([
      { ...first.provider, generate: async () => (controller.abort(), Promise.reject(apiError(500))) },
      second.provider,
    ]);
    await expect(aborting.generate({ ...request, signal: controller.signal })).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(second.calls).toHaveLength(0);
  });

  it('composes with withRetry and covers stream()', async () => {
    const a = flaky([apiError(503), apiError(503), apiError(503)], 'a');
    const b = flaky([apiError(429)], 'b');
    const onFallback = vi.fn();
    const provider = withFallback([withRetry(a.provider, fast), withRetry(b.provider, fast)], { onFallback });

    const stream = await provider.stream(request);

    await expect(stream.text).resolves.toBe('b ok');
    expect(a.calls).toHaveLength(3);
    expect(b.calls).toHaveLength(2);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ from: 'a', to: 'b' }));
    expect(provider.supportsTools('x')).toBe(true);
    expect(provider.supportsStreaming('x')).toBe(true);
    await expect(provider.getModels()).resolves.toEqual(['a-model']);
  });
});
