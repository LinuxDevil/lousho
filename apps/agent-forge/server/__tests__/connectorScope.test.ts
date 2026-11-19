import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2, ToolDescriptor } from 'lousho';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileApprovalStore } from '../approvalStore';
import { buildRunnableAgent, type StudioRunDeps } from '../buildAgentV2';
import { FileCheckpointStore } from '../checkpointStore';
import { connectorShellEnv } from '../connectorRunTools';
import { runSetupLogEntry } from '../logEntries';

const captured = vi.hoisted(() => ({ config: undefined as { tools?: Record<string, ToolDescriptor> } | undefined }));

vi.mock('lousho', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lousho')>();
  return {
    ...actual,
    createAgent: ((config: { tools?: Record<string, ToolDescriptor> }) => {
      captured.config = config;
      return {};
    }) as unknown as typeof actual.createAgent,
  };
});

const SECRET_VALUES = { GITHUB_TOKEN: 'ghp_secretvalue', JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'jira_secretvalue' };
const secrets = { getSecret: (name: string) => (SECRET_VALUES as Record<string, string>)[name] };
const base = { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x' } as unknown as AgentSpecV2;
const wiring = { onEvent: () => {}, exporter: { export: () => {} } as never };

describe('connected accounts on a built agent', () => {
  let dir: string;
  let deps: StudioRunDeps;

  beforeEach(() => {
    captured.config = undefined;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-connector-scope-')));
    deps = { baseDir: dir, checkpointStore: new FileCheckpointStore(dir), approvalStore: new FileApprovalStore(dir), secretsStore: secrets as never };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attaches GitHub tools with write tools asking for approval', async () => {
    await buildRunnableAgent(base, 'a', deps, wiring);
    const tools = captured.config?.tools ?? {};
    expect(tools.github_list_my_repositories).toBeDefined();
    expect(tools.github_list_my_repositories.needsApproval).toBeFalsy();
    expect(tools.github_create_repository.needsApproval).toBeTruthy();
  });

  it('attaches nothing when connectedAccounts is false', async () => {
    await buildRunnableAgent(base, 'a', deps, { ...wiring, connectedAccounts: false });
    const tools = captured.config?.tools ?? {};
    expect(tools.github_list_my_repositories).toBeUndefined();
    expect(tools.github_create_repository).toBeUndefined();
  });

  it('gives the shell only the GitHub variables, and only with GitHub attached', async () => {
    expect(Object.keys(connectorShellEnv(secrets)).sort()).toEqual([
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_TERMINAL_PROMPT',
    ]);
    expect(connectorShellEnv({ getSecret: (name) => (name === 'JIRA_API_TOKEN' ? 'j' : undefined) })).toEqual({});

    const spec = { ...base, tools: [{ builtin: 'shell', options: { root: dir } }] } as AgentSpecV2;
    const probe = 'node -e "console.log(JSON.stringify([process.env.GITHUB_TOKEN, process.env.JIRA_API_TOKEN]))"';

    await buildRunnableAgent(spec, 'a', deps, wiring);
    const attached = JSON.stringify(await captured.config?.tools?.shell.execute?.({ command: probe } as never, {} as never));
    expect(attached).toContain('ghp_secretvalue');
    expect(attached).not.toContain('jira_secretvalue');

    await buildRunnableAgent(spec, 'a', deps, { ...wiring, connectedAccounts: false });
    const detached = JSON.stringify(await captured.config?.tools?.shell.execute?.({ command: probe } as never, {} as never));
    expect(detached).not.toContain('ghp_secretvalue');
  });

  it('summarises what the run was given', async () => {
    const spec = { ...base, mcpServers: { docs: { url: 'https://example.com/mcp' } } } as unknown as AgentSpecV2;
    const { setup } = await buildRunnableAgent(spec, 'a', { ...deps, secretsStore: { getSecret: (name: string) => (name === 'JIRA_API_TOKEN' ? undefined : (SECRET_VALUES as Record<string, string>)[name]) } as never }, wiring);
    const github = setup.accounts.find((account) => account.integration === 'github');
    expect(setup.accounts.map((account) => account.integration)).toEqual(['github']);
    expect(github?.tools).toContain('github_list_my_repositories');
    expect(github?.approvals).toContain('github_create_repository');
    expect(github?.approvals).not.toContain('github_list_my_repositories');
    expect(setup.mcpServers).toEqual(['docs']);
    expect(setup.declared).toEqual([]);
    expect(setup.tools).toBe(setup.toolNames?.length);
    expect(setup.skipped).toEqual([{ integration: 'jira', reason: 'incomplete', missing: ['API token'] }, { integration: 'confluence', reason: 'incomplete', missing: ['API token'] }]);
    expect(JSON.stringify(setup)).not.toContain('secretvalue');
    const row = runSetupLogEntry('a', setup);
    expect(row.message).toMatch(/^Setup · 1 connected account \(github\) · 1 MCP server · \d+ tools?$/);
    expect(row.detail).toContain('Jira is missing its API token.');
    expect(row.detail).toContain('github_create_repository');
  });

  it('reports a connected account as off when attaching is disabled', async () => {
    const { setup } = await buildRunnableAgent(base, 'a', deps, { ...wiring, connectedAccounts: false });
    expect(setup.accounts).toEqual([]);
    expect(setup.skipped).toEqual(expect.arrayContaining([{ integration: 'github', reason: 'off' }]));
    expect(runSetupLogEntry('a', setup).detail).toContain('Github is connected but switched off for this kind of run.');
  });

  it('points at Profile when nothing is connected', async () => {
    const { setup } = await buildRunnableAgent(base, 'a', { ...deps, secretsStore: { getSecret: () => undefined } as never }, wiring);
    expect(setup.skipped).toEqual([]);
    expect(runSetupLogEntry('a', setup).message).toBe('Setup · No connected accounts. Connect one in Profile → Connectors. · 0 tools');
  });

  it('explains that flow agents get no connected accounts', () => {
    const row = runSetupLogEntry('a', { accounts: [], declared: [], mcpServers: [], skipped: [], note: 'Flow agents do not get connected accounts yet.' });
    expect(row.message).toBe('Setup · Flow agents do not get connected accounts yet.');
  });
});
