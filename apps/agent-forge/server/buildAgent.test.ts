import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { type AgentSpec } from 'lousho';
import { buildAgentFromSpec } from './buildAgent';
import { SecretsStore } from './secretsStore';

const BASE_SPEC: AgentSpec = {
  name: 'test-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

describe('buildAgentFromSpec - provider resolution', () => {
  let baseDir: string;
  let secretsStore: SecretsStore;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r-buildagent-'));
    secretsStore = new SecretsStore(baseDir);
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it('never substitutes mock for an env-only real provider (ollama)', () => {
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'ollama', model: 'llama3' } };
    const built = buildAgentFromSpec(spec, 'agent-ollama', undefined, { secretsStore });
    expect(built.provider.name).not.toBe('mock');
  });

  it('an openrouter agent with neither a stored key nor the env var throws LOUSHO_PROVIDER_MISSING_API_KEY', () => {
    delete process.env.OPENROUTER_API_KEY;
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'openrouter', model: 'openai/gpt-4o-mini' } };
    expect(() => buildAgentFromSpec(spec, 'agent-or', undefined, { secretsStore })).toThrow(/No API key for provider 'openrouter'/);
  });
});
