/**
 * Error Classes Tests
 */

import { describe, it, expect } from 'vitest';
import { APICallError, RetryError } from 'ai';
import {
  AgentExecutionError,
  LLMProviderError,
  FlowExecutionError,
  ConfigurationError,
  TimeoutError,
  RateLimitError,
  isRetryableError,
  isNetworkError,
  getRetryDelay,
  compactProviderError,
  isModelActionableProviderErrorCategory,
  
} from './errors';

describe('Error Classes', () => {

  describe('AgentExecutionError', () => {
    it('should create agent execution error', () => {
      const cause = new Error('Original error');
      const error = new AgentExecutionError('Agent failed', 'agent-1', cause);

      expect(error.detail).toBe('Agent failed');
      expect(error.agentId).toBe('agent-1');
      expect(error.cause).toBe(cause);
      expect(error.code).toBe('LOUSHO_AGENT_EXECUTION_FAILED');
    });
  });

  describe('FlowExecutionError', () => {
    it('should create flow execution error', () => {
      const cause = new Error('Step failed');
      const error = new FlowExecutionError(
        'Flow failed',
        'my-flow',
        'step-1',
        cause
      );

      expect(error.detail).toBe('Flow failed');
      expect(error.code).toBe('LOUSHO_FLOW_EXECUTION_FAILED');
      expect(error.flowCode).toBe('my-flow');
      expect(error.step).toBe('step-1');
      expect(error.cause).toBe(cause);
    });
  });

  describe('isRetryableError', () => {
    it('should identify retryable errors', () => {
      expect(isRetryableError(new RateLimitError('Rate limit'))).toBe(true);
      expect(isRetryableError(new TimeoutError('Timeout'))).toBe(true);
      expect(
        isRetryableError(new LLMProviderError('Server error', 'openai', 500))
      ).toBe(true);
      expect(
        isRetryableError(new LLMProviderError('Too many requests', 'openai', 429))
      ).toBe(true);
    });

    it('should identify non-retryable errors', () => {
      expect(
        isRetryableError(new LLMProviderError('Bad request', 'openai', 400))
      ).toBe(false);
      expect(isRetryableError(new ConfigurationError('Invalid config'))).toBe(
        false
      );
      expect(isRetryableError(new Error('Generic error'))).toBe(false);
    });
  });

  describe('isNetworkError', () => {
    it('should identify network errors', () => {
      expect(isNetworkError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isNetworkError(new Error('ENOTFOUND'))).toBe(true);
      expect(isNetworkError(new Error('network timeout'))).toBe(true);
      expect(isNetworkError(new Error('fetch failed'))).toBe(true);
    });
  });

  describe('getRetryDelay', () => {
    it('should extract retry delay from RateLimitError', () => {
      const error = new RateLimitError('Rate limit', 60);
      expect(getRetryDelay(error)).toBe(60000);
    });

    it('should return undefined for other errors', () => {
      const error = new Error('Generic error');
      expect(getRetryDelay(error)).toBeUndefined();
    });
  });

  describe('compactProviderError', () => {

    it('maps an in-stream insufficient_quota message to quota-exceeded, but a plain rate limit stays retryable', () => {
      expect(compactProviderError(new Error('You exceeded your current quota (insufficient_quota)'))).toMatchObject({
        category: 'quota-exceeded',
        retryable: false,
      });
      expect(compactProviderError(new Error('Rate limit reached for requests'))).toMatchObject({ category: 'rate-limit', retryable: true });
    });

    it('maps a 401 APICallError (bad/revoked API key) to auth-failure/non-retryable', () => {
      const raw = new APICallError({
        message: 'Incorrect API key provided',
        url: 'https://api.anthropic.com/v1/messages',
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      });

      const compacted = compactProviderError(raw, 'anthropic');

      expect(compacted.category).toBe('auth-failure');
      expect(compacted.retryable).toBe(false);
    });

    it('maps a 403 APICallError to auth-failure', () => {
      const raw = new APICallError({
        message: 'Forbidden',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 403,
        isRetryable: false,
      });

      expect(compactProviderError(raw, 'openrouter').category).toBe('auth-failure');
    });

    it('maps a "no model loaded" 404 and a streamed "model unloaded" error to model-unloaded', () => {
      const raw = new APICallError({
        message: 'Not Found',
        url: 'http://localhost:1234/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 404,
        responseBody: '{"error":{"message":"No model loaded"}}',
        isRetryable: false,
      });
      expect(compactProviderError(raw, 'lmstudio')).toMatchObject({ category: 'model-unloaded', retryable: true });

      const streamed = compactProviderError(new Error('model unloaded'), 'lmstudio');
      expect(streamed).toMatchObject({ category: 'model-unloaded', retryable: true });
    });

    it('unwraps a RetryError (ai SDK internal retries exhausted) to its lastError', () => {
      const lastError = new APICallError({
        message: 'Rate limit reached for requests',
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
      // RetryError's constructor sets `this.lastError = errors[errors.length
      // - 1]` internally (see node_modules/ai/dist/index.js) - passing it
      // via `errors` here is exactly how the 'ai' SDK itself produces one.
      const raw = new RetryError({
        message: 'Failed after 3 attempts',
        reason: 'maxRetriesExceeded',
        errors: [lastError],
      });

      const compacted = compactProviderError(raw, 'openai');
      expect(compacted.category).toBe('rate-limit');
      expect(compacted.retryable).toBe(true);
    });

    it('never leaks a responseBody/stack onto the compacted form', () => {
      const raw = new APICallError({
        message: 'Rate limit reached for requests',
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: { secret: 'do-not-leak' },
        statusCode: 429,
        responseBody: 'x'.repeat(10000),
        isRetryable: true,
      });

      const compacted = compactProviderError(raw, 'openai');
      const serialized = JSON.stringify(compacted);
      expect(serialized).not.toContain('do-not-leak');
      expect(serialized.length).toBeLessThan(1000);
    });
  });

  describe('C1: local-runtime errors (llama.cpp / LM Studio)', () => {
    const BODY_CHAT = JSON.stringify({ error: 'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}' });

    const apiError = (statusCode: number, message: string, responseBody: string, extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) =>
      new APICallError({
        message,
        url: 'http://localhost:1234/v1/responses',
        requestBodyValues: {},
        statusCode,
        responseBody,
        isRetryable: statusCode >= 500,
        ...extra,
      });

    it('never turns an object-valued stream error into "[object Object]"', () => {
      expect(compactProviderError({ code: 500, message: 'Context size has been exceeded.' }).error).toBe('Context size has been exceeded.');
      expect(compactProviderError({ type: 'error', error: { code: 500, message: 'boom' } }).error).toBe('boom');
      expect(compactProviderError({ code: 'weird', detail: 'x' }).error).toBe('{"code":"weird","detail":"x"}');
    });

    it('appends a snippet of an unparsed body to a bare status-text message', () => {
      const compacted = compactProviderError(apiError(400, 'Bad Request', BODY_CHAT, { requestBodyValues: { secret: 'do-not-leak' } }));
      expect(compacted.error).toMatch(/^Bad Request: \{"error":"Engine protocol predict stream returned an error/);
      expect(compacted.error).not.toContain('do-not-leak');
      const long = compactProviderError(apiError(400, 'Bad Request', `{"error":"${'y'.repeat(5000)}"}`));
      expect(long.error.length).toBeLessThan(600);
    });

    it('names ECONNREFUSED and the URL for a refused connection (cause chain) as timeout/retryable', () => {
      const refused = Object.assign(new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:1234')], ''), { code: 'ECONNREFUSED' });
      const raw = new APICallError({
        message: 'Cannot connect to API: ',
        url: 'http://localhost:1234/v1/responses?key=secret',
        requestBodyValues: {},
        cause: refused,
        isRetryable: true,
      });
      const compacted = compactProviderError(raw, 'openai');
      expect(compacted).toMatchObject({ category: 'timeout', retryable: true });
      expect(compacted.error).toBe('Cannot connect to API: connection refused (ECONNREFUSED) at http://localhost:1234/v1/responses - is the server running?');
      expect(compacted.error).not.toContain('secret');
    });
  });

  describe('isModelActionableProviderErrorCategory', () => {
    it('treats rate-limit, timeout and context-length-exceeded as model-actionable', () => {
      expect(isModelActionableProviderErrorCategory('rate-limit')).toBe(true);
      expect(isModelActionableProviderErrorCategory('timeout')).toBe(true);
      expect(isModelActionableProviderErrorCategory('context-length-exceeded')).toBe(true);
    });
  });
});

describe('provider error classification fixes', () => {
  const apiError = (statusCode: number, message: string, headers: Record<string, string> = {}) =>
    new APICallError({ message, url: 'https://x', requestBodyValues: {}, statusCode, responseHeaders: headers, isRetryable: statusCode >= 500 || statusCode === 429 });

  it('"authentication" in a 5xx body stays a retryable server failure', () => {
    expect(compactProviderError(apiError(503, 'authentication service unavailable'))).toMatchObject({ category: 'unknown', retryable: true });
    expect(compactProviderError(apiError(400, 'authentication header malformed'))).toMatchObject({ category: 'auth-failure', retryable: false });
  });
});
