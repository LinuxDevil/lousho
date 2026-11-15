import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { listModels } from 'lousho';
import { registerCatalogRoutes } from '../routes/catalogRoutes';
import { createOpenRouterCatalog } from '../routes/openRouterCatalog';
import { matchesModelFilter, modelLabel } from '../../src/components/modelFilter';
import { SecretsStore } from '../secretsStore';

/**
 * The catalog routes expose the SDK's catalogs (S06 tools, S07 models,
 * S11 guardrails, S22a trigger types) plus the registry index's skills and
 * kits, so the canvas pickers and the Author read the real lists instead of
 * hard-coding names. `registerCatalogRoutes` mounts on a bare Express app
 * here; the token gate that also covers `/catalog/**` is tokenGate.test.ts's.
 */
describe('catalog routes', () => {
  let baseDir: string;
  let secrets: SecretsStore;
  let app: Express;

  function mount(registryIndexPath?: string): Express {
    const mounted = express();
    registerCatalogRoutes(mounted, { secretsStore: secrets, ...(registryIndexPath ? { registryIndexPath } : {}) });
    return mounted;
  }

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-catalog-'));
    secrets = new SecretsStore(baseDir);
    app = mount();
  });

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('GET /catalog/models?provider= (empty) -> 400 LOUSHO_QUERY_INVALID', async () => {
    const res = await request(app).get('/catalog/models?provider=');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "'provider' must be a non-empty string", code: 'LOUSHO_QUERY_INVALID' });
  });

  it('a stored provider key makes its models available even with the env key unset', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    secrets.setKey('anthropic', 'k');
    try {
      const res = await request(app).get('/catalog/models?provider=anthropic');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((m: { available: boolean }) => m.available)).toBe(true);
    } finally {
      secrets.removeKey('anthropic');
    }
    // Without the stored key or env, the same models are unavailable.
    const res = await request(app).get('/catalog/models?provider=anthropic');
    expect(res.body.every((m: { available: boolean }) => !m.available)).toBe(true);
  });

  it('OpenRouter models are fetched once, mapped, cached, and appended to /catalog/models', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'acme/coder:free',
              context_length: 1000,
              pricing: { prompt: '0', completion: '0' },
              supported_parameters: ['tools', 'reasoning'],
              architecture: { input_modalities: ['text', 'image'] },
            },
            { id: 'acme/paid', pricing: { prompt: '0.000002', completion: '0.00001' } },
          ],
        })
      )
    );
    const withOpenRouter = express();
    registerCatalogRoutes(withOpenRouter, {
      secretsStore: secrets,
      openRouterModels: createOpenRouterCatalog(fetchMock as unknown as typeof fetch),
    });

    const all = await request(withOpenRouter).get('/catalog/models');
    expect(all.body.slice(0, listModels().length)).toEqual(listModels());
    expect(all.body.find((m: { id: string }) => m.id === 'openrouter/acme/coder:free')).toEqual({
      id: 'openrouter/acme/coder:free',
      modelId: 'acme/coder:free',
      provider: 'openrouter',
      contextWindow: 1000,
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: false, hostedTools: [] },
      available: true,
    });
    const paid = all.body.find((m: { id: string }) => m.id === 'openrouter/acme/paid');
    expect([paid.inputCostPerMTok, paid.outputCostPerMTok, paid.capabilities.tools]).toEqual([2, 10, false]);

    const anthropicOnly = await request(withOpenRouter).get('/catalog/models?provider=anthropic');
    expect(anthropicOnly.body).toEqual(listModels({ provider: 'anthropic' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an unreachable OpenRouter leaves the SDK catalog intact', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const offline = express();
    registerCatalogRoutes(offline, {
      secretsStore: secrets,
      openRouterModels: createOpenRouterCatalog((async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch),
    });
    const res = await request(offline).get('/catalog/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listModels());
  });

  it('the model filter matches every word against the label, "free" included', () => {
    const label = modelLabel({ id: 'openrouter/acme/coder:free', available: true, inputCostPerMTok: 0, outputCostPerMTok: 0 });
    expect(label).toBe('openrouter/acme/coder:free (free)');
    expect(matchesModelFilter(label, 'ACME free')).toBe(true);
    expect(matchesModelFilter(label, 'acme anthropic')).toBe(false);
    expect(matchesModelFilter(label, '  ')).toBe(true);
  });

  it('a missing registry index -> [] with one console.warn, not 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = mount(path.join(baseDir, 'no-such-index.json'));
    const skills = await request(broken).get('/catalog/skills');
    const kits = await request(broken).get('/catalog/kits');
    expect(skills.status).toBe(200);
    expect(skills.body).toEqual([]);
    expect(kits.status).toBe(200);
    expect(kits.body).toEqual([]);
    // One warn for the whole registration, not one per request.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('registry items without string name/type/description are filtered out', async () => {
    const custom = path.join(baseDir, 'custom-index.json');
    fs.writeFileSync(
      custom,
      JSON.stringify({
        items: [
          { name: 'good-skill', type: 'skill', description: 'fine' },
          { name: 'no-type', description: 'missing type' },
          { name: 42, type: 'skill', description: 'numeric name' },
          { type: 'kit', description: 'no name' },
        ],
      })
    );
    const mounted = mount(custom);
    const skills = await request(mounted).get('/catalog/skills');
    expect(skills.body).toEqual([{ name: 'good-skill', description: 'fine', ref: { registry: 'good-skill' } }]);
    expect((await request(mounted).get('/catalog/kits')).body).toEqual([]);
  });
});
