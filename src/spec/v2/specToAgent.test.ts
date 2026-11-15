import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TraceExporter } from '../../execution/tracing';
import { LLMProviderRegistry } from '../../providers/llm';
import { createMockProvider } from '../../providers/mock';
import type { AgentStore } from '../../storage/agentStore';
import type { SpecHost } from './host';
import { compileSpec, specV2ToAgent } from './specToAgent';
import type { AgentSpecV2 } from './types';

const DEFAULT_RESPONSES = ['deterministic response one', 'deterministic response two'];

/** The scripted replies the next 'mock' provider is created with; tests set it before building an agent. */
let responses = [...DEFAULT_RESPONSES];

beforeAll(() => {
  // The factory spreads the caller's config so the 'mock/<model>' half lands on defaultModel.
  LLMProviderRegistry.register('mock', (config) => createMockProvider({ ...config, responses }));
});

afterEach(() => {
  responses = [...DEFAULT_RESPONSES];
  vi.unstubAllEnvs();
});

function spec(overrides: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/m', instructions: 'You are a test agent.', ...overrides };
}

function host(overrides: Partial<SpecHost> = {}): SpecHost {
  return { baseDir: mkdtempSync(path.join(tmpdir(), 'lousho-spec-v2-')), ...overrides };
}

describe('compileSpec data section', () => {

  it('reads instructions.file relative to host.baseDir', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-v2-'));
    writeFileSync(path.join(dir, 'main.md'), 'You are file-based.');
    const { config } = await compileSpec(spec({ instructions: { file: 'main.md' } }), host({ baseDir: dir }));
    expect(config.instructions).toBe('You are file-based.');
  });

  it('sets host.store and host.exporter on the config only when given', async () => {
    const store = { sentinel: 'store' } as unknown as AgentStore;
    const exporter = { sentinel: 'exporter' } as unknown as TraceExporter;
    const withBoth = await compileSpec(spec(), host({ store, exporter }));
    expect(withBoth.config.store).toBe(store);
    expect(withBoth.config.exporter).toBe(exporter);
    const bare = await compileSpec(spec(), host());
    expect(bare.config.store).toBeUndefined();
    expect(bare.config.exporter).toBeUndefined();
  });
});

describe('compileSpec mcpServers section', () => {
  it('resolves { env } and { secret } refs through the host', async () => {
    const { config, mcpServers } = await compileSpec(
      spec({
        mcpServers: {
          api: { url: 'https://x.test/mcp', headers: { Authorization: { env: 'HDR' }, 'X-Key': { secret: 'tok' } } },
        },
      }),
      host({ env: { HDR: 'v1' }, resolveSecret: (name) => (name === 'tok' ? 's3' : undefined) })
    );
    expect(mcpServers['api']).toEqual({ url: 'https://x.test/mcp', headers: { Authorization: 'v1', 'X-Key': 's3' } });
    expect(config.mcpServers).toEqual(mcpServers);
  });
});

describe('compileSpec memory section', () => {

  it('wires the JSON-Schema adapter so itemJsonSchema needs no host support', async () => {
    const { config } = await compileSpec(
      spec({
        memory: [
          {
            name: 'facts',
            scope: 'global',
            provider: { type: 'in-memory' },
            itemJsonSchema: { type: 'object', properties: { text: { type: 'string' } } },
            itemKey: 'text',
          },
        ],
      }),
      host()
    );
    expect(config.memory?.[0]?.itemSchema).toBeDefined();
    expect(config.memory?.[0]?.itemKey).toEqual(['text']);
  });
});

describe('specV2ToAgent with every section', () => {
  it('compiles a spec using skills, memory, subagents, handoffs, guardrails, permissions and hooks', async () => {
    const input = spec({
      skills: [{ inline: { name: 'changelog', description: 'Write changelogs.', content: '# C' } }],
      memory: [{ name: 'notes', scope: 'session', provider: { type: 'in-memory' } }],
      subagents: {
        helper: { inline: { name: 'helper', model: 'mock/m', instructions: 'Help.', description: 'Helps.' } },
      },
      handoffs: [{ agent: 'helper' }],
      guardrails: [{ id: 'g1', name: 'deny-topics', on: 'input', options: { topics: ['weapons'] } }],
      permissions: [{ id: 'p1', tool: '*', action: 'allow' }],
      hooks: [{ id: 'h1', inline: { name: 'noop', point: 'postGenerate', code: 'return;' } }],
    });
    const agent = await specV2ToAgent(input, host({ inlineHook: (hook) => ({ name: hook.name, postGenerate: () => undefined }) }));
    const result = await agent.send('hi');
    expect(result.text).toBe('deterministic response one');
    expect(agent.spec).toEqual(input);
  });
});
