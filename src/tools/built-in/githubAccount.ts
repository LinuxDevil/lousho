import { z } from 'zod';
import { defineTool } from '../defineTool';
import type { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { toolFailure } from './toolFailure';

const GITHUB_API = 'https://api.github.com';
const MAX_BODY_CHARS = 30_000;

async function call(token: string, method: string, apiPath: string, body?: unknown): Promise<string> {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lousho',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw toolFailure(`GitHub ${method} ${apiPath} answered ${res.status}: ${clip(text)}`);
  return text;
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

export function createGitHubAccountTools(token: string): Record<string, ToolDescriptor> {
  const tools = [
    defineTool({
      name: 'github_list_my_repositories',
      description: 'List repositories the GitHub account can access, most recently pushed first.',
      input: z.object({ perPage: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() }),
      execute: async ({ perPage = 30, page = 1 }) => {
        const repos = JSON.parse(await call(token, 'GET', `/user/repos?sort=pushed&per_page=${perPage}&page=${page}`)) as Array<Record<string, unknown>>;
        return JSON.stringify(repos.map((r) => ({ fullName: r.full_name, private: r.private, url: r.html_url, cloneUrl: r.clone_url, defaultBranch: r.default_branch })));
      },
    }),
    defineTool({
      name: 'github_create_repository',
      description: 'Create a repository on the GitHub account, or in an organization. Push to its cloneUrl with git.',
      input: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        private: z.boolean().optional(),
        org: z.string().optional().describe('Organization login; omit to create under the account.'),
      }),
      needsApproval: true,
      execute: async ({ org, ...repo }) => {
        const created = JSON.parse(await call(token, 'POST', org === undefined ? '/user/repos' : `/orgs/${encodeURIComponent(org)}/repos`, repo)) as Record<string, unknown>;
        return JSON.stringify({ fullName: created.full_name, url: created.html_url, cloneUrl: created.clone_url });
      },
    }),
    defineTool({
      name: 'github_api',
      description: 'Call any GitHub REST API endpoint as the account, e.g. GET /repos/{owner}/{repo}/pulls. Returns the response body.',
      input: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().regex(/^\/[^/]/, 'A path under https://api.github.com, starting with /'),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      needsApproval: async ({ method }) => method !== 'GET',
      execute: async ({ method, path, body }) => clip(await call(token, method, path, body)),
    }),
  ];
  return Object.fromEntries(
    tools.map((tool) => {
      routeFetchThroughSandbox(tool);
      return [tool.name, tool];
    })
  );
}
