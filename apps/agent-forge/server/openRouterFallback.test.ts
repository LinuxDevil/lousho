import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SecretsStore } from './secretsStore';
import { openRouterModelId } from './openRouterFallback';
import { resolveAuthorProvider } from './author/provider';
import { resolveProviderForModel } from './buildAgent';
import { computeRequirements, requirementDeps } from './author/requirements';
import { withStoredKeyAvailability } from './routes/catalogRoutes';

describe('OpenRouter fallback for providers without a key', () => {
  const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let baseDir: string;
  let store: SecretsStore;

  beforeEach(() => {
    for (const name of names) delete process.env[name];
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-or-fallback-'));
    store = new SecretsStore(baseDir);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('marks Anthropic and OpenAI models available when only an OpenRouter key exists', () => {
    const models = [
      { id: 'anthropic/claude-haiku-5-5', provider: 'anthropic', available: false },
      { id: 'openai/gpt-4o-mini', provider: 'openai', available: false },
    ] as Parameters<typeof withStoredKeyAvailability>[0];
    expect(withStoredKeyAvailability(models, store).map((m) => m.available)).toEqual([false, false]);
    store.setKey('openrouter', 'sk-or-test');
    expect(withStoredKeyAvailability(models, store).map((m) => m.available)).toEqual([true, true]);
  });

  it('maps Anthropic ids to OpenRouter slugs', () => {
    expect(openRouterModelId('anthropic', 'claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5.5');
    expect(openRouterModelId('anthropic', 'claude-haiku-4-5')).toBe('anthropic/claude-haiku-4.5');
    expect(openRouterModelId('openai', 'gpt-4o-mini')).toBe('openai/gpt-4o-mini');
  });

  it('routes an Anthropic model through OpenRouter when only an OpenRouter key exists', async () => {
    store.setKey('openrouter', 'sk-or-test');
    const author = resolveAuthorProvider('anthropic/claude-sonnet-5-5', store);
    expect(author.ok && author.modelId).toBe('anthropic/claude-sonnet-5.5');
    expect(resolveProviderForModel('anthropic/claude-haiku-5-5', store).constructor.name).toBe('OpenRouterProvider');
    const rows = await computeRequirements(
      { version: 2, name: 't', model: 'anthropic/claude-sonnet-5-5', instructions: 'x' },
      requirementDeps(baseDir, store)
    );
    expect(rows.find((row) => row.kind === 'provider_key')?.status).toBe('ok');
  });

  it('keeps using the provider own key when it has one', () => {
    store.setKey('openrouter', 'sk-or-test');
    store.setKey('anthropic', 'sk-ant-test');
    const author = resolveAuthorProvider('anthropic/claude-sonnet-5-5', store);
    expect(author.ok && author.modelId).toBe('claude-sonnet-5-5');
  });

  it('still reports a missing key when there is no OpenRouter key either', () => {
    const author = resolveAuthorProvider('anthropic/claude-sonnet-5-5', store);
    expect(author.ok).toBe(false);
  });
});
