
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from '../storage/sqlite/driver';
import type { AlertEvent } from './alerts';
import type { IngestEvent } from './envelope';
import { ingestBatch, openDb } from './store';
import { sweepAgents, type ScoreRegressionMemory } from './sweep';

const T0 = 1_700_000_000_000;
const R1 = 'a'.repeat(64);
const R2 = 'b'.repeat(64);
const NOW = T0 + 10_000_000;

const heartbeat = (agentId = 'uuid-1', name = 'support', ts = NOW): IngestEvent => ({ type: 'agent.heartbeat', data: { agent_id: agentId, name, ts } }) as IngestEvent;

function run(i: number, revision: string | undefined, value: number, agentId = 'uuid-1'): IngestEvent[] {
  const trace = `${agentId}-${revision?.slice(0, 1) ?? 'x'}${i}`;
  return [
    {
      type: 'observation',
      data: {
        obs_id: `root-${trace}`,
        trace_id: trace,
        agent_id: agentId,
        kind: 'span',
        name: 'invoke_agent support',
        start: T0 + i * 1000,
        end: T0 + i * 1000 + 10,
        status: 'ok',
        attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.run.finish_reason': 'stop', ...(revision && { 'lousho.harness.revision': revision }) },
      },
    } as IngestEvent,
    { type: 'score', data: { score_id: `s-${trace}`, trace_id: trace, name: 'quality', value, source: 'online', agent_id: agentId, ts: T0 + i * 1000 + 20 } } as IngestEvent,
  ];
}

const runs = (from: number, count: number, revision: string | undefined, value: number, agentId?: string): IngestEvent[] =>
  Array.from({ length: count }, (_, i) => run(from + i, revision, value, agentId)).flat();
const regressions = (alerts: readonly AlertEvent[]) => alerts.filter((alert) => alert.type === 'agent.score_regression');
const memory = () => new Map<string, ScoreRegressionMemory>();

afterEach(() => {
  vi.restoreAllMocks();
});

type Stream = { db: SqlDatabase; state: Map<string, ScoreRegressionMemory>; next: number; fired: AlertEvent[] };

function stream(): Stream {
  const db = openDb(':memory:');
  ingestBatch(db, [heartbeat()]);
  return { db, state: memory(), next: 0, fired: [] };
}

function feed(target: Stream, count: number, revision: string | undefined, value: number | (() => number)): AlertEvent[] {
  const before = target.fired.length;
  for (let i = 0; i < count; i++) {
    ingestBatch(target.db, run(target.next, revision, typeof value === 'number' ? value : value()));
    target.next += 1;
    target.fired.push(...regressions(sweepAgents(target.db, NOW + target.next, { scoreRegressionState: target.state }).alerts));
  }
  return target.fired.slice(before);
}

describe('the agent.score_regression alert', () => {

  it('never repeats a revision while revisions interleave, and names an unstamped run null', () => {
    const target = stream();
    feed(target, 30, undefined, 0.9);
    expect(feed(target, 30, undefined, 0.5).map((alert) => alert.details.revision)).toEqual([null]);
    let flip = 0;
    for (let i = 0; i < 6; i++) feed(target, 7, (flip++ % 2 === 0 ? R1 : R2), 0.5);
    const revisions = target.fired.map((alert) => alert.details.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    target.db.close();
  });

  it('a failing score pass never costs the sweep its down alert', () => {
    const db = openDb(':memory:');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ingestBatch(db, [heartbeat('uuid-1', 'support', T0), ...runs(0, 30, R1, 0.9)]);
    db.exec('DROP TABLE scores');

    const result = sweepAgents(db, NOW, { scoreRegressionState: memory() });
    expect(result.alerts.map((alert) => alert.type)).toEqual(['agent.status']);
    expect(error).toHaveBeenCalledWith('[lousho observe] score regression pass failed:', expect.anything());
    db.close();
  });
});
