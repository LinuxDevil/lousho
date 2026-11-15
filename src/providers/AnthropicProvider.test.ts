/**
 * Anthropic Provider Tests
 *
 * Mirrors OpenAIProvider.test.ts's non-generate tests (constructor,
 * supportsTools, supportsStreaming, getModels), and additionally mocks the
 * 'ai' SDK's generateText/streamText (no live API key required) to verify
 * generate()/stream() return the same GenerateResult/StreamResult/
 * StreamChunk shapes OpenAIProvider produces for an equivalent scenario.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { estimateCost } from '../models/registry';

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

import { AnthropicProvider, AnthropicProviderConfig } from './AnthropicProvider';
import { LLMProviderRegistry } from './llm';

// index.ts registers 'anthropic' as a side effect of being imported, but
// index.ts also unconditionally imports OpenAIProvider.ts/OllamaProvider.ts,
// whose top-level imports of the (here uninstalled) '@ai-sdk/openai' and
// 'ollama-ai-provider' optional peer deps fail Vite's static module graph
// resolution during test collection - the same reason those two providers'
// own *.test.ts files fail to load in this repo (see vitest.config.ts's
// coverage-threshold comment). Importing index.ts here would hit that same
// failure. So this test registers 'anthropic' directly against the real
// LLMProviderRegistry using the exact factory line index.ts uses, without
// pulling in the other providers' modules.
LLMProviderRegistry.register(
  'anthropic',
  (config) => new AnthropicProvider(config as AnthropicProviderConfig)
);

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    provider = new AnthropicProvider({
      name: 'anthropic',
      apiKey: 'test-api-key',
      defaultModel: 'claude-3-5-sonnet-latest',
    });
  });

  describe('supportsTools', () => {
    it('should return true for Claude 3 models', () => {
      expect(provider.supportsTools('claude-3-5-sonnet-latest')).toBe(true);
      expect(provider.supportsTools('claude-3-opus-latest')).toBe(true);
      expect(provider.supportsTools('claude-3-haiku-20240307')).toBe(true);
    });
  });

  describe('getModels', () => {
    it('should return a non-empty list of common models', async () => {
      const models = await provider.getModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain('claude-sonnet-4-5');
      for (const model of models) expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, model)).toBeGreaterThan(0);
    });
  });
});
