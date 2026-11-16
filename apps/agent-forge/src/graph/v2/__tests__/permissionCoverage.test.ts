import { describe, it, expect } from 'vitest';
import { ruleCoversToolRef } from '../edges';

describe('ruleCoversToolRef', () => {
  it('lets a rule cover an integration through its tool-name prefix', () => {
    const github = { integration: 'github' as const, credentials: { owner: 'o', repo: 'r', token: { env: 'T' } } };
    expect(ruleCoversToolRef(['github_create_*'], github)).toBe(true);
    expect(ruleCoversToolRef(['*'], github)).toBe(true);
    expect(ruleCoversToolRef(['jira_*'], github)).toBe(false);
    expect(ruleCoversToolRef(['web_*'], { builtin: 'web_fetch' })).toBe(true);
  });
});
