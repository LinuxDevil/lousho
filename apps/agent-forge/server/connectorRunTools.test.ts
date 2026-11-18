import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2, ToolDescriptor } from 'lousho';
import { describe, expect, it } from 'vitest';
import { buildTurnContext } from './author/turnContext';
import { connectedAccountsForAuthor, connectorShellEnv, githubAccountTools, guardConnectorWrites, withConnectedIntegrations, withShellEnv } from './connectorRunTools';

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
    expect(withConnectedIntegrations(base, store({ GITHUB_TOKEN: 'g' })).added).toBe(0);
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

  it('gives GitHub account tools that ask before writing and call the API as the token', async () => {
    const tools = githubAccountTools('ghp_x');
    const predicate = tools.github_api.needsApproval as (input: { method: string }) => Promise<boolean>;
    expect(await predicate({ method: 'GET' })).toBe(false);
    expect(await predicate({ method: 'POST' })).toBe(true);
    expect(tools.github_create_repository.needsApproval).toBe(true);

    const calls: Array<[string, RequestInit]> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ full_name: 'me/r', html_url: 'h', clone_url: 'c' }), { status: 201 });
    }) as typeof fetch;
    try {
      const out = await tools.github_create_repository.execute!({ name: 'r', private: true } as never, {} as never);
      expect(String(out)).toContain('me/r');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls[0][0]).toBe('https://api.github.com/user/repos');
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer ghp_x');
  });

  it('tells the Author which accounts are connected and how to reference them', () => {
    const lines = connectedAccountsForAuthor(store({ FIGMA_TOKEN: 'f', GITHUB_TOKEN: 'g' }));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('"integration": "figma", "credentials": {"token":{"secret":"FIGMA_TOKEN"}}');
    expect(lines.join('\n')).toContain('github_create_repository');
    expect(lines.join('\n')).not.toContain('"f"');
    expect(buildTurnContext({ focus: { mode: 'create' }, openProposals: [], connectedAccounts: lines, now: new Date(0) })).toContain('Connected accounts');
  });

  it('gives the shell the connector secrets and git auth for github.com', async () => {
    const env = connectorShellEnv(store({ GITHUB_TOKEN: 'ghp_x' }));
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
});
