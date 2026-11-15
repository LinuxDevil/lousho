import { describe, it, expect, beforeEach } from 'vitest';
import { LLMProviderRegistry } from './llm';
import { createMockProvider } from './mock';

describe('LLM Providers', () => {
  describe('LLMProviderRegistry', () => {
    beforeEach(() => {
      LLMProviderRegistry.clear();
    });

    it('should return provider names', () => {
      LLMProviderRegistry.register('mock', createMockProvider);
      LLMProviderRegistry.register('test', createMockProvider);
      const names = LLMProviderRegistry.getProviderNames();
      expect(names).toContain('mock');
      expect(names).toContain('test');
    });
  });
});
