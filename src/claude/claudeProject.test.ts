import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProject } from './claudeProject';
import { mockModel, testToolContext } from '../testing';

let dir: string;

const w = (rel: string, content: string) =>
  fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true }).then(() =>
    fs.writeFile(path.join(dir, rel), content, 'utf8')
  );

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-proj-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('claudeProject', () => {

  it('concatenates CLAUDE.md then sorted .claude/rules sections', async () => {
    await w('CLAUDE.md', '# Project conventions\n\nUse pnpm.');
    await w('.claude/rules/z-last.md', 'Always run lint.');
    await w('.claude/rules/a-first.md', '---\npriority: high\n---\nCommits are atomic.');
    const p = await claudeProject(dir);
    expect(p.manifest.instructionFiles).toEqual(['CLAUDE.md']);
    expect(p.manifest.rules).toEqual(['a-first.md', 'z-last.md']);
    const i = p.instructions!;
    expect(i.indexOf('Use pnpm.')).toBeLessThan(i.indexOf('## a-first.md'));
    expect(i.indexOf('Commits are atomic.')).toBeLessThan(i.indexOf('## z-last.md'));
    expect(i).not.toContain('priority: high'); // frontmatter stripped
  });

  it('loads .claude/skills SKILL.md files', async () => {
    await w('.claude/skills/ship/SKILL.md', '---\nname: ship\ndescription: Ship it\n---\nCut a release.');
    const p = await claudeProject(dir);
    expect(p.skills?.[0].name).toBe('ship');
    expect(p.manifest.skills).toEqual(['ship']);
  });

  it('builds sub-agents from .claude/agents frontmatter + body', async () => {
    await w(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\ndescription: Reviews diffs\n---\nYou review code ruthlessly.'
    );
    const p = await claudeProject(dir, { provider: mockModel([{ text: 'ok' }]) });
    expect(Object.keys(p.subagents!)).toEqual(['reviewer']);
    expect(p.manifest.subagents).toEqual(['reviewer']);
  });

  it('an agent model frontmatter resolves without a provider option', async () => {
    await w('.claude/agents/with-model.md', '---\nname: y\ndescription: d\nmodel: ollama/llama3.2\n---\nBody.');
    const p = await claudeProject(dir);
    expect(Object.keys(p.subagents!)).toEqual(['y']);
  });

  it('scratchpad writes/appends/reads/lists inside its dir and rejects traversal', async () => {
    const p = await claudeProject(dir, { scratchpad: true });
    const tool = p.tools![0];
    const ctx = testToolContext();
    await tool.execute({ action: 'write', name: 'notes', content: 'a' }, ctx);
    await tool.execute({ action: 'append', name: 'notes', content: 'b' }, ctx);
    expect(await tool.execute({ action: 'read', name: 'notes' }, ctx)).toEqual({ content: 'ab' });
    expect(await tool.execute({ action: 'list' }, ctx)).toEqual({ notes: ['notes'] });
    await expect(tool.execute({ action: 'write', name: '../x', content: 'x' }, ctx)).rejects.toThrow(/a-z0-9/i);
    const written = await fs.readFile(path.join(dir, '.claude', 'scratchpad', 'notes.md'), 'utf8');
    expect(written).toBe('ab');
  });
});
