import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LLMProviderRegistry, type LLMProvider } from 'lousho';
import { SecretsStore } from '../../secretsStore';
import { resolveAuthorProvider } from '../provider';

/**
 * resolveAuthorProvider: 'provider/model' -> a real LLMProvider built with
 * the stored key (secrets store wins over the env var), or a NO_PROVIDER_KEY
 * failure. It never falls back to mock - a missing key is a setup card, not
 * a fake reply (PLAN 16.4).
 */
describe('resolveAuthorProvider', () => {
  let dir: string;
  let secrets: SecretsStore;
  let createSpy: MockInstance;
  const fakeProvider = {} as LLMProvider;

  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa02b-provider-'));
    secrets = new SecretsStore(dir);
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    createSpy = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fakeProvider);
  });

  afterEach(() => {
    createSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([ 'no-slash-at-all', 'anthropic/'])(
    '"%s" is not usable: the pick-another-model copy, provider never created',
    (model) => {
      const result = resolveAuthorProvider(model, secrets);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NO_PROVIDER_KEY');
        expect(result.message).toBe(
          `The Agent Author model "${model}" is not available. Pick another model in Settings.`
        );
      }
      expect(createSpy).not.toHaveBeenCalled();
    }
  );
});
