import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { readAudit } from './audit';
import { openDb } from '../observe/store';
import { approvePending } from './approvePending';
import { canaryArm, routesToCandidate } from './canaryArm';
import { listPending, rejectPending, savePending } from './pending';
import { readCanary } from './trafficCanary';
import { harnessHash, readAgentHarness } from './revisions';
import type { Harness, ImproveResult } from './types';

let dir: string;

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });
const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8');

async function queue(instructions = 'Be very careful.') {
  const base = readAgentHarness(dir);
  return savePending(dir, { result: proposal({ ...base, instructions }), base, card: 'card text', cycle: 'c1' });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-pending-'));
  writeFileSync(path.join(dir, 'instructions.md'), 'Be careful.\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pending proposals', () => {

  it('manual with canary.traffic: no session routes to the candidate before approve, and approve starts the canary in the person\'s name', async () => {
    writeFileSync(path.join(dir, 'improve.json'), JSON.stringify({ approval: 'manual', canary: { traffic: { share: 0.25, sessions: 10 } } }));
    const ids = Array.from({ length: 400 }, (_, i) => `s${i}`).filter((id) => routesToCandidate(id, 0.25));
    const arm = canaryArm(dir, { instructions: 'Be careful.', skills: [] });
    const pending = await queue();
    expect(ids.some((id) => arm({ sessionId: id }) !== undefined)).toBe(false);
    await expect(approvePending(dir, pending.id, 'ali')).rejects.toThrow(/observe database/);
    expect(ids.some((id) => arm({ sessionId: id }) !== undefined)).toBe(false);
    const db = openDb(':memory:');
    try {
      const approved = await approvePending(dir, pending.id, 'ali', { db });
      expect('canary' in approved && approved.canary).toMatchObject({ approvedBy: 'ali', revision: harnessHash({ instructions: 'Be very careful.', skills: {} }) });
    } finally {
      db.close();
    }
    expect(read('instructions.md')).toBe('Be careful.\n');
    expect(listPending(dir)).toEqual([]);
    expect(readCanary(dir)).toMatchObject({ approvedBy: 'ali' });
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'canary-start', actor: 'person:ali' });
    expect(arm({ sessionId: ids[0] })).toMatchObject({ instructions: 'Be very careful.' });
  });

  it('refuses ids that are not a pending proposal, including path tricks', async () => {
    await expect(approvePending(dir, '../../etc/passwd', 'ali')).rejects.toThrow(/not a pending proposal id/);
    await expect(approvePending(dir, 'aaaaaaaaaaaa', 'ali')).rejects.toThrow(/No pending proposal/);
    await expect(rejectPending(dir, 'zz', 'ali', 'r')).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('leaves out a file without a creation time instead of failing the list', async () => {
    const pending = await queue();
    const file = path.join(dir, '.lousho', 'proposals', `${pending.id}.json`);
    const broken = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete broken.createdAt;
    writeFileSync(file, JSON.stringify(broken));
    await queue('Another.');
    expect(listPending(dir)).toHaveLength(1);
  });

  it('refuses a symlinked proposals folder', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'lousho-pending-outside-'));
    mkdirSync(path.join(dir, '.lousho'));
    symlinkSync(outside, path.join(dir, '.lousho', 'proposals'));
    await expect(queue()).rejects.toThrow(/symlink/);
    expect(() => listPending(dir)).toThrow(/symlink/);
    rmSync(outside, { recursive: true, force: true });
  });
});
