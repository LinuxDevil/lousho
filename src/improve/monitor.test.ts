import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScorePoint } from '../observe/continuousScore';
import type { IngestEvent } from '../observe/envelope';
import { ingestBatch, openDb } from '../observe/store';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { applyProposal, lastGoodRevision } from './apply';
import { readAudit } from './audit';
import { checkApplied, judgeApplied } from './monitor';
import { type ImproveSettings } from './settings';
import { currentRevision, readAgentHarness } from './revisions';
import type { Harness, ImproveResult } from './types';

const DAY = 86_400_000;
let dir: string;
let db: SqlDatabase;
let traces = 0;

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });

async function apply(): Promise<{ from: string; to: string; at: number }> {
  const base = readAgentHarness(dir);
  const applied = await applyProposal(dir, { result: proposal({ ...base, instructions: 'Be careful. Check the receipt first.' }), base }, { mode: 'auto', by: 'gate' });
  const at = Date.parse(readAudit(dir).at(-1)!.at);
  return { ...applied, at };
}

function runs(revision: string, outcomes: readonly number[], start: number, agent = 'support', duration = 10): void {
  ingestBatch(
    db,
    outcomes.flatMap((value, i): IngestEvent[] => {
      const trace = `t${traces++}`;
      const at = start + i * 1000;
      return [
        { type: 'observation', data: { obs_id: `root-${trace}`, trace_id: trace, agent_id: agent, kind: 'span', name: 'invoke_agent support', start: at, end: at + duration, status: 'ok', attrs: { 'lousho.run.finish_reason': 'stop', 'lousho.harness.revision': revision } } },
        { type: 'score', data: { score_id: `s-${trace}`, trace_id: trace, name: 'check', value, source: 'online', agent_id: agent, ts: at + duration + 10 } },
      ];
    })
  );
}

const rate = (passed: number, total: number): number[] => Array.from({ length: total }, (_, i) => (i < passed ? 1 : 0));
const MONITOR_DEFAULTS: ImproveSettings['monitor'] = { minRuns: 20, window: 20, maxDrop: 0.05, autoRollback: true, giveUpDays: 7 };
const check = (options: { monitor?: Partial<ImproveSettings['monitor']>; now?: number; agent?: string }) =>
  checkApplied(db, dir, { monitor: { ...MONITOR_DEFAULTS, ...options.monitor }, cooldownHours: 24 }, { agent: options.agent ?? 'support', ...(options.now !== undefined && { now: options.now }) });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-monitor-'));
  write('instructions.md', 'Be careful.\n');
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('checkApplied', () => {

  it('rollback writes a cooldown', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(12, 20), applied.at + 1000);
    const now = applied.at + DAY;

    write('.lousho/state.json', JSON.stringify({ cycles: 2 }));
    await check({ now });
    const state = JSON.parse(readFileSync(path.join(dir, '.lousho', 'state.json'), 'utf8')) as { cycles: number; cooldownUntil: string; monitor: { revision: string; verdict: { state: string } } };
    expect(state.cooldownUntil).toBe(new Date(now + DAY).toISOString());
    expect(state.monitor).toMatchObject({ revision: applied.to, verdict: { state: 'rolled-back' } });
    expect(state.cycles).toBe(2);
    expect(lastGoodRevision(dir)).not.toBe(applied.to);
  });

  it("judges only the agent's own runs, found by id or registered name", async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(18, 20), applied.at + 1000);
    runs(applied.to, rate(2, 20), applied.at + 1000, 'billing');
    ingestBatch(db, [{ type: 'agent.heartbeat', data: { agent_id: 'support', name: 'Support desk', ts: applied.at } }]);

    expect(await check({ now: applied.at + DAY, agent: 'Support desk' })).toMatchObject({ state: 'kept', after: { runs: 20, passRate: 0.9 } });
  });

  it('a refused rollback is audited once as a guard failure, beside the writer\'s own refusal, and reported', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(12, 20), applied.at + 1000);
    rmSync(path.join(dir, '.lousho', 'revisions', `${applied.from}.json`), { force: true });

    expect(await check({ now: applied.at + DAY })).toMatchObject({ state: 'regressed', reason: 'The pass rate fell from 90% to 60% over 20 runs. The rollback was refused.' });
    expect(await check({ now: applied.at + DAY + 1 })).toMatchObject({ state: 'regressed' });
    expect(readAudit(dir).filter((entry) => entry.actor === 'monitor').map((entry) => entry.action)).toEqual(['reject', 'guard-fail']);
    expect(currentRevision(dir)).toBe(applied.to);
  });

  it('refuses an empty agent and a name two agents share', async () => {
    const applied = await apply();
    ingestBatch(db, [
      { type: 'agent.heartbeat', data: { agent_id: 'a1', name: 'twin', ts: applied.at } },
      { type: 'agent.heartbeat', data: { agent_id: 'a2', name: 'twin', ts: applied.at } },
    ]);

    await expect(check({ now: applied.at + DAY, agent: ' ' })).rejects.toThrow('empty name');
    await expect(check({ now: applied.at + DAY, agent: 'twin' })).rejects.toThrow("'twin' names 2 agents");
  });

  it('keeps a revision unverified after giveUpDays without enough runs, audited once and never rolled back', async () => {
    const applied = await apply();
    runs(applied.to, rate(0, 5), applied.at + 1000);

    expect(await check({ now: applied.at + 6 * DAY })).toMatchObject({ state: 'pending', runs: 5 });
    expect(await check({ now: applied.at + 7 * DAY })).toEqual({ state: 'kept-unverified', runs: 5, baselineRuns: 0, reason: 'Kept unverified: 5 runs after 7 days, fewer than the 20 the monitor needs.' });
    expect(await check({ now: applied.at + 8 * DAY })).toMatchObject({ state: 'kept-unverified', runs: 5 });
    expect(readAudit(dir).filter((entry) => entry.action === 'unverified')).toHaveLength(1);
    expect(currentRevision(dir)).toBe(applied.to);
  });
});

function points(values: readonly number[]): ScorePoint[] {
  return values.map((value, i) => ({ traceId: `p${i}`, at: i, value }));
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function rolledBack(random: () => number, before: number, after: number, continuous = false): boolean {
  const value = (rate: number) => (continuous ? Math.min(1, Math.max(0, rate + (random() - 0.5) * 0.4)) : random() < rate ? 1 : 0);
  const draw = (rate: number, count: number) => points(Array.from({ length: count }, () => value(rate)));
  const earlier = draw(before, 60);
  const later = draw(after, 60);
  for (const runs of [20, 40, 60]) {
    const judged = judgeApplied(earlier, later.slice(0, runs), MONITOR_DEFAULTS);
    if (judged.verdict !== 'wait') return judged.verdict === 'regressed';
  }
  return false;
}

describe('judgeApplied over 1,000 seeded draws', () => {

  it('false rollback is at most 5% on a stable continuous score of 0.8, and a fall to 0.65 is caught', () => {
    const random = seeded(11);
    expect(Array.from({ length: 1000 }, () => rolledBack(random, 0.8, 0.8, true)).filter(Boolean).length / 1000).toBeLessThanOrEqual(0.05);
    expect(Array.from({ length: 1000 }, () => rolledBack(random, 0.8, 0.65, true)).filter(Boolean).length / 1000).toBeGreaterThanOrEqual(0.9);
  });
});
