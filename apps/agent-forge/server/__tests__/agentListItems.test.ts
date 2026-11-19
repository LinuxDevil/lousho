import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentListItems } from '../routes/agentListItems';

const SECRETS = { GITHUB_TOKEN: 'ghp_x', JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' };
const secrets = { getSecret: (name: string) => (SECRETS as Record<string, string>)[name] };

const spec = (extra: Record<string, unknown>): AgentSpecV2 =>
  ({ version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...extra }) as unknown as AgentSpecV2;

describe('agent list accounts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function accountsOf(agent: AgentSpecV2, withSecrets = true): Promise<string[] | undefined> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-list-accounts-'));
    dirs.push(root);
    const repo = {
      listIds: () => ['a'],
      readSpec: async () => agent,
      readMeta: async () => ({ enabled: true, labels: [], publishedVersion: null }),
      updatedAt: () => new Date(0).toISOString(),
    };
    const [item] = await buildAgentListItems({ repo: repo as never, root, ...(withSecrets && { secrets }) });
    return item?.accounts;
  }

  it('lists declared and auto-attached accounts once each', async () => {
    const declared = spec({ tools: [{ integration: 'github', credentials: { token: { secret: 'MINE' } } }], mcpServers: { docs: { url: 'https://e.com' } } });
    expect(await accountsOf(declared)).toEqual(['github', 'jira', 'confluence']);
  });

  it('lists nothing when no account is connected', async () => {
    expect(await accountsOf(spec({}), false)).toEqual([]);
  });

  it('gives a flow agent only what its spec declares', async () => {
    const flow = spec({ flow: { nodes: [] }, tools: [{ integration: 'figma', credentials: { token: { secret: 'F' } } }] });
    expect(await accountsOf(flow)).toEqual(['figma']);
  });
});
