import { describe, it, expect } from 'vitest';
import { pageSchema, WORK_TYPES, type PageManifest } from './page';

const base = {
  schema: 'lousho.page/1',
  id: 'instagram',
  name: 'Instagram',
  description: 'Plans and writes Instagram posts for the brand.',
  harness: { extends: ['global:social-post'], overrides: './harness/' },
  agents: './agents.json',
} as const;

const fixtures: Record<string, PageManifest> = {
  single: { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'single', single: { agent: 'writer' } } },
  'multi-agent': { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'multi-agent', multiAgent: { lead: 'editor', delegates: ['writer', 'designer'] } } },
  workflow: { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'workflow', workflow: { workflow: './workflow.json' } } },
  'goal-oriented': { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'goal-oriented', goal: { lead: 'editor', delegates: ['writer'], goal: './goal.json' } } },
};

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = pageSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))), message: issue.message }));
}

describe('pageSchema', () => {

  for (const [type, fixture] of Object.entries(fixtures)) {
    it(`accepts a valid ${type} page`, () => {
      const result = pageSchema.safeParse(fixture);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual(fixture);
    });
  }

  it('the active type must have its config block', () => {
    const blocks = { single: 'single', 'multi-agent': 'multiAgent', workflow: 'workflow', 'goal-oriented': 'goal' };
    for (const type of WORK_TYPES) {
      const issues = issuesOf({ ...base, execution: { type } });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toEqual(['execution', blocks[type]]);
      expect(issues[0].message).toContain(`'${type}'`);
    }
  });
});
