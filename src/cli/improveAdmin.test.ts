import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal } from '../improve/apply';
import { listPending, savePending } from '../improve/pending';
import { readAudit } from '../improve/audit';
import { readAgentHarness } from '../improve/revisions';
import type { Harness, ImproveResult } from '../improve/types';
import { openDb } from '../observe/store';
import { runImprove } from './improve';

let dir: string;

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = sink();
  const stderr = sink();
  const code = await runImprove(args, { stdout: stdout.stream, stderr: stderr.stream });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });

async function apply(instructions: string): Promise<{ from: string; to: string }> {
  const base = readAgentHarness(dir);
  return applyProposal(dir, { result: proposal({ ...base, instructions }), base }, { mode: 'auto', by: 'gate' });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-improve-admin-'));
  writeFileSync(path.join(dir, 'instructions.md'), 'Be careful.\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lousho improve rollback defaults', () => {
  it('refuses without --to after a rollback, and after a hand edit', async () => {
    await apply('Changed.');
    expect((await run('rollback', dir, '--by', 'ali')).code).toBe(0);
    const again = await run('rollback', dir, '--by', 'ali');
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/came from a rollback/);
    writeFileSync(path.join(dir, 'instructions.md'), 'Edited by hand.\n');
    const edited = await run('rollback', dir, '--by', 'ali');
    expect(edited.stderr).toMatch(/hand edits/);
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Edited by hand.\n');
    expect((await run('revisions', dir)).stdout).toMatch(/unsaved edits/);
  });
});

describe('lousho improve revisions', () => {
  it('revisions lists newest first, with source and actor', async () => {
    const applied = await apply('Changed.');
    await run('rollback', dir, '--by', 'ali');
    const { code, stdout } = await run('revisions', dir);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toMatch(new RegExp(`^\\* ${applied.from.slice(0, 12)} +rollback +person:ali`));
    expect(lines[1]).toMatch(new RegExp(`^  ${applied.to.slice(0, 12)} +apply +gate`));
    expect(lines[2]).toMatch(new RegExp(`^  ${applied.from.slice(0, 12)} +baseline`));
    const json = JSON.parse((await run('revisions', dir, '--json')).stdout) as { id: string; source: string; current: boolean }[];
    expect(json.map((row) => [row.source, row.current])).toEqual([
      ['rollback', true],
      ['apply', false],
      ['baseline', false],
    ]);
  });
});

describe('lousho improve audit', () => {
  it('prints the log oldest first', async () => {
    await apply('Changed.');
    const { code, stdout } = await run('audit', dir);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^1 .* gate apply /);
    const json = JSON.parse((await run('audit', dir, '--json')).stdout) as { action: string }[];
    expect(json.map((entry) => entry.action)).toEqual(['apply']);
  });
});

describe('lousho improve pending, approve and reject', () => {
  async function queue(instructions: string): Promise<string> {
    const base = readAgentHarness(dir);
    return (await savePending(dir, { result: proposal({ ...base, instructions }), base, card: 'card' })).id;
  }

  it('lists, approves and rejects', async () => {
    const first = await queue('First.');
    const second = await queue('Second.');
    const listed = await run('pending', dir);
    expect(listed.stdout).toContain(first);
    expect(listed.stdout).toContain(second);
    expect(JSON.parse((await run('pending', dir, '--json')).stdout)).toHaveLength(2);
    const approved = await run('approve', dir, first, '--by', 'ali');
    expect(approved).toMatchObject({ code: 0, stderr: '' });
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('First.\n');
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'apply', actor: 'person:ali' });
    const stale = await run('approve', dir, second, '--by', 'ali');
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/stale/);
    expect((await run('pending', dir)).stdout).toMatch(/stale/);
    expect((await run('reject', dir, second, '--by', 'ali', '--reason', 'Outdated.')).code).toBe(0);
    expect(listPending(dir)).toEqual([]);
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'reject', reason: `Rejected ${second}: Outdated.` });
  });

  it('shows one card and refuses a malformed id as a usage error', async () => {
    const id = await queue('First.');
    const shown = await run('pending', dir, '--show', id);
    expect(shown).toMatchObject({ code: 0, stdout: 'card\n' });
    expect((await run('pending', dir, '--show', '../x')).code).toBe(2);
    expect((await run('approve', dir, 'nope', '--by', 'ali')).code).toBe(2);
  });

  it('with canary.traffic, approve starts the traffic canary and writes nothing, and needs the observe database', async () => {
    writeFileSync(path.join(dir, 'improve.json'), JSON.stringify({ approval: 'manual', canary: { traffic: { share: 0.1, sessions: 10 } } }));
    const id = await queue('First.');
    const before = readFileSync(path.join(dir, 'instructions.md'), 'utf8');
    const missing = await run('approve', dir, id, '--by', 'ali', '--db', path.join(dir, 'none.db'));
    expect(missing).toMatchObject({ code: 1, stderr: expect.stringMatching(/observe database/) });
    const dbFile = path.join(dir, 'observe.db');
    openDb(dbFile).close();
    const approved = await run('approve', dir, id, '--by', 'ali', '--db', dbFile);
    expect(approved).toMatchObject({ code: 0, stdout: expect.stringMatching(/traffic canary now serves/) });
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe(before);
    expect(listPending(dir)).toEqual([]);
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'canary-start', actor: 'person:ali' });
  });

  it('needs an id and --by', async () => {
    const id = await queue('First.');
    expect((await run('approve', dir)).code).toBe(2);
    expect((await run('approve', dir, id)).stderr).toMatch(/--by/);
    expect((await run('reject', dir, id)).code).toBe(2);
    expect((await run('approve', dir, 'aaaaaaaaaaaa', '--by', 'ali')).code).toBe(1);
    expect((await run('pending', dir)).stdout).toContain(id);
  });
});

