import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIntegrationRef } from '../../spec/v2/resolve/integrationTools';
import { createGitHubAccountTools } from './githubAccount';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGitHubAccountTools', () => {
  it('asks before creating a repository or any non-GET call', async () => {
    const tools = createGitHubAccountTools('ghp_x');
    const predicate = tools['github_api'].needsApproval as (input: { method: string }) => Promise<boolean>;
    expect(await predicate({ method: 'GET' })).toBe(false);
    expect(await predicate({ method: 'DELETE' })).toBe(true);
    expect(tools['github_create_repository'].needsApproval).toBe(true);
    expect(tools['github_list_my_repositories'].needsApproval).toBeUndefined();
  });

  it('creates a repository as the token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ full_name: 'me/r', html_url: 'h', clone_url: 'c' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await createGitHubAccountTools('ghp_x')['github_create_repository'].execute!({ name: 'r', private: true } as never, {} as never);
    expect(String(out)).toContain('me/r');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/repos');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_x');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'r', private: true });
  });

  it('is what a github ref without owner and repo resolves to', async () => {
    const host = { resolveSecret: () => 'ghp_x' };
    const account = await resolveIntegrationRef({ integration: 'github', credentials: { token: { secret: 'GITHUB_TOKEN' } } }, host, 'tools.0');
    expect(Object.keys(account).sort()).toEqual(['github_api', 'github_create_repository', 'github_list_my_repositories']);
    const pinned = await resolveIntegrationRef({ integration: 'github', credentials: { owner: 'o', repo: 'r', token: { secret: 'GITHUB_TOKEN' } } }, host, 'tools.0');
    expect(Object.keys(pinned)).toContain('github_list_pull_requests');
  });
});
