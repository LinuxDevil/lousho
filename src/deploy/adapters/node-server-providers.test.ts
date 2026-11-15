
import { describe, expect, it } from 'vitest';
import { providersInSource } from './node-server';

describe('providersInSource', () => {
  it('finds literal model prefixes and SDK provider classes', () => {
    expect(providersInSource("createAgent({ model: 'anthropic/claude-sonnet-4-5' })")).toEqual(['anthropic']);
    expect(providersInSource("import { OpenRouterProvider } from 'lousho';\nnew OpenRouterProvider({ apiKey })")).toEqual(['openrouter']);
    expect(providersInSource('new OpenAIProvider({}); new OllamaProvider({})').sort()).toEqual(['ollama', 'openai']);
    expect(providersInSource('const x = 1')).toEqual([]);
  });
});
