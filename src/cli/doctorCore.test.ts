import { describe, it, expect, vi } from 'vitest';
import { runDoctor } from './doctorCore';
import { renderJson, renderReport } from './doctorRender';
import type { DoctorCheck, DoctorEnvironment } from './doctorTypes';
import type { AgentSpec } from '../spec/schema';

const SECRET = 'sk-super-secret-value-123456';

const INSTALLED: Record<string, string> = {
  ai: '4.3.19',
  zod: '3.25.76',
  '@ai-sdk/openai': '0.0.42',
  '@ai-sdk/anthropic': '0.0.42',
  'ollama-ai-provider': '1.2.0',
  dockerode: '5.0.1',
  '@modelcontextprotocol/sdk': '1.31.0',
  prompts: '2.4.2',
};

function makeEnv(overrides: Partial<DoctorEnvironment> = {}): DoctorEnvironment {
  return {
    nodeVersion: '22.19.0',
    env: {},
    sdk: {
      engines: { node: '>=22.19.0' },
      peerDependencies: {
        ai: '^4.3.19',
        zod: '^3.25.76',
        '@ai-sdk/openai': '^0.0.42',
        '@ai-sdk/anthropic': '^0.0.42',
        'ollama-ai-provider': '^1.2.0',
        dockerode: '^5.0.1',
        '@modelcontextprotocol/sdk': '^1.31.0',
        prompts: '^2.4.2',
      },
    },
    resolvePackageVersion: (name) => INSTALLED[name] ?? null,
    loadSpec: () => {
      throw new Error('no spec');
    },
    resolveTool: () => ({}),
    commandExists: () => true,
    fetch: async () => ({ ok: true, status: 200 }),
    dockerReachable: async () => true,
    ...overrides,
  };
}

