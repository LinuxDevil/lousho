/**
 * computeRequirements (author/requirements.ts): the readiness list of a
 * spec v2 - provider key, models, named secrets and env vars, MCP servers,
 * builtin/registry/file tools - each `ok`, `missing` or `unknown` with a
 * fix where one exists. Never throws, never blocks a save.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { computeRequirements, requirementDeps, type RequirementDeps } from '../requirements';
import type { Requirement } from '../../../shared/authorWire';
import type { SecretsStore } from '../../secretsStore';

const MODEL_IDS = new Set([
  'anthropic/claude-x',
  'openai/gpt-1',
  'openrouter/vendormodel',
  'google/gemini-x',
  'ollama/llama3',
  'mock/mock-1',
  'pi/openrouter/x',
]);

const BUILTIN_TOOLS = [
  { name: 'web_fetch', needsCredentials: [] as string[] },
  { name: 'credentialed_tool', needsCredentials: ['CRED_KEY', 'CRED_URL'] },
];

function spec(extra: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return {
    version: 2,
    name: 'test agent',
    model: 'mock/mock-1',
    instructions: 'Do things.',
    ...extra,
  };
}

/** Deps with every check failing by default; tests override the seam they exercise. */
function deps(overrides: Partial<RequirementDeps> = {}): RequirementDeps {
  return {
    secrets: { getKey: () => undefined, hasNamed: () => false },
    env: {},
    catalog: {
      modelIds: async () => MODEL_IDS,
      builtinTools: async () => BUILTIN_TOOLS,
    },
    fileExists: () => false,
    ...overrides,
  };
}

const byId = (rows: Requirement[]) => new Map(rows.map((row) => [row.id, row]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeRequirements', () => {
  describe('provider rows', () => {

    it('openrouter and google read their env vars (missing and ok)', async () => {
      const missing = await computeRequirements(spec({ model: 'openrouter/vendormodel' }), deps());
      expect(byId(missing).get('provider:openrouter')).toEqual({
        id: 'provider:openrouter',
        kind: 'provider_key',
        status: 'missing',
        label: 'OpenRouter API key',
        fix: { action: 'open_settings', target: '/settings' },
      });
      const googleMissing = await computeRequirements(spec({ model: 'google/gemini-x' }), deps());
      expect(byId(googleMissing).get('provider:google')).toMatchObject({ status: 'missing', label: 'Google API key' });

      const ok = await computeRequirements(
        spec({ model: 'openrouter/vendormodel', fallbackModels: ['google/gemini-x'] }),
        deps({ env: { OPENROUTER_API_KEY: 'k', GOOGLE_GENERATIVE_AI_API_KEY: 'k' } })
      );
      expect(byId(ok).get('provider:openrouter')?.status).toBe('ok');
      expect(byId(ok).get('provider:google')?.status).toBe('ok');
    });
  });

  describe('tool rows', () => {

    it('a builtin with needsCredentials gets one row per credential, env or named secret satisfying it', async () => {
      const rows = await computeRequirements(spec({ tools: [{ builtin: 'credentialed_tool' }] }), deps());
      const map = byId(rows);
      expect(map.get('tool:credentialed_tool:CRED_KEY')).toEqual({
        id: 'tool:credentialed_tool:CRED_KEY',
        kind: 'tool',
        status: 'missing',
        label: 'CRED_KEY for credentialed_tool',
        fix: { action: 'add_secret', target: 'CRED_KEY' },
      });
      expect(map.get('tool:credentialed_tool:CRED_URL')?.status).toBe('missing');

      const satisfied = await computeRequirements(
        spec({ tools: [{ builtin: 'credentialed_tool' }] }),
        deps({
          env: { CRED_KEY: 'v' },
          secrets: { getKey: () => undefined, hasNamed: (n) => n === 'CRED_URL' },
        })
      );
      expect(byId(satisfied).get('tool:credentialed_tool:CRED_KEY')?.status).toBe('ok');
      expect(byId(satisfied).get('tool:credentialed_tool:CRED_URL')?.status).toBe('ok');
    });
  });

  describe('file rows', () => {
    it('tools[i].file, hooks[i].file and skills[i].dir are file rows, ok when the file exists', async () => {
      const rows = await computeRequirements(
        spec({
          tools: [{ file: 'tools/mine.ts' }],
          hooks: [{ id: 'h1', file: 'hooks/mine.ts' }],
          skills: [{ dir: 'skills/mine' }],
        }),
        deps({ fileExists: (rel) => rel === 'tools/mine.ts' })
      );
      const map = byId(rows);
      expect(map.get('file:tools/mine.ts')).toEqual({
        id: 'file:tools/mine.ts',
        kind: 'tool',
        status: 'ok',
        label: 'File tools/mine.ts',
      });
      expect(map.get('file:hooks/mine.ts')?.status).toBe('missing');
      expect(map.get('file:skills/mine')?.status).toBe('missing');
    });
  });

  describe('sorting, dedupe and the never-throw contract', () => {
    it('rows sort missing first, then unknown, then ok; ids sort inside a status', async () => {
      const rows = await computeRequirements(
        spec({
          model: 'google/gemini-x',
          tools: [{ builtin: 'no_such_tool' }, { registry: 'zzz' }],
          mcpServers: { aaa: { command: 'a', env: { V: { env: 'SET_VAR' } } } },
        }),
        deps({ env: { SET_VAR: 'x', GOOGLE_GENERATIVE_AI_API_KEY: 'k' } })
      );
      const rank = { missing: 0, unknown: 1, ok: 2 } as const;
      const statuses = rows.map((row) => row.status);
      for (let i = 1; i < statuses.length; i++) {
        expect(rank[statuses[i]]).toBeGreaterThanOrEqual(rank[statuses[i - 1]]);
        if (statuses[i] === statuses[i - 1]) {
          expect(rows[i].id >= rows[i - 1].id).toBe(true);
        }
      }
      expect(rows[0]).toMatchObject({ id: 'tool:no_such_tool', status: 'missing' });
      expect(statuses.at(-1)).toBe('ok');
    });

    it('an exception inside a helper logs one line and returns [] instead of throwing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = await computeRequirements(
        spec(),
        deps({
          catalog: {
            modelIds: async () => MODEL_IDS,
            builtinTools: async () => {
              throw new Error('catalog broke');
            },
          },
        })
      );
      expect(rows).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog broke'));
    });
  });
});

describe('requirementDeps.fileExists (prod dep)', () => {
  it('resolves under the workspace root and never stats outside it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa13-files-'));
    try {
      fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(root, 'tools', 'mine.ts'), 'export {};\n');
      const secretsStub = { getKey: () => undefined, getSecret: () => undefined } as unknown as SecretsStore;
      const d = requirementDeps(root, secretsStub);
      expect(d.fileExists('tools/mine.ts')).toBe(true);
      // Traversal and absolute paths are reported missing without leaving root.
      expect(d.fileExists('../../etc/passwd')).toBe(false);
      expect(d.fileExists('../../../outside.txt')).toBe(false);
      expect(d.fileExists(path.resolve(root, '..', 'outside.txt'))).toBe(false);
      expect(d.fileExists('tools/missing.ts')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
