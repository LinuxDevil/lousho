import { defineTool, type AgentSpecV2, type ToolDescriptor } from 'lousho';
import { z } from 'zod';
import { INTEGRATION_CREDENTIALS, type IntegrationName, type ToolRef } from 'lousho/spec';
import { createShellTool, NodeWorkspace } from 'lousho/tools';
import { CONNECTORS, INTEGRATION_SECRETS } from '../shared/profileWire';

type SecretSource = { getSecret(name: string): string | undefined } | undefined;

const READ_ONLY_TOOL = /_(get|list|search|read|lookup|resolve|check|download)(_|$)/;

export function withConnectedIntegrations(spec: AgentSpecV2, secrets: SecretSource): { spec: AgentSpecV2; added: number } {
  if (secrets === undefined) return { spec, added: 0 };
  const declared = new Set((spec.tools ?? []).flatMap((ref) => ('integration' in ref ? [ref.integration] : [])));
  const added: ToolRef[] = [];
  for (const [name, { credentials }] of Object.entries(INTEGRATION_SECRETS)) {
    const integration = name as IntegrationName;
    if (integration === 'github' || declared.has(integration)) continue;
    const present = Object.entries(credentials).filter(([, secret]) => secrets.getSecret(secret) !== undefined);
    const keys = new Set(present.map(([key]) => key));
    if (present.length === 0 || !INTEGRATION_CREDENTIALS[integration].required.every((key) => keys.has(key))) continue;
    added.push({
      id: `connector-${integration}`,
      integration,
      credentials: Object.fromEntries(present.map(([key, secret]) => [key, { secret }])),
      deferLoading: true,
    });
  }
  if (added.length === 0) return { spec, added: 0 };
  return { spec: { ...spec, tools: [...(spec.tools ?? []), ...added] }, added: added.length };
}

export function guardConnectorWrites(tools: Record<string, ToolDescriptor>, names: readonly (readonly string[])[]): void {
  for (const name of names.flat()) {
    const tool = tools[name];
    if (tool !== undefined && tool.needsApproval === undefined && !READ_ONLY_TOOL.test(name)) {
      tools[name] = { ...tool, needsApproval: true };
    }
  }
}

export function connectorShellEnv(secrets: SecretSource): Record<string, string> {
  const env: Record<string, string> = {};
  if (secrets === undefined) return env;
  for (const def of CONNECTORS) {
    for (const field of def.fields) {
      const value = secrets.getSecret(field.secret);
      if (value !== undefined) env[field.secret] = value;
    }
  }
  const token = env.GITHUB_TOKEN;
  if (token !== undefined) {
    env.GH_TOKEN = token;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

const GITHUB_API = 'https://api.github.com';
const MAX_BODY_CHARS = 30_000;

async function github(token: string, method: string, apiPath: string, body?: unknown): Promise<string> {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lousho-studio',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const trimmed = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
  if (!res.ok) throw new Error(`GitHub ${method} ${apiPath} answered ${res.status}: ${trimmed}`);
  return trimmed;
}

export function githubAccountTools(token: string): Record<string, ToolDescriptor> {
  const tools = [
    defineTool({
      name: 'github_list_my_repositories',
      description: 'List repositories the connected GitHub account can access, most recently pushed first.',
      input: z.object({ perPage: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() }),
      deferLoading: true,
      execute: async ({ perPage = 30, page = 1 }) => {
        const repos = JSON.parse(await github(token, 'GET', `/user/repos?sort=pushed&per_page=${perPage}&page=${page}`)) as Array<Record<string, unknown>>;
        return JSON.stringify(repos.map((r) => ({ fullName: r.full_name, private: r.private, url: r.html_url, cloneUrl: r.clone_url, defaultBranch: r.default_branch })));
      },
    }),
    defineTool({
      name: 'github_create_repository',
      description: 'Create a repository on the connected GitHub account (or in an organization). Push to its cloneUrl with git from the shell.',
      input: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        private: z.boolean().optional(),
        org: z.string().optional().describe('Organization login; omit to create under the connected user.'),
      }),
      deferLoading: true,
      needsApproval: true,
      execute: async ({ org, ...repo }) => {
        const created = JSON.parse(await github(token, 'POST', org === undefined ? '/user/repos' : `/orgs/${encodeURIComponent(org)}/repos`, repo)) as Record<string, unknown>;
        return JSON.stringify({ fullName: created.full_name, url: created.html_url, cloneUrl: created.clone_url });
      },
    }),
    defineTool({
      name: 'github_api',
      description: 'Call any GitHub REST API endpoint as the connected account, e.g. GET /repos/{owner}/{repo}/pulls. Returns the response body.',
      input: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().regex(/^\/[^/]/, 'A path under https://api.github.com, starting with /'),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      deferLoading: true,
      needsApproval: async ({ method }) => method !== 'GET',
      execute: async ({ method, path: apiPath, body }) => github(token, method, apiPath, body),
    }),
  ];
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

export function connectedAccountsForAuthor(secrets: SecretSource): string[] {
  if (secrets === undefined) return [];
  const lines: string[] = [];
  for (const [integration, { credentials }] of Object.entries(INTEGRATION_SECRETS)) {
    const present = Object.entries(credentials).filter(([, secret]) => secrets.getSecret(secret) !== undefined);
    if (present.length === 0) continue;
    const refs = JSON.stringify(Object.fromEntries(present.map(([key, secret]) => [key, { secret }])));
    const extra = integration === 'github' ? ' plus "owner" and "repo" strings to pin one repo; without it every run already gets github_list_my_repositories, github_create_repository and github_api, and the shell has GITHUB_TOKEN and git push auth' : '';
    lines.push(`- ${integration}: { "integration": "${integration}", "credentials": ${refs} }${extra}`);
  }
  return lines;
}

export function withShellEnv(tools: Record<string, ToolDescriptor>, spec: AgentSpecV2, env: Record<string, string>): void {
  const shell = tools.shell;
  const ref = (spec.tools ?? []).find((r) => 'builtin' in r && r.builtin === 'shell');
  const root = (ref as { options?: { root?: unknown } } | undefined)?.options?.root;
  if (shell === undefined || typeof root !== 'string' || Object.keys(env).length === 0) return;
  const fresh = createShellTool(new NodeWorkspace({ root, env }));
  tools.shell = { ...shell, execute: fresh.execute };
}
