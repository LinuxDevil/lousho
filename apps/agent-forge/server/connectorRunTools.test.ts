import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2, ToolDescriptor } from 'lousho';
import { describe, expect, it } from 'vitest';
import { buildTurnContext } from './author/turnContext';
import { connectedAccountsForAuthor, connectorShellEnv, guardConnectorWrites, mcpConnectorsForAuthor, withConnectedIntegrations, withMcpConnectors, withShellEnv } from './connectorRunTools';

const store = (values: Record<string, string>) => ({ getSecret: (name: string) => values[name] });
const base = { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x' } as unknown as AgentSpecV2;

describe('connectorRunTools', () => {
  it('adds deferred refs only for fully connected integrations the spec does not declare', () => {
    const secrets = store({ JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't', FIGMA_TOKEN: 'f', JENKINS_BASE_URL: 'https://j' });
    const spec = { ...base, tools: [{ integration: 'figma', credentials: { token: { secret: 'MINE' } } }] } as AgentSpecV2;
    const { spec: out, added } = withConnectedIntegrations(spec, secrets);
    const refs = (out.tools ?? []) as Array<{ integration?: string; deferLoading?: boolean; credentials?: unknown }>;
    expect(added).toBe(2);
    expect(refs.map((r) => r.integration)).toEqual(['figma', 'jira', 'confluence']);
    expect(refs[1]).toMatchObject({ deferLoading: true, credentials: { apiToken: { secret: 'JIRA_API_TOKEN' } } });
    const github = withConnectedIntegrations(base, store({ GITHUB_TOKEN: 'g' }));
    expect(github.spec.tools).toEqual([{ id: 'connector-github', integration: 'github', credentials: { token: { secret: 'GITHUB_TOKEN' } }, deferLoading: true }]);
  });

  it('makes write tools ask and leaves read tools alone', () => {
    const tool = {} as ToolDescriptor;
    const tools: Record<string, ToolDescriptor> = { jira_get_ticket: tool, jira_create_ticket: tool, send_email: tool, confluence_search: tool };
    guardConnectorWrites(tools, [['jira_get_ticket', 'jira_create_ticket'], ['send_email', 'confluence_search']]);
    expect(tools.jira_get_ticket.needsApproval).toBeUndefined();
    expect(tools.confluence_search.needsApproval).toBeUndefined();
    expect(tools.jira_create_ticket.needsApproval).toBe(true);
    expect(tools.send_email.needsApproval).toBe(true);
  });

  it('tells the Author which accounts are connected and how to reference them', () => {
    const lines = connectedAccountsForAuthor(store({ FIGMA_TOKEN: 'f', GITHUB_TOKEN: 'g' }));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('"integration": "figma", "credentials": {"token":{"secret":"FIGMA_TOKEN"}}');
    expect(lines.join('\n')).toContain('account-wide');
    expect(lines.join('\n')).not.toContain('"f"');
    expect(buildTurnContext({ focus: { mode: 'create' }, openProposals: [], connectedAccounts: lines, now: new Date(0) })).toContain('Connected accounts');
  });

  it('gives the shell git auth for github.com and nothing from other connectors', async () => {
    const env = connectorShellEnv(store({ GITHUB_TOKEN: 'ghp_x', JIRA_API_TOKEN: 'jira_x' }));
    expect(env.JIRA_API_TOKEN).toBeUndefined();
    expect(connectorShellEnv(store({ JIRA_API_TOKEN: 'jira_x' }))).toEqual({});
    expect(env).toMatchObject({ GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'ghp_x', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader' });
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.split(' ').pop() ?? '', 'base64').toString()).toBe('x-access-token:ghp_x');

    const root = mkdtempSync(path.join(tmpdir(), 'shellenv-'));
    const spec = { ...base, tools: [{ builtin: 'shell', options: { root } }] } as AgentSpecV2;
    const tools = { shell: { needsApproval: false, execute: async () => 'old' } as unknown as ToolDescriptor };
    withShellEnv(tools, spec, env);
    expect(tools.shell.needsApproval).toBe(false);
    const result = JSON.stringify(await tools.shell.execute!({ command: 'node -e "console.log(process.env.GITHUB_TOKEN)"' } as never, {} as never));
    expect(result).toContain('ghp_x');
  });

  describe('MCP connectors', () => {
    const connectors = [
      { name: 'tracker', url: 'https://tracker.example.com/mcp', tokenSecret: 'MCP_TRACKER_TOKEN' },
      { name: 'wiki', url: 'https://wiki.example.com/mcp' },
      { name: 'same-url', url: 'https://docs.example.com/mcp/' },
    ];
    const secrets = { getSecret: () => undefined, mcpConnectors: () => connectors };

    it('adds stored connectors with approval, deferral and a secret reference', () => {
      const { spec, names } = withMcpConnectors(base, secrets);
      expect(names).toEqual(['tracker', 'wiki', 'same-url']);
      expect(spec.mcpServers?.tracker).toEqual({
        url: 'https://tracker.example.com/mcp',
        approval: 'always',
        deferLoading: true,
        optional: true,
        headers: { Authorization: { secret: 'MCP_TRACKER_TOKEN' } },
      });
      expect(spec.mcpServers?.wiki).toEqual({ url: 'https://wiki.example.com/mcp', approval: 'always', deferLoading: true, optional: true });
    });

    it('skips a connector whose name or URL the spec already has, and changes nothing without one', () => {
      const own = { ...base, mcpServers: { tracker: { url: 'https://elsewhere.example.com' }, mine: { url: 'https://docs.example.com/mcp' } } } as unknown as AgentSpecV2;
      const { spec, names } = withMcpConnectors(own, secrets);
      expect(names).toEqual(['wiki']);
      expect(Object.keys(spec.mcpServers ?? {})).toEqual(['tracker', 'mine', 'wiki']);
      expect(spec.mcpServers?.tracker).toEqual({ url: 'https://elsewhere.example.com' });
      expect(withMcpConnectors(base, store({})).spec).toBe(base);
    });

    it('tells the Author each connector name and host, never a token', () => {
      const lines = mcpConnectorsForAuthor(secrets);
      expect(lines).toEqual(['- tracker: tracker.example.com', '- wiki: wiki.example.com', '- same-url: docs.example.com']);
      const context = buildTurnContext({ focus: { mode: 'create' }, openProposals: [], mcpConnectors: lines, now: new Date(0) });
      expect(context).toContain('MCP connectors (Profile)');
      expect(context).toContain('- tracker: tracker.example.com');
    });
  });
});
