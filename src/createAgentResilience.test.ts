/**
 * CreateAgent({ retry, fallbackModels }) and the typed
 * `provider.retry` / `provider.fallback` stream events. No network: the
 * registry's create() is stubbed, as in createAgent.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { createAgent } from './createAgent';
import { LLMProviderRegistry, type LLMProvider, type LLMProviderConfig, type StreamChunk } from './providers/llm';
import { mockModel, type MockModel } from './testing';
import type { AgentEvent, AgentRun } from './execution';
import type { Span, TraceExporter } from './execution/tracing';

const ENV_VARS = ['LOUSHO_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];

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

/** `model` under another provider name, so a fallback is visible in events. */
function named(model: MockModel, name: string): LLMProvider {
  return {
    name,
    defaultModel: model.defaultModel,
    generate: (call) => model.generate(call),
    stream: (call) => model.stream(call),
    supportsTools: (id) => model.supportsTools(id),
    supportsStreaming: (id) => model.supportsStreaming(id),
    getModels: () => model.getModels(),
  };
}

/** Stubs the registry: each provider name resolves to the given provider; returns the configs it was built with. */
function stubRegistry(providers: Record<string, LLMProvider>): Array<[string, LLMProviderConfig]> {
  const created: Array<[string, LLMProviderConfig]> = [];
  vi.spyOn(LLMProviderRegistry, 'create').mockImplementation((name, config) => {
    created.push([name, config]);
    return providers[name];
  });
  return created;
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const fast = { backoff: { initialMs: 1, jitter: false } };

describe('createAgent retry and fallbackModels', () => {
  beforeEach(() => {
    for (const name of ENV_VARS) vi.stubEnv(name, '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retries by default (maxRetries 2) with the ai SDK retries off, and streams provider.retry', async () => {
    const model = mockModel([{ error: apiError(429, { 'retry-after': '0' }) }, 'recovered']);
    const created = stubRegistry({ openai: named(model, 'openai') });
    const agent = createAgent({ model: 'openai/gpt-4o-mini' });

    const run = agent.stream('hi');
    const events = await collect(run);

    expect(created).toEqual([['openai', { maxRetries: 0, defaultModel: 'gpt-4o-mini', apiKey: 'sk-openai' }]]);
    expect((await run.result).text).toBe('recovered');
    expect(model.calls).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual([
      'run.start',
      'step.start',
      'provider.retry',
      'text.delta',
      'text.done',
      'step.done',
      'run.done',
    ]);
    expect(events[2]).toMatchObject({
      type: 'provider.retry',
      attempt: 1,
      maxRetries: 2,
      delayMs: 0,
      error: { message: 'HTTP 429', category: 'rate-limit' },
      provider: 'openai',
    });
    expect(JSON.parse(JSON.stringify(events[2]))).toEqual(events[2]);
  });

  it('retry: false fails fast', async () => {
    const model = mockModel([{ error: apiError(503) }, 'never reached']);
    const created = stubRegistry({ openai: named(model, 'openai') });

    const agent = createAgent({ model: 'openai/gpt-4o-mini', retry: false });

    await expect(agent.send('hi')).rejects.toThrow();
    expect(model.calls).toHaveLength(1);
    expect(created[0][1].maxRetries).toBe(0);
  });

  it('a streamed step that fails after reasoning only is retried; the failed reasoning is closed, not kept', async () => {
    const scripts: Array<Array<StreamChunk | Error>> = [
      [{ type: 'reasoning-delta', textDelta: 'first try' }, apiError(500)],
      [{ type: 'reasoning-delta', textDelta: 'second try' }, { type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }],
    ];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'lmstudio',
      generate: async () => ({ text: '', finishReason: 'stop' }),
      stream: async () => {
        const script = scripts[calls++];
        return {
          fullStream: (async function* (): AsyncGenerator<StreamChunk> {
            for (const step of script) {
              if (step instanceof Error) throw step;
              yield step;
            }
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
    const ended: Span[] = [];
    const exporter: TraceExporter = { onSpanStart: () => {}, onSpanEnd: (span) => ended.push({ ...span }) };

    const run = createAgent({ provider, instructions: 'x', retry: fast, exporter }).stream('hi');
    const events = await collect(run);
    const result = await run.result;

    expect(calls).toBe(2);
    expect(result.text).toBe('done');
    expect(result.reasoning).toBe('second try');
    expect(
      events
        .filter((e) => e.type.startsWith('reasoning.') || e.type === 'provider.retry' || e.type === 'text.delta')
        .map((e) => ('text' in e ? `${e.type}:${e.text}` : e.type))
    ).toEqual([
      'reasoning.start',
      'reasoning.delta:first try',
      'reasoning.done:first try',
      'provider.retry',
      'reasoning.start',
      'reasoning.delta:second try',
      'reasoning.done:second try',
      'text.delta:done',
    ]);
    const chat = ended.find((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chat?.attributes).toMatchObject({ 'lousho.retry.count': 1, 'lousho.retry.errors': ['unknown 500'] });
  });
});
