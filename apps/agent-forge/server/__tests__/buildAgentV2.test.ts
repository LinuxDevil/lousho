/**
 * `buildRunnableAgent` (server/buildAgentV2.ts): one case per D12a
 * acceptance criterion. Runs go through the SDK's spec-v2 compiler
 * (`compileSpec`) with Studio's stores/keys wired in - the mock provider
 * (`mock/mock-1`) drives deterministic tool calls: it calls a tool whose
 * model-facing name appears in the last user message (see
 * src/providers/mock.ts's extractToolCalls).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createAgentConfigOf,
  type AgentEvent,
  type AgentSpecV2,
} from 'lousho';
import { withWorkspaceRoots, buildRunnableAgent, type RunWiring } from '../buildAgentV2';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';
import { SecretsStore } from '../secretsStore';

const BASE: AgentSpecV2 = {
  version: 2,
  name: 'test-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
};

function noopWiring(): { events: AgentEvent[]; wiring: RunWiring } {
  const events: AgentEvent[] = [];
  return {
    events,
    wiring: {
      onEvent: (event: AgentEvent) => events.push(event),
      exporter: { onSpanStart: () => {}, onSpanEnd: () => {} },
    },
  };
}

describe('buildRunnableAgent', () => {
  let baseDir: string;
  let approvalStore: FileApprovalStore;
  let checkpointStore: FileCheckpointStore;
  const savedEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-buildv2-'));
    approvalStore = new FileApprovalStore(baseDir);
    checkpointStore = new FileCheckpointStore(baseDir);
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const deps = () => ({ baseDir, checkpointStore, approvalStore });

  it('an ask permission rule pauses the run, filed under .lousho/agents/<agentId>/approvals/', async () => {
    const agentId = 'perm-agent';
    const spec: AgentSpecV2 = {
      ...BASE,
      tools: [{ builtin: 'current_date' }],
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    const { wiring } = noopWiring();
    const built = await buildRunnableAgent(spec, agentId, deps(), wiring);

    const result = await built.agent.send('please use current_date', { sessionId: agentId });
    expect(result.finishReason).toBe('awaiting-approval');
    expect(result.approvalId).toBeTruthy();

    const dir = path.join(baseDir, '.lousho', 'agents', agentId, 'approvals');
    expect(fs.existsSync(path.join(dir, `${result.approvalId}.json`))).toBe(true);
    const record = await approvalStore.peek(agentId, result.approvalId!);
    expect(record?.pending.toolName).toBe('current_date');
  });

  it('an anthropic model with a stored key builds; with neither key nor env it throws LOUSHO_PROVIDER_MISSING_API_KEY', async () => {
    const secretsStore = new SecretsStore(baseDir);
    const spec: AgentSpecV2 = { ...BASE, model: 'anthropic/claude-haiku-5-5' };
    await expect(buildRunnableAgent(spec, 'a1', { ...deps(), secretsStore }, noopWiring().wiring)).rejects.toMatchObject({
      code: 'LOUSHO_PROVIDER_MISSING_API_KEY',
    });
    secretsStore.setKey('anthropic', 'sk-ant-test');
    const built = await buildRunnableAgent(spec, 'a1', { ...deps(), secretsStore }, noopWiring().wiring);
    expect(built.modelLabel).toBe('anthropic/claude-haiku-5-5');
    expect(createAgentConfigOf(built.agent)?.model).toBe('claude-haiku-5-5');
  });

  it('fills a missing root on workspace builtins with the workspace folder and keeps an explicit one', () => {
    const spec: AgentSpecV2 = {
      ...BASE,
      tools: [{ builtin: 'workspace_read' }, { builtin: 'shell', options: { root: '/elsewhere' } }, { builtin: 'current_date' }],
    };
    expect(withWorkspaceRoots(spec, '/ws').tools).toEqual([
      { builtin: 'workspace_read', options: { root: '/ws' } },
      { builtin: 'shell', options: { root: '/elsewhere' } },
      { builtin: 'current_date' },
    ]);
  });
});
