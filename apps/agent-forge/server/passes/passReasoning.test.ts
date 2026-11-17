import { describe, expect, it } from 'vitest';
import { passReasoning } from './passModel';

describe('passReasoning', () => {
  it('caps an OpenRouter model at half the output budget so the JSON answer fits', () => {
    expect(passReasoning('openrouter/nvidia/nemotron-3.5-lightning:free', 1024)).toEqual({ budgetTokens: 512, force: true });
  });

  it('leaves other providers alone', () => {
    expect(passReasoning('anthropic/claude-haiku-5-5', 1024)).toBeUndefined();
  });
});
