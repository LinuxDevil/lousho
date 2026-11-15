/**
 * Per-node `retry` and `timeoutMs`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type { AgentFlow, EditorStep } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext, type FlowExecutionEvent } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { APICallError } from 'ai';
import { CompactedLLMProviderError } from '../execution/errors';

function flowOf(root: EditorStep): AgentFlow {
  return { code: 'retry', name: 'Retry', flow: root };
}

describe('FlowExecutor node retry and timeout', () => {
  let toolRegistry: ToolRegistry;
  let context: FlowExecutionContext;
  let calls: number;
  let failures: number;
  let hangs: number;

  beforeEach(() => {
    calls = 0;
    failures = 0;
    hangs = 0;
    toolRegistry = new ToolRegistry();
    toolRegistry.register('flaky', {
      displayName: 'Flaky',
      tool: {
        description: 'Fails `failures` times, hangs `hangs` times (until aborted), then succeeds',
        parameters: z.object({}),
        execute: async (_args: unknown, ctx?: { abortSignal?: AbortSignal }) => {
          calls++;
          if (hangs > 0) {
            hangs--;
            await new Promise((_, reject) =>
              ctx?.abortSignal?.addEventListener('abort', () => {
                reject(new Error('aborted'));
              })
            );
          }
          if (failures > 0) {
            failures--;
            throw new Error(`failure ${calls}`);
          }
          return `ok after ${calls}`;
        },
      },
    });
    context = {
      agent: { name: 'flow-agent' },
      provider: new MockLLMProvider({ name: 'mock', responses: ['hi'] }),
      toolRegistry,
      variables: {},
    };
  });

  it('retries a failing node with exponential backoff', async () => {
    failures = 2;
    const events: FlowExecutionEvent[] = [];
    const started = Date.now();
    const result = await FlowExecutor.execute(
      flowOf({ type: 'toolCall', tool: 'flaky', arguments: {}, retry: { maxAttempts: 3, backoffMs: 20 } }),
      context,
      (event) => events.push(event)
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('ok after 3');
    const retries = events.filter((event) => event.type === 'step-retry');
    expect(retries.map((event) => event.data)).toEqual([
      { attempt: 1, maxAttempts: 3, delayMs: 20 },
      { attempt: 2, maxAttempts: 3, delayMs: 40 },
    ]);
    expect(retries[0].error?.message).toBe('failure 1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(events.filter((event) => event.type === 'step-start')).toHaveLength(1);
  });

  it('rejects invalid retry and timeout settings with LOUSHO_FLOW_INVALID', async () => {
    for (const bad of [{ retry: { maxAttempts: 0 } }, { retry: { maxAttempts: 2, backoffMs: -1 } }, { timeoutMs: 0 }]) {
      const result = await FlowExecutor.execute(flowOf({ type: 'return', value: 1, ...bad }), context);
      expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_INVALID' });
    }
  });
});

describe('FlowExecutor llmCall provider failures', () => {
  function apiError(statusCode: number, message: string): APICallError {
    return new APICallError({
      message,
      url: 'https://api.example.com/v1/chat/completions',
      requestBodyValues: {},
      statusCode,
      isRetryable: statusCode === 429 || statusCode >= 500,
    });
  }

  /** A provider whose generate() throws each of `failures` in turn, then answers. */
  function failingProvider(...failures: unknown[]): { provider: MockLLMProvider; calls: () => number } {
    const provider = new MockLLMProvider({ responses: ['answer'] });
    let calls = 0;
    const generate = provider.generate.bind(provider);
    provider.generate = async (request) => {
      const failure = failures[calls++];
      if (failure !== undefined) throw failure;
      return generate(request);
    };
    return { provider, calls: () => calls };
  }

  const llmFlow = flowOf({ type: 'llmCall', prompt: 'hi', retry: { maxAttempts: 3 } });

  it('fails with a compacted LOUSHO_PROVIDER_* error, not the raw APICallError, and does not retry a 401', async () => {
    const { provider, calls } = failingProvider(apiError(401, 'User not found.'), apiError(401, 'User not found.'));
    const result = await FlowExecutor.execute(llmFlow, { agent: { name: 'f' }, provider, variables: {} });

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(CompactedLLMProviderError);
    expect(result.error).toMatchObject({
      code: 'LOUSHO_PROVIDER_REQUEST_FAILED',
      compacted: { category: 'auth-failure', retryable: false, statusCode: 401, providerName: provider.name },
    });
    expect(calls()).toBe(1);
    expect(result.events.filter((event) => event.type === 'step-retry')).toHaveLength(0);
  });
});
