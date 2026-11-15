import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseJudgeScore, parseJudgeCritique, llmJudge, llmCritique } from './llmJudge';
import type { LLMProvider } from '../providers/llm';

describe('parseJudgeScore', () => {

  it('scales N/10, N out of 10, percentages and bare whole numbers out of 10 or 100 into [0, 1]', () => {
    expect(parseJudgeScore('9/10').score).toBe(0.9);
    expect(parseJudgeScore('7 out of 10').score).toBe(0.7);
    expect(parseJudgeScore('Rating: 4/5').score).toBe(0.8);
    expect(parseJudgeScore('85%').score).toBe(0.85);
    expect(parseJudgeScore('Score: 8').score).toBe(0.8);
    expect(parseJudgeScore('85').score).toBe(0.85);
    expect(parseJudgeScore('10').score).toBe(1);
    expect(parseJudgeScore('250').score).toBe(1);
  });
});

describe('parseJudgeCritique', () => {

  it('returns empty feedback for an empty FEEDBACK marker or an empty response', () => {
    expect(parseJudgeCritique('SCORE: 0.9\nFEEDBACK:')).toEqual({ score: 0.9, feedback: '' });
    const { score, feedback, reason } = parseJudgeCritique('');
    expect(score).toBe(0);
    expect(feedback).toBe('');
    expect(reason).toBeDefined();
  });
});

describe('llmJudge() structural isolation guard', () => {
  const originalEnv = process.env.LOUSHO_ALLOW_LLM_JUDGE;

  beforeEach(() => {
    delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
    } else {
      process.env.LOUSHO_ALLOW_LLM_JUDGE = originalEnv;
    }
  });

  const mockProvider: LLMProvider = {
    generate: async () => ({ text: '0.9' }) as never,
  } as never;

  it('refuses to run outside the judge-eval runner (LOUSHO_ALLOW_LLM_JUDGE unset)', async () => {
    const scorer = llmJudge({ provider: mockProvider, model: 'test-model', rubric: 'be good' });
    await expect(scorer({ text: 'hello' } as never)).rejects.toThrow(
      /llmJudge\(\) was invoked outside the judge-eval runner/
    );
  });
});

describe('llmCritique()', () => {
  const originalEnv = process.env.LOUSHO_ALLOW_LLM_JUDGE;

  beforeEach(() => {
    delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
    } else {
      process.env.LOUSHO_ALLOW_LLM_JUDGE = originalEnv;
    }
  });

  it('handles a malformed judge response like parseJudgeScore does', async () => {
    const provider: LLMProvider = {
      generate: async () => ({ text: 'no idea' }) as never,
    } as never;
    const critic = llmCritique({
      provider,
      model: 'test-model',
      rubric: 'be good',
      allowOutsideJudgeRunner: true,
    });
    const { score, feedback, reason } = await critic({ text: 'hello' } as never);
    expect(score).toBe(0);
    expect(feedback).toBe('no idea');
    expect(reason).toBeDefined();
  });
});
