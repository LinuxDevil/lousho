import { describe, it, expect } from 'vitest';
import { workspaceManifestSchema, type WorkspaceManifest } from './workspace';

const marketing: WorkspaceManifest = {
  schema: 'lousho.workspace/1',
  id: 'marketing',
  name: 'Marketing',
  version: '1.0.0',
  description: 'Plans, writes and publishes social content for the brand.',
  domain: 'marketing',
  mainAgent: { dir: './main-agent', inheritsShared: true },
  pages: ['content-research', 'instagram', 'facebook', 'tiktok'],
  agents: './agents',
  harnessProfiles: './harness-profiles',
  workflows: './workflows',
  dependencies: {
    agents: { 'global:copy-editor': '^1.2.0' },
    profiles: { 'global:social-post': '~2.0.0' },
  },
  defaults: {
    model: 'anthropic/claude-sonnet-5-5',
    limits: { maxConcurrentPages: 3, maxCostUsdPerRun: 2.5 },
  },
  budget: { mode: 'shared' },
  improve: { enabled: true, healer: 'per-page', proposerModel: 'openai/gpt-5' },
};

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = workspaceManifestSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))), message: issue.message }));
}

describe('workspaceManifestSchema', () => {

  it('rejects an unlisted page folder name in pages', () => {
    expect(issuesOf({ ...marketing, pages: ['instagram', 'pages/tiktok'] })).toEqual([{ path: ['pages', 1], message: expect.stringContaining('page folder name') }]);
    expect(issuesOf({ ...marketing, pages: ['../outside'] })[0].path).toEqual(['pages', 0]);
    expect(issuesOf({ ...marketing, pages: ['Instagram Posts'] })[0].path).toEqual(['pages', 0]);
    expect(issuesOf({ ...marketing, pages: ['instagram', 'tiktok', 'instagram'] })).toEqual([{ path: ['pages', 2], message: "duplicate page 'instagram'" }]);
  });
});
