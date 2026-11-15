/**
 * `send()` and `AgentExecutor.execute()` with a listener stream their
 * model calls like `stream()` does - a step's text reaches the listener as
 * several `text.delta` events - without changing what the run returns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { createAgent } from '../createAgent';
import { LLMProviderRegistry, type LLMProvider } from '../providers/llm';
import { mockModel, type MockModel } from '../testing';
import type { AgentEvent } from './agentEvents';

/** The text of each step's `text.delta` events, step by step. */
function deltasPerStep(events: AgentEvent[]): string[][] {
  const steps: string[][] = [];
  for (const event of events) {
    if (event.type === 'step.start') steps.push([]);
    if (event.type === 'text.delta') steps.at(-1)?.push(event.text);
  }
  return steps;
}

/** `model` with its `stream()` calls counted. */
function counting(model: MockModel, name = model.name): LLMProvider & { streamed: number } {
  const provider = {
    streamed: 0,
    name,
    defaultModel: model.defaultModel,
    generate: (call: Parameters<LLMProvider['generate']>[0]) => model.generate(call),
    stream: (call: Parameters<LLMProvider['stream']>[0]) => {
      provider.streamed += 1;
      return model.stream(call);
    },
    supportsTools: (id: string) => model.supportsTools(id),
    supportsStreaming: (id: string) => model.supportsStreaming(id),
    getModels: () => model.getModels(),
  };
  return provider;
}

describe('send() with a listener: retry and fallback cover streamed calls', () => {
  const ENV_VARS = ['LOUSHO_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];
  const apiError = (statusCode: number) =>
    new APICallError({ message: `HTTP ${statusCode}`, url: 'https://api.example.com/v1/chat', requestBodyValues: {}, statusCode, isRetryable: true });

  beforeEach(() => {
    for (const name of ENV_VARS) vi.stubEnv(name, '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retries a failed streamed call, then falls back, reporting both to the listener', async () => {
    const primary = counting(mockModel([{ error: apiError(503) }, { error: apiError(503) }]), 'openai');
    const fallback = counting(mockModel(['Hello from the fallback model.'], { defaultModel: 'claude-3-5-haiku-latest' }), 'anthropic');
    const providers: Record<string, LLMProvider> = { openai: primary, anthropic: fallback };
    vi.spyOn(LLMProviderRegistry, 'create').mockImplementation((name) => providers[name]);
    const heard: AgentEvent[] = [];
    const agent = createAgent({
      model: 'openai/gpt-4o-mini',
      fallbackModels: ['anthropic/claude-3-5-haiku-latest'],
      retry: { backoff: { initialMs: 1, jitter: false }, maxRetries: 1 },
      onEvent: (e) => heard.push(e),
    });

    const result = await agent.send('hi');

    expect(result.text).toBe('Hello from the fallback model.');
    expect(primary.streamed).toBe(2);
    expect(fallback.streamed).toBe(1);
    const types = heard.map((e) => e.type);
    expect(types).toContain('provider.retry');
    expect(types).toContain('provider.fallback');
    expect(deltasPerStep(heard)[0].length).toBeGreaterThan(1);
    expect(deltasPerStep(heard)[0].join('')).toBe(result.text);
  });
});
