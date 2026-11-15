import { describe, it, expect } from 'vitest';
import { narrowPolicy, workspacePolicySchema, type PolicyCeiling, type WorkspacePolicy } from './policy';

const marketing: WorkspacePolicy = {
  permissions: [
    { id: 'no-shell', tool: 'shell', action: 'deny', reason: 'No shell in Marketing' },
    { id: 'ask-publish', tool: 'publish_*', when: { channel: { eq: 'instagram' } }, action: 'ask', ttlMs: 3_600_000 },
  ],
  tools: { allow: ['render_video', 'synthesize_voice', 'search_facts', 'publish_*'] },
  secrets: [{ env: 'INSTAGRAM_TOKEN' }, { secret: 'brand-api-key' }],
  network: { allowHosts: ['graph.facebook.com', '*.cdn.example.com'] },
  approvals: { require: ['publish_*'] },
  sandbox: { required: true },
};

const wide: PolicyCeiling = {
  permissions: [{ id: 'allow-all', tool: '*', action: 'allow' }],
  tools: { allow: ['*'] },
  secrets: [{ env: 'INSTAGRAM_TOKEN' }, { secret: 'brand-api-key' }, { env: 'OTHER' }],
  network: { allowHosts: ['*.facebook.com', '*.example.com'] },
  approvals: { require: ['delete_*'] },
  sandbox: { required: false },
};

const empty: WorkspacePolicy = { permissions: [], tools: { allow: [] }, secrets: [] };

function policy(overrides: Partial<WorkspacePolicy>): WorkspacePolicy {
  return { ...empty, ...overrides };
}

describe('policy schema', () => {

  it.each([
    ['a missing tools allowlist', { permissions: [], secrets: [] }],
    ['a sandbox mode', { ...empty, sandbox: { mode: 'container' } }],
    ['a non-boolean sandbox flag', { ...empty, sandbox: { required: 'yes' } }],
  ])('rejects %s', (_name, value) => {
    expect(workspacePolicySchema.safeParse(value).success).toBe(false);
  });
});

describe('narrowPolicy', () => {
  it('never returns a tool, host or secret outside the ceiling', () => {
    const ceiling = policy({
      tools: { allow: ['search_facts', 'github_*'] },
      network: { allowHosts: ['api.example.com', '*.cdn.example.com'] },
      secrets: [{ env: 'A' }, { secret: 'b' }],
    });
    const workspace = policy({
      tools: { allow: ['search_facts', 'shell', 'github_read', '*', 'github_*'] },
      network: { allowHosts: ['api.example.com', 'evil.com', 'a.cdn.example.com', '*.example.com', 'cdn.example.com', 'api.example.com.evil.com'] },
      secrets: [{ env: 'A' }, { env: 'b' }, { secret: 'A' }, { secret: 'c' }],
    });
    const result = narrowPolicy(ceiling, workspace);
    expect(result.tools.allow.sort()).toEqual(['github_*', 'github_read', 'search_facts']);
    expect(result.network.allowHosts.sort()).toEqual(['*.cdn.example.com', 'a.cdn.example.com', 'api.example.com']);
    expect(result.secrets).toEqual([{ env: 'A' }]);
  });

  describe('permissions', () => {
    const wsAllow = { id: 'w-allow', tool: 'rm', action: 'allow' } as const;
    const ids = (rules: readonly { id: string }[]) => rules.map((rule) => rule.id);

    it('a workspace ask survives a wide ceiling allow-all and no workspace allow does', () => {
      const result = narrowPolicy(wide, policy({ permissions: [...marketing.permissions, wsAllow] }));
      expect(result.permissions.ceiling).toEqual(wide.permissions);
      expect(ids(result.permissions.workspace)).toEqual(['no-shell', 'ask-publish']);
      expect(result.permissions.workspace.some((rule) => rule.action === 'allow')).toBe(false);
    });
  });

  describe('sandbox', () => {
    const states = [undefined, false, true] as const;
    const sandboxOf = (required: boolean | undefined) => (required === undefined ? {} : { sandbox: { required } });

    it.each(states.flatMap((c) => states.map((w) => [c, w] as const)))('ceiling %s with workspace %s requires it only if either does', (c, w) => {
      const result = narrowPolicy(policy(sandboxOf(c)), policy(sandboxOf(w)));
      expect(result.sandbox.required).toBe(c === true || w === true);
    });
  });

  describe('purity', () => {
    it('does not change its inputs and returns copies', () => {
      const ceiling = structuredClone(wide);
      const workspace = structuredClone(marketing);
      const result = narrowPolicy(ceiling, workspace);
      expect(ceiling).toEqual(wide);
      expect(workspace).toEqual(marketing);
      result.tools.allow.push('x');
      result.secrets.push({ env: 'X' });
      result.permissions.workspace.forEach((rule) => {
        rule.tool = 'x';
      });
      result.permissions.ceiling.forEach((rule) => {
        rule.tool = 'x';
      });
      expect(ceiling).toEqual(wide);
      expect(workspace).toEqual(marketing);
    });
  });
});
