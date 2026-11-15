import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineSkill, loadSkills } from './index';

const changelog = defineSkill({
  name: 'changelog',
  description: 'How to write a changelog entry',
  content: '# Changelog\nSECRET-CHANGELOG-BODY: use the imperative mood.',
});
const review = defineSkill({
  name: 'code_review',
  description: 'How to review a pull request',
  content: 'SECRET-REVIEW-BODY',
});

const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }): string =>
  String(call.messages.find((m) => m.role === 'system')?.content);

describe('defineSkill', () => {

  it('rejects empty description and content', () => {
    expect(() => defineSkill({ name: 'x', description: ' ', content: 'c' })).toThrow(
      /skill 'x' is missing a non-empty 'description'.*Example/
    );
    expect(() => defineSkill({ name: 'x', description: 'd', content: '' })).toThrow(/non-empty 'content'/);
    expect(() => defineSkill(undefined as never)).toThrow(/'name' is required/);
  });
});

describe('skills wiring (createAgent)', () => {
  it('lists skills by description without bodies, then returns the body via load_skill', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'load_skill', args: { name: 'changelog' } }] },
      'Done.',
    ]);
    const agent = createAgent({
      prompt: 'You are a release engineer.',
      provider: model,
      skills: [changelog, review],
    });

    const result = await agent.send('write a changelog');

    expect(result.text).toBe('Done.');
    const first = model.calls[0];
    const system = systemOf(first);
    expect(system).toContain('You are a release engineer.');
    expect(system).toContain('- changelog: How to write a changelog entry');
    expect(system).toContain('- code_review: How to review a pull request');
    expect(system).toContain('`load_skill`');
    expect(system).not.toContain('SECRET-CHANGELOG-BODY');
    expect(system).not.toContain('SECRET-REVIEW-BODY');
    expect(first.tools?.map((t) => t.function.name)).toEqual(['load_skill']);

    const second = model.calls[1];
    const toolMessage = second.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('SECRET-CHANGELOG-BODY');
    expect(systemOf(second)).not.toContain('SECRET-CHANGELOG-BODY');
    expect(JSON.stringify(second.messages)).not.toContain('SECRET-REVIEW-BODY');
  });

  it('returns a tool error listing valid names for an unknown skill', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'load_skill', args: { name: 'nope' } }] },
      'ok',
    ]);
    await createAgent({ prompt: 'p', provider: model, skills: [changelog, review] }).send('go');

    const toolMessage = model.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ isError: true, toolName: 'load_skill' });
    expect(toolMessage?.content).toContain("Unknown skill 'nope'");
    expect(toolMessage?.content).toContain('changelog, code_review');
  });

  it('throws at createAgent() on duplicate skill names', () => {
    expect(() => createAgent({ prompt: 'p', provider: mockModel(['x']), skills: [changelog, changelog] })).toThrow(
      /duplicate skill name 'changelog'/
    );
  });
});

describe('loadSkills', () => {
  let dir: string;
  const write = async (rel: string, content: string) => {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads both layouts sorted by name, defaulting names from folder/file', async () => {
    await write('zeta/SKILL.md', '---\ndescription: Zeta skill\n---\n\nZeta body\n');
    await write('alpha.md', '---\ndescription: Alpha skill\n---\nAlpha body');
    await write('mid/SKILL.md', '---\r\nname: renamed\r\ndescription: "Mid: skill"\r\n---\r\nMid body');
    await write('notes/README.txt', 'not a skill');
    await write('empty-dir/.gitkeep', '');

    const skills = await loadSkills(dir);

    expect(skills).toEqual([
      { name: 'alpha', description: 'Alpha skill', content: 'Alpha body' },
      { name: 'renamed', description: 'Mid: skill', content: 'Mid body', directory: path.join(dir, 'mid') },
      { name: 'zeta', description: 'Zeta skill', content: 'Zeta body', directory: path.join(dir, 'zeta') },
    ]);
  });

  it('skips a loose markdown file with no frontmatter (a README) with a warning', async () => {
    await write('README.md', '# My skills\n\nSkills for our agents.');
    await write('pdf/SKILL.md', '---\ndescription: Work with PDFs\n---\nPDF body');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const skills = await loadSkills(dir);
      expect(skills.map((s) => s.name)).toEqual(['pdf']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('README.md');
    } finally {
      warn.mockRestore();
    }
  });

  it('gives a folder skill its directory and reads bundled files through a confined read_skill_file', async () => {
    await write('pdf/SKILL.md', '---\ndescription: Work with PDFs\n---\nSee FORMS.md for forms.');
    await write('pdf/FORMS.md', 'FORMS-BODY');
    await write('pdf/scripts/fill.py', 'print("fill")');
    await write('secret.txt', 'TOP-SECRET');
    const model = mockModel([
      { toolCalls: [{ name: 'load_skill', args: { name: 'pdf' } }] },
      {
        toolCalls: [
          { name: 'read_skill_file', args: { skill: 'pdf', path: 'FORMS.md' } },
          { name: 'read_skill_file', args: { skill: 'pdf', path: '../secret.txt' } },
          { name: 'read_skill_file', args: { skill: 'pdf', path: path.join(dir, 'secret.txt') } },
        ],
      },
      'ok',
    ]);
    await createAgent({ prompt: 'p', provider: model, skills: await loadSkills(dir) }).send('go');
    expect(model.calls[0].tools?.map((t) => (t as { function?: { name?: string }; name?: string }).function?.name ?? (t as { name?: string }).name)).toContain('read_skill_file');
    const tools = (n: number) => model.calls[n].messages.filter((m) => m.role === 'tool').map((m) => { const raw = String(m.content); try { const v = JSON.parse(raw); return typeof v === 'string' ? v : raw; } catch { return raw; } });
    const loaded = tools(1)[0];
    expect(loaded).toContain(`Skill directory: ${path.join(dir, 'pdf')}`);
    expect(loaded).toContain('- FORMS.md');
    expect(loaded).toContain('- scripts/fill.py');
    const reads = tools(2).slice(1);
    expect(reads.join('\n')).toContain('FORMS-BODY');
    expect(reads.join('\n')).not.toContain('TOP-SECRET');
    expect(reads.filter((r) => /outside the directory/.test(r))).toHaveLength(2);
  });

  it('names the file for invalid YAML, non-mapping frontmatter and invalid names', async () => {
    await write('a.md', '---\ndescription: [unclosed\n---\nbody');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: invalid YAML frontmatter/);
    await write('a.md', '---\n- a\n- b\n---\nbody');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: frontmatter must be a YAML mapping/);
    await write('a.md', '---\nname: Bad Name\ndescription: d\n---\nbody');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: invalid skill name "Bad Name"/);
    await write('a.md', '---\ndescription: d\n---\n');
    await expect(loadSkills(dir)).rejects.toThrow(/a\.md: skill 'a' is missing a non-empty 'content'/);
  });
});
