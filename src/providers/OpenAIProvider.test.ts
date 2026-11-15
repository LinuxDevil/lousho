/**
 * OpenAI Provider Tests
 */

import { describe, it, expect, beforeEach,  } from 'vitest';
import { OpenAIProvider } from './OpenAIProvider';
import { estimateCost } from '../models/registry';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider({
      name: 'openai',
      apiKey: 'test-api-key',
      defaultModel: 'gpt-4',
    });
  });

  describe('supportsTools', () => {
    it('should return true for GPT-4 models', () => {
      expect(provider.supportsTools('gpt-4')).toBe(true);
      expect(provider.supportsTools('gpt-4-turbo')).toBe(true);
      expect(provider.supportsTools('gpt-4o')).toBe(true);
    });
  });

  describe('getModels', () => {
    it('should return list of common models', async () => {
      const models = await provider.getModels();
      expect(models).toContain('gpt-5');
      expect(models).toContain('gpt-4o');
      // Every listed model has a built-in price.
      for (const model of models) expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, model)).toBeGreaterThan(0);
    });
  });

  // Note: Actual API calls are not tested to avoid external dependencies
  // Integration tests should be in a separate test suite
});
