import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { applyProposal, rollbackHarness } from './apply';
import { readAudit, verifyAudit } from './audit';
import { currentRevision, harnessHash, listRevisions, readAgentHarness } from './revisions';
import type { Harness, ImproveResult } from './types';

let dir: string;

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8');
const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });

async function apply(change: (base: Harness) => Harness): Promise<{ from: string; to: string }> {
  const base = readAgentHarness(dir);
  return applyProposal(dir, { result: proposal(change(base)), base }, { mode: 'auto', by: 'gate' });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-rollback-'));
  write('instructions.md', 'Be careful.\n');
  write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Use for alpha work\n---\n\nDo alpha.\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rollbackHarness', () => {
  it('rollback restores byte-identical files and makes a new revision whose parent is the current one', async () => {
    const before = { instructions: read('instructions.md'), alpha: read('skills/alpha/SKILL.md') };
    const applied = await apply((base) => ({ instructions: 'Changed.', skills: { ...base.skills, beta: { description: 'Beta', content: 'Do beta.' } } }));
    const rolled = await rollbackHarness(dir, applied.from, { actor: 'monitor', reason: 'The pass rate fell.' });
    expect(rolled).toEqual({ from: applied.to, to: applied.from, written: ['instructions.md', 'skills/beta/SKILL.md'] });
    expect(read('instructions.md')).toBe(before.instructions);
    expect(read('skills/alpha/SKILL.md')).toBe(before.alpha);
    expect(existsSync(path.join(dir, 'skills', 'beta'))).toBe(false);
    expect(currentRevision(dir)).toBe(applied.from);
    expect(listRevisions(dir)[0]).toMatchObject({ id: applied.from, source: 'rollback', parent: applied.to });
    expect(listRevisions(dir)).toHaveLength(3);
    const rollbacks = readAudit(dir).filter((entry) => entry.action === 'rollback');
    expect(rollbacks).toEqual([expect.objectContaining({ actor: 'monitor', from: applied.to, to: applied.from, reason: 'The pass rate fell.' })]);
    expect(verifyAudit(dir)).toBeUndefined();
  });

  it('refuses an unknown revision and the revision already in place', async () => {
    const applied = await apply((base) => ({ ...base, instructions: 'Changed.' }));
    await expect(rollbackHarness(dir, 'f'.repeat(64), { actor: 'person:ali', reason: 'r' })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(rollbackHarness(dir, applied.to, { actor: 'person:ali', reason: 'r' })).rejects.toThrow(/already/);
    expect(readAudit(dir).filter((entry) => entry.action === 'rollback')).toEqual([]);
  });

  it('records a hand edit before rolling it back', async () => {
    const applied = await apply((base) => ({ ...base, instructions: 'Changed.' }));
    write('instructions.md', 'Edited by hand.\n');
    const handEdit = harnessHash(readAgentHarness(dir));
    const rolled = await rollbackHarness(dir, applied.from, { actor: 'person:ali', reason: 'Undo.' });
    expect(rolled.from).toBe(handEdit);
    expect(listRevisions(dir).find((revision) => revision.id === handEdit)).toMatchObject({ source: 'baseline', parent: applied.to });
    expect(read('instructions.md')).toBe('Be careful.\n');
  });

  it('never rewrites a read-only skill', async () => {
    write('skills/tool/SKILL.md', '---\nname: tool\ndescription: Runs a script\n---\n\nRun it.\n');
    write('skills/tool/run.sh', 'echo hi\n');
    const applied = await apply((base) => ({ ...base, instructions: 'Changed.' }));
    write('skills/tool/SKILL.md', '---\nname: tool\ndescription: Runs a script\n---\n\nRun it twice.\n');
    await expect(rollbackHarness(dir, applied.from, { actor: 'guard', reason: 'r' })).rejects.toThrow(/read-only/);
    expect(read('skills/tool/SKILL.md')).toContain('Run it twice.');
  });
});

describe('rollbackHarness safety', () => {

  it('a journal with a bad actor does not block later writes', async () => {
    const applied = await apply((base) => ({ ...base, instructions: 'Changed.' }));
    write('.lousho/apply.pending.json', JSON.stringify({ action: 'rollback', actor: 'person:', auditSeq: 99, committed: true, from: applied.to, to: applied.to, files: [] }));
    await expect(rollbackHarness(dir, applied.from, { actor: 'person:ali', reason: 'Undo.' })).resolves.toMatchObject({ to: applied.from });
  });
});
