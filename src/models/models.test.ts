import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../providers/llm';
import { estimateCost, estimateTokens, getModelInfo, setTokenEstimator } from './index';

describe('estimateTokens', () => {
  afterEach(() => setTokenEstimator());

  it('counts CJK at a much higher ratio than English, by code point', () => {
    const cjk = '你好世界'.repeat(25); // 100 characters
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(80);
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens('a'.repeat(100)) * 3);
    // astral CJK extension characters are 2 UTF-16 units but one code point
    expect(estimateTokens('\u{20000}'.repeat(10))).toBe(10);
  });

  it('counts emoji per code point and ignores joiners', () => {
    expect(estimateTokens('😀'.repeat(5))).toBe(10);
    expect(estimateTokens('👨‍👩')).toBe(estimateTokens('👨👩'));
  });

  it('tolerates non-string content', () => {
    const odd = { role: 'user', content: { parts: ['a', 'b'] } } as unknown as Message;
    expect(estimateTokens(odd)).toBeGreaterThan(4);
    const missing = { role: 'user' } as unknown as Message;
    expect(estimateTokens(missing)).toBe(4);
  });
});

describe('OpenRouter variants and the default models', () => {
  it(':free costs nothing; other variants keep the window but have no guessed price', () => {
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'openai/gpt-4o-mini:free')).toBe(0);
    expect(getModelInfo('openai/gpt-4o:extended')).toMatchObject({ contextWindow: 128000 });
    expect(estimateCost({ inputTokens: 1_000, outputTokens: 1_000 }, 'openai/gpt-4o:extended')).toBeUndefined();
    expect(estimateCost({ inputTokens: 1_000, outputTokens: 1_000 }, 'openai/gpt-4o:nitro')).toBeUndefined();
    // An Ollama size tag still names the model itself.
    expect(getModelInfo('llama3.1:8b')?.contextWindow).toBe(131072);
  });
});