async function check(env: DoctorEnvironment, id: string): Promise<DoctorCheck> {
  const report = await runDoctor(env);
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check '${id}' in ${report.checks.map((c) => c.id).join(', ')}`);
  return found;
}

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return { name: 'bot', prompt: 'hi', provider: { type: 'openai', model: 'gpt-4o' }, ...overrides };
}

describe('required peers', () => {
  it('ok without a declared range', async () => {
    const result = await check(makeEnv({ sdk: { engines: { node: '>=1' } } }), 'peer.ai');
    expect(result.status).toBe('ok');
  });
});

describe('optional provider peers', () => {
  it('warn on an out-of-range version, fail when needed', async () => {
    const old = (n: string) => (n === 'ollama-ai-provider' ? '0.1.0' : INSTALLED[n] ?? null);
    expect((await check(makeEnv({ resolvePackageVersion: old }), 'optional-peer.ollama-ai-provider')).status).toBe('warn');
    const needed = makeEnv({
      resolvePackageVersion: old,
      specPath: 'a.yaml',
      loadSpec: () => spec({ provider: { type: 'ollama', model: 'llama3' } }),
    });
    expect((await check(needed, 'optional-peer.ollama-ai-provider')).status).toBe('fail');
  });
});

describe('ai / provider package pairing', () => {
  const WIDE_PEERS = {
    ai: '^4.3.19 || ^6.0.0 || ^7.0.0',
    zod: '^3.25.76',
    '@ai-sdk/openai': '^0.0.42 || ^1.0.0 || ^3.0.0 || ^4.0.0',
    '@ai-sdk/anthropic': '^0.0.42 || ^1.0.0 || ^3.0.0 || ^4.0.0',
  };
  const installed = (versions: Record<string, string | null>) => (n: string) =>
    n in versions ? versions[n] : INSTALLED[n] ?? null;
  const envWith = (versions: Record<string, string | null>, extra: Partial<DoctorEnvironment> = {}) =>
    makeEnv({ sdk: { peerDependencies: WIDE_PEERS }, resolvePackageVersion: installed(versions), ...extra });

  it('a missing or unsupported ai gets one installable range, and provider hints for ai 7', async () => {
    for (const ai of [null, '5.0.0']) {
      expect((await check(envWith({ ai }), 'peer.ai')).fix).toMatch(/^npm install ai@\^7\.0\.0($| )/);
      expect((await check(envWith({ ai, '@ai-sdk/openai': null }), 'optional-peers.unused')).fix).toContain(
        'npm install @ai-sdk/openai@^4.0.0'
      );
    }
  });
});

describe('optional feature peers', () => {
  const without = (missing: string) => (n: string) => (n === missing ? null : INSTALLED[n] ?? null);

  it('dockerode fails when missing and the spec uses a sandboxed tool', async () => {
    const env = makeEnv({
      resolvePackageVersion: without('dockerode'),
      specPath: 'a.yaml',
      loadSpec: () => spec({ tools: ['sandboxed'] }),
      resolveTool: () => ({ requiresSandbox: true }),
    });
    expect((await check(env, 'optional-peer.dockerode')).status).toBe('fail');
  });
});

describe('API keys', () => {
  it('never leaks a key value into text or JSON output', async () => {
    const env = makeEnv({
      env: { OPENAI_API_KEY: SECRET, ANTHROPIC_API_KEY: `${SECRET}-2`, OPENROUTER_API_KEY: SECRET },
    });
    const report = await runDoctor(env);
    for (const output of [renderReport(report), renderReport(report, { color: true }), renderJson(report)]) {
      expect(output).not.toContain('sk-');
      expect(output).not.toContain('secret');
    }
  });
});

describe('spec checks', () => {
  const withSpec = (loaded: AgentSpec, extra: Partial<DoctorEnvironment> = {}) =>
    makeEnv({ specPath: 'a.yaml', loadSpec: () => loaded, ...extra });

  it('reports validation errors with field paths', async () => {
    const env = makeEnv({
      specPath: 'a.yaml',
      loadSpec: () => {
        throw new Error("loadSpec: 'a.yaml' failed validation - 'provider.model': Required");
      },
    });
    const result = await check(env, 'spec');
    expect(result.status).toBe('fail');
    expect(result.finding).toContain("'provider.model'");
  });
  it('checks tools against the built-in registry', async () => {
    const resolveTool = (name: string) => {
      if (name === 'nope') throw new Error("unknown tool 'nope'");
      return {};
    };
    const env = withSpec(spec({ tools: ['http', 'nope'] }), { resolveTool });
    expect((await check(env, 'spec.tool.http')).status).toBe('ok');
    const bad = await check(env, 'spec.tool.nope');
    expect(bad.status).toBe('fail');
    expect(bad.fix).toContain("Remove 'nope'");
  });
  it('checks MCP server commands from the validated spec field', async () => {
    const commandExists = (command: string) => command === 'npx';
    const env = withSpec(
      spec({
        mcpServers: {
          fs: { command: 'npx' },
          gone: { command: 'nonexistent' },
          docs: { url: 'https://example.com/mcp' },
        },
      }),
      { commandExists }
    );
    expect((await check(env, 'spec.mcp.fs')).status).toBe('ok');
    const gone = await check(env, 'spec.mcp.gone');
    expect(gone.status).toBe('fail');
    expect(gone.fix).toContain('mcpServers.gone.command');
    expect((await check(env, 'spec.mcp.docs')).status).toBe('ok');
  });
});

describe('spec policy checks', () => {
  const withPolicy = (policy: AgentSpec['policy']) =>
    makeEnv({ specPath: 'a.yaml', loadSpec: () => spec({ policy }) });

  it('reports one line per policy block', async () => {
    const report = await runDoctor(
      withPolicy({
        requiresApproval: ['send_email'],
        guardrails: ['max-length', { name: 'deny-topics', topics: ['x'] }],
        limits: { maxSteps: 4 },
        askQuestion: true,
        compaction: true,
      })
    );
    const lines = report.checks.filter((c) => c.id.startsWith('spec.policy.')).map((c) => [c.id, c.status, c.finding]);
    expect(lines).toEqual([
      ['spec.policy.approval', 'ok', 'asks for approval before: send_email'],
      ['spec.policy.guardrails', 'ok', 'max-length, deny-topics'],
      ['spec.policy.limits', 'ok', 'maxSteps=4'],
      ['spec.policy.askQuestion', 'ok', 'the agent can ask the user questions'],
      ['spec.policy.compaction', 'ok', 'on'],
    ]);
  });

  it('flags unknown guardrail names with did-you-mean and the available names', async () => {
    const result = await check(withPolicy({ guardrails: ['deny-topic', 'secret-scan'] }), 'spec.policy.guardrails');
    expect(result.status).toBe('fail');
    expect(result.finding).toContain("unknown guardrail 'deny-topic' (did you mean 'deny-topics'?)");
    expect(result.finding).toContain('Available: max-length, secret-scan, regex, deny-topics, llm-judge, pii, secrets, prompt-injection, moderation');
    expect(result.fix).toContain('policy.guardrails');
  });
});

describe('OpenAI base URL and --ping', () => {

  it('--ping GETs <base>/models for each configured provider, with its key and a timeout', async () => {
    const fetch = vi.fn(async (_url: string, _init: { signal: AbortSignal; headers?: Record<string, string> }) => ({ ok: true, status: 200 }));
    const env = makeEnv({ env: { OPENAI_API_KEY: 'any', OPENAI_BASE_URL: 'http://localhost:1234/v1/', ANTHROPIC_API_KEY: SECRET }, fetch });
    const report = await runDoctor(env, { ping: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['http://localhost:1234/v1/models', 'https://api.anthropic.com/v1/models']);
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer any' });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[1][1].headers).toMatchObject({ 'x-api-key': SECRET });
    expect(report.checks.find((c) => c.id === 'ping.openai')).toMatchObject({
      status: 'ok',
      title: 'openai endpoint (GET http://localhost:1234/v1/models)',
      finding: 'reachable (HTTP 200; reachability only, the key is not checked)',
    });
  });

  it('--ping warns on an unreachable server and on a rejected key', async () => {
    const down = makeEnv({ env: { OPENAI_BASE_URL: 'http://localhost:1/v1' }, fetch: async () => Promise.reject(new Error('fetch failed')) });
    expect(await runDoctor(down, { ping: true }).then((r) => r.checks.find((c) => c.id === 'ping.openai'))).toMatchObject({
      status: 'warn',
      finding: 'unreachable (fetch failed)',
      fix: expect.stringContaining('OPENAI_BASE_URL'),
    });
    const rejected = makeEnv({ env: { OPENROUTER_API_KEY: SECRET }, fetch: async () => ({ ok: false, status: 401 }) });
    const report = await runDoctor(rejected, { ping: true });
    const result = report.checks.find((c) => c.id === 'ping.openrouter');
    // A key the provider rejects is a failure: every model call would fail the same way.
    expect(result).toMatchObject({ status: 'fail', fix: 'Check OPENROUTER_API_KEY.' });
    expect(result?.finding).toContain('key was rejected');
    expect(report.exitCode).toBe(1);
  });
});

describe('docker check', () => {
  it('warn when unreachable and a sandboxed tool is configured', async () => {
    const env = makeEnv({
      dockerReachable: async () => {
        throw new Error('no socket');
      },
      specPath: 'a.yaml',
      loadSpec: () => spec({ tools: ['sandboxed'] }),
      resolveTool: () => ({ requiresSandbox: true }),
    });
    const result = await check(env, 'docker');
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('Docker');
  });
});

describe('agent directory', () => {
  const dirEnv = (overrides: Partial<DoctorEnvironment> = {}) =>
    makeEnv({
      specPath: '/p/ck',
      isDirectory: () => true,
      loadAgentDir: async () => ({ name: 'ck', model: 'anthropic/claude-x', tools: ['read_file', 'edit_file'] }),
      ...overrides,
    });

  it('flags an unknown provider in the model string', async () => {
    const env = dirEnv({ loadAgentDir: async () => ({ name: 'ck', model: 'gemini/pro', tools: [] }) });
    expect(await check(env, 'spec.provider')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/^Set the config's model/) });
  });

  it('warns about a permission rule naming a tool the agent does not have, with the suggestion', async () => {
    const env = dirEnv({
      loadAgentDir: async () => ({
        name: 'ck',
        model: 'anthropic/claude-x',
        tools: ['write_file'],
        permissionIssues: ["permissions[0] names the tool 'write_flie', which no tool of the agent has, so the rule never applies. Did you mean 'write_file'?"],
      }),
    });
    expect(await check(env, 'spec.permissions.0')).toMatchObject({ status: 'warn', finding: expect.stringContaining("Did you mean 'write_file'?") });
  });
});

describe('agent module', () => {
  const moduleEnv = (overrides: Partial<DoctorEnvironment> = {}) =>
    makeEnv({
      specPath: '/p/src/agent.ts',
      loadAgentModule: async () => ({ name: 'agent', model: 'openrouter/openai/gpt-4o-mini', tools: ['current_time'] }),
      ...overrides,
    });

  it('reports a module that fails to load, naming the file', async () => {
    const env = moduleEnv({
      loadAgentModule: async () => {
        throw new Error('it must export a SimpleAgent or a createAgent() config');
      },
    });
    expect(await check(env, 'spec')).toMatchObject({ status: 'fail', title: 'Agent module', fix: 'Fix the file named above: /p/src/agent.ts.' });
  });
});
