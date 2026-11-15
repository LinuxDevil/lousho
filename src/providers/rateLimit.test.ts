/**
 * withRateLimit / createRateLimiter, on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, GenerateResult, LLMProvider, StreamChunk } from './llm';
import { MockLLMProvider } from './mock';
import { createRateLimiter, withRateLimit } from './rateLimit';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';

const call = (text = 'hi', extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  messages: [{ role: 'user', content: text }],
  ...extra,
});

const mockOf = (...responses: ConstructorParameters<typeof MockLLMProvider>[0]['responses'] & unknown[]) =>
  new MockLLMProvider({ defaultModel: 'mock', responses });

function fake(name: string, generate: LLMProvider['generate']): LLMProvider {
  return {
    name,
    defaultModel: name,
    generate,
    stream: async () => {
      throw new Error('not used');
    },
    supportsTools: () => true,
    supportsStreaming: () => false,
    getModels: async () => [],
  };
}

/** A provider whose calls stay open until `finish()`, recording peak concurrency. */
function gated() {
  const inner = mockOf('ok');
  const waiting: Array<() => void> = [];
  const stats = { started: 0, active: 0, peak: 0 };
  const provider = fake('gated', async (options) => {
    stats.started++;
    stats.peak = Math.max(stats.peak, ++stats.active);
    await new Promise<void>((resolve) => waiting.push(resolve));
    stats.active--;
    return inner.generate(options);
  });
  return { provider, stats, finish: () => waiting.shift()?.() };
}

describe('withRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds calls back by their estimated tokens per minute', async () => {
    const mock = fake('t', async () => ({ text: 'a', finishReason: 'stop' }) as GenerateResult);
    const spy = vi.spyOn(mock, 'generate');
    const limited = withRateLimit(mock, { tokensPerMinute: 1_000 });
    const big = call('x', { maxTokens: 600 });
    const done = [limited.generate(big), limited.generate(big)];
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    await Promise.all(done);
  });

  it('removes a queued call that is aborted, without starting it', async () => {
    const { provider, stats, finish } = gated();
    const limiter = createRateLimiter({ maxConcurrent: 1 });
    const limited = withRateLimit(provider, limiter);
    const first = limited.generate(call());
    const controller = new AbortController();
    const queued = limited.generate(call('q', { signal: controller.signal }));
    const rejected = expect(queued).rejects.toThrow('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(limiter.pending).toBe(1);
    controller.abort(new Error('stop'));
    await rejected;
    expect(limiter.pending).toBe(0);
    finish();
    await first;
    expect(stats.started).toBe(1);
    await expect(limited.generate(call('late', { signal: controller.signal }))).rejects.toThrow('stop');
  });

  it('holds a stream slot until the stream is read to its end', async () => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const inner: LLMProvider = {
      ...fake('s', async () => ({ text: 'x', finishReason: 'stop' }) as GenerateResult),
      stream: async () => ({
        textStream: (async function* () {})(),
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', textDelta: 'a' };
          await ended;
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        text: ended.then(() => 'a'),
        usage: ended.then(() => undefined),
        finishReason: ended.then(() => 'stop'),
        toolCalls: ended.then(() => []),
      }),
    };
    const limiter = createRateLimiter({ maxConcurrent: 1 });
    const limited = withRateLimit(inner, limiter);
    const streamed = await limited.stream(call());
    const second = limited.stream(call());
    await vi.advanceTimersByTimeAsync(0);
    expect(limiter.inFlight).toBe(1);
    expect(limiter.pending).toBe(1);
    end();
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamed.fullStream) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    await second;
    expect(limiter.pending).toBe(0);
  });
});

describe('createAgent({ rateLimit })', () => {
  /** Peak overlap of the sub-agents' model calls, with the lead running two `task` calls at once. */
  async function peakOverlap(rateLimit?: { maxConcurrent: number }) {
    const stats = { active: 0, peak: 0 };
    const inner = mockOf('done');
    const slow = fake('slow', async (options) => {
      stats.peak = Math.max(stats.peak, ++stats.active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      stats.active--;
      return inner.generate(options);
    });
    const worker = createAgent({ provider: slow, description: 'Works', name: 'worker' });
    const task = { name: 'task', args: { agent: 'worker', prompt: 'go', description: 'work' } };
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [task, task] }, 'All done.']),
      subagents: { worker },
      ...(rateLimit && { rateLimit }),
    });
    await lead.send('fan out');
    return stats.peak;
  }

  it("shares the lead's budget with the sub-agents it runs", async () => {
    expect(await peakOverlap({ maxConcurrent: 1 })).toBe(1);
  });
});

describe('withRateLimit over withRetry on streams', () => {
  /** A provider whose first stream fails after reasoning only (retried by withRetry), the second answering `ok`. */
  function flakyStreams(): LLMProvider {
    let attempt = 0;
    const provider = new MockLLMProvider({ defaultModel: 'mock' });
    provider.stream = async () => {
      const mine = ++attempt;
      // As a real stream's: the text settles when the stream does.
      let settle!: (text: Promise<string>) => void;
      const text = new Promise<string>((resolve) => (settle = resolve));
      text.catch(() => undefined);
      const chunks = async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'reasoning-delta', textDelta: 'hmm' };
        if (mine === 1) {
          const error = new Error('Service Unavailable: upstream timed out');
          settle(Promise.reject(error));
          throw error;
        }
        yield { type: 'text-delta', textDelta: 'ok' };
        yield { type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        settle(Promise.resolve('ok'));
      };
      return { fullStream: chunks(), textStream: (async function* () {})(), text, usage: Promise.resolve(undefined), finishReason: Promise.resolve('stop'), toolCalls: Promise.resolve([]) };
    };
    return provider;
  }

  it("the result's final values are the retry's, the slot is held until the retried stream ends, and the retry counts as a request", async () => {
    const { withRetry } = await import('./resilience');
    const limiter = createRateLimiter({ maxConcurrent: 1, requestsPerMinute: 100 });
    const provider = withRateLimit(withRetry(flakyStreams(), { backoff: { initialMs: 1, jitter: false } }), limiter);

    const streamed = await provider.stream({ messages: [{ role: 'user', content: 'hi' }] });
    const types: string[] = [];
    for await (const chunk of streamed.fullStream) {
      types.push(chunk.type);
      if (chunk.type === 'text-delta') expect(limiter.inFlight).toBe(1);
    }

    expect(types).toEqual(['reasoning-delta', 'reasoning-delta', 'text-delta', 'finish']);
    await expect(streamed.text).resolves.toBe('ok');
    expect(limiter.inFlight).toBe(0);
    expect((limiter as unknown as { starts: number[] }).starts).toHaveLength(2);
  });
});
