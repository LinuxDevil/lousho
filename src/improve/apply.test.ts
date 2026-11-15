import { createHash } from 'node:crypto';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { applyProposal } from './apply';
import { readAudit } from './audit';
import { currentRevision, harnessHash, readAgentHarness } from './revisions';
import type { Harness, ImproveResult } from './types';

let dir: string;
let outside: string;

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

const skillText = (name: string, description: string, content: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;
const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8');
const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };

const proposal = (harness: Harness, outcome: ImproveResult['outcome'] = 'proposal'): ImproveResult => ({
  outcome,
  reason: 'Training improved on every case.',
  harness,
  base: summary,
  cases: [{ caseId: 'case-1', role: 'training', base: { passed: 0, scored: 3 }, final: { passed: 3, scored: 3 }, reasons: [] }],
  stages: [],
  spend: { tokens: 100 },
});

const tempFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.includes('.lousho-tmp'));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-apply-'));
  outside = mkdtempSync(path.join(tmpdir(), 'lousho-apply-outside-'));
  write('instructions.md', 'Be careful.\n');
  write('skills/alpha/SKILL.md', skillText('alpha', 'Use for alpha work', 'Do alpha.'));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(path.join(dir, '.lousho', 'revisions'))) chmodSync(path.join(dir, '.lousho', 'revisions'), 0o755);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('applyProposal', () => {

  it('manual mode needs a name', async () => {
    const base = readAgentHarness(dir);
    const next = { ...base, instructions: 'Be very careful.' };
    await expect(applyProposal(dir, { result: proposal(next), base }, { mode: 'manual', approvedBy: '  ' })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(applyProposal(dir, { result: proposal(next), base }, { mode: 'manual', approvedBy: '<b></b>' })).rejects.toBeInstanceOf(ConfigurationError);
    expect(read('instructions.md')).toBe('Be careful.\n');
    const applied = await applyProposal(dir, { result: proposal(next), base }, { mode: 'manual', approvedBy: 'ali' });
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'apply', actor: 'person:ali', to: applied.to });
  });

  it('refuses keep-base', async () => {
    const base = readAgentHarness(dir);
    await expect(applyProposal(dir, { result: proposal({ ...base, instructions: 'Other.' }, 'keep-base'), base }, { mode: 'auto', by: 'gate' })).rejects.toBeInstanceOf(ConfigurationError);
    const missing = { ...proposal(base), harness: undefined };
    await expect(applyProposal(dir, { result: missing, base }, { mode: 'auto', by: 'gate' })).rejects.toBeInstanceOf(ConfigurationError);
    expect(readAudit(dir).map((entry) => entry.action)).toEqual(['reject', 'reject']);
    expect(read('instructions.md')).toBe('Be careful.\n');
  });

  it('refuses a skill name with ../', async () => {
    const base = readAgentHarness(dir);
    const next = { ...base, skills: { ...base.skills, '../../escape': { description: 'Escape', content: 'Escaped.' } } };
    await expect(applyProposal(dir, { result: proposal(next), base }, { mode: 'auto', by: 'gate' })).rejects.toBeInstanceOf(ConfigurationError);
    expect(existsSync(path.join(dir, '..', 'escape'))).toBe(false);
    expect(readAudit(dir).at(-1)?.action).toBe('reject');
  });

  it('a failed rename restores the old files', async () => {
    const base = readAgentHarness(dir);
    const next: Harness = { instructions: 'Changed.', skills: { alpha: { description: 'Use for alpha work', content: 'Do alpha better.' }, beta: { description: 'Beta', content: 'Do beta.' } } };
    const rename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls += 1;
      if (calls === 3) throw new Error('disk full');
      rename(from, to);
    });
    await expect(applyProposal(dir, { result: proposal(next), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/disk full/);
    expect(read('instructions.md')).toBe('Be careful.\n');
    expect(read('skills/alpha/SKILL.md')).toBe(skillText('alpha', 'Use for alpha work', 'Do alpha.'));
    expect(existsSync(path.join(dir, 'skills', 'beta'))).toBe(false);
    expect(tempFiles(dir)).toEqual([]);
    expect(currentRevision(dir)).toBe(harnessHash(base));
    expect(readAudit(dir).map((entry) => entry.action)).toEqual(['reject']);
  });

  it('never rewrites or deletes a read-only skill', async () => {
    write('skills/tool/SKILL.md', skillText('tool', 'Runs a script', 'Run it.'));
    write('skills/tool/run.sh', 'echo hi\n');
    const base = readAgentHarness(dir);
    const changed = { ...base, skills: { ...base.skills, tool: { description: 'Runs a script', content: 'Run it twice.' } } };
    await expect(applyProposal(dir, { result: proposal(changed), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/read-only/);
    const removed = { ...base, skills: { alpha: base.skills.alpha } };
    await expect(applyProposal(dir, { result: proposal(removed), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/read-only/);
    expect(read('skills/tool/SKILL.md')).toBe(skillText('tool', 'Runs a script', 'Run it.'));
    expect(read('skills/tool/run.sh')).toBe('echo hi\n');
  });

  it('refuses to write through a symlink that leaves the directory', async () => {
    mkdirSync(path.join(outside, 'gamma'));
    writeFileSync(path.join(outside, 'gamma', 'SKILL.md'), skillText('gamma', 'Gamma', 'Do gamma.'));
    symlinkSync(path.join(outside, 'gamma'), path.join(dir, 'skills', 'gamma'));
    const base = readAgentHarness(dir);
    const next = { ...base, skills: { ...base.skills, gamma: { description: 'Gamma', content: 'Do gamma differently.' } } };
    await expect(applyProposal(dir, { result: proposal(next), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/outside|symlink/i);
    expect(readFileSync(path.join(outside, 'gamma', 'SKILL.md'), 'utf8')).toBe(skillText('gamma', 'Gamma', 'Do gamma.'));
  });
  it('removes a planted temp-file symlink instead of writing through it', async () => {
    const target = path.join(outside, 'bashrc');
    writeFileSync(target, 'keep me\n');
    symlinkSync(target, path.join(dir, '.instructions.md.1.abcdef12.lousho-tmp'));
    const base = readAgentHarness(dir);
    await applyProposal(dir, { result: proposal({ ...base, instructions: 'Pwned?' }), base }, { mode: 'auto', by: 'gate' });
    expect(readFileSync(target, 'utf8')).toBe('keep me\n');
    expect(lstatSync(path.join(dir, 'instructions.md')).isFile()).toBe(true);
    expect(tempFiles(dir)).toEqual([]);
  });

  it('refuses a new skill whose folder already holds other files', async () => {
    write('skills/delta/notes.txt', 'mine\n');
    const base = readAgentHarness(dir);
    const next = { ...base, skills: { ...base.skills, delta: { description: 'Delta', content: 'Do delta.' } } };
    await expect(applyProposal(dir, { result: proposal(next), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/read-only/);
    expect(existsSync(path.join(dir, 'skills', 'delta', 'SKILL.md'))).toBe(false);
  });

  it('keeps a person\'s edit made while the files are swapped, and refuses as stale', async () => {
    const base = readAgentHarness(dir);
    const next: Harness = { instructions: 'Changed.', skills: { alpha: { description: 'Use for alpha work', content: 'Do alpha better.' } } };
    const rename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls += 1;
      if (calls === 2) write('skills/alpha/SKILL.md', skillText('alpha', 'Use for alpha work', 'Edited by a person.'));
      rename(from, to);
    });
    await expect(applyProposal(dir, { result: proposal(next), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/stale/);
    expect(read('instructions.md')).toBe('Be careful.\n');
    expect(read('skills/alpha/SKILL.md')).toContain('Edited by a person.');
    expect(readAudit(dir).map((entry) => entry.action)).toEqual(['stale']);
  });

  it('puts the old files back when the revision snapshot after the write fails', async () => {
    const base = readAgentHarness(dir);
    const rename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls += 1;
      rename(from, to);
      if (calls === 2) chmodSync(path.join(dir, '.lousho', 'revisions'), 0o500);
    });
    await expect(applyProposal(dir, { result: proposal({ ...base, instructions: 'Changed.' }), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow();
    expect(read('instructions.md')).toBe('Be careful.\n');
    expect(readAudit(dir)).toEqual([expect.objectContaining({ action: 'reject', reason: expect.stringMatching(/put back/) })]);
    expect(existsSync(path.join(dir, '.lousho', 'apply.pending.json'))).toBe(false);
  });

  it('undoes a write a crash interrupted before the next apply', async () => {
    const base = readAgentHarness(dir);
    write('instructions.md', 'Half written.\n');
    const journal = { action: 'apply', actor: 'gate', auditSeq: 0, from: harnessHash(base), to: 'f'.repeat(64), files: [{ rel: 'instructions.md', prev: Buffer.from('Be careful.\n').toString('base64'), next: createHash('sha256').update('Half written.\n').digest('hex') }] };
    write('.lousho/apply.pending.json', JSON.stringify(journal));
    const applied = await applyProposal(dir, { result: proposal({ ...base, instructions: 'Changed.' }), base }, { mode: 'auto', by: 'gate' });
    expect(applied.from).toBe(harnessHash(base));
    expect(readAudit(dir).map((entry) => [entry.action, entry.reason.slice(0, 24)])).toEqual([
      ['reject', 'Undid an interrupted app'],
      ['apply', 'Applied instructions.md.'],
    ]);
    expect(existsSync(path.join(dir, '.lousho', 'apply.pending.json'))).toBe(false);
  });

  it('refuses a .lousho folder that is a symlink', async () => {
    symlinkSync(outside, path.join(dir, '.lousho'));
    const base = readAgentHarness(dir);
    await expect(applyProposal(dir, { result: proposal({ ...base, instructions: 'Changed.' }), base }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('applies through an agent directory that is itself a symlink', async () => {
    const link = path.join(outside, 'agent');
    symlinkSync(dir, link);
    const base = readAgentHarness(link);
    await applyProposal(link, { result: proposal({ ...base, instructions: 'Changed.' }), base }, { mode: 'auto', by: 'gate' });
    expect(read('instructions.md')).toBe('Changed.\n');
  });
});
