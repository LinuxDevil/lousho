import { describe, expect, it } from 'vitest';

import { buildTree, downloadName } from '../codeViews';

describe('buildTree', () => {
  it('groups paths into folders first, then files, alphabetical case-insensitive', () => {
    const tree = buildTree([
      { path: 'tools/b.ts' },
      { path: 'agent.yaml' },
      { path: 'prompts/system.md' },
      { path: 'tools/A.ts' },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['prompts', 'tools', 'agent.yaml']);
    expect(tree[0]).toMatchObject({ kind: 'dir', path: 'prompts' });
    expect(tree[1]).toMatchObject({ kind: 'dir', path: 'tools' });
    expect(tree[2]).toMatchObject({ kind: 'file', path: 'agent.yaml' });
    expect(tree[0].children?.map((n) => n.name)).toEqual(['system.md']);
    expect(tree[1].children?.map((n) => n.name)).toEqual(['A.ts', 'b.ts']);
  });
});

describe('downloadName', () => {
  it('names the TypeScript and YAML downloads from the agent id', () => {
    expect(downloadName('support-bot', 'ts')).toBe('support-bot.agent.ts');
    expect(downloadName('support-bot', 'yaml')).toBe('support-bot.yaml');
  });
});
