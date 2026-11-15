/**
 * The store's contract: idempotent upserts by primary key (a resent batch
 * lands once and rollups never double count), rollup recompute correctness,
 * truncation at the 64KB field cap, and token create/verify.
 */
import { describe, expect, it } from 'vitest';
import { loadDatabaseSync, type SqlDatabase } from '../storage/sqlite/driver';
import { migrate } from '../storage/sqlite/migrations';
import { migrateObserve, OBSERVE_MIGRATIONS } from './schema';
import { type IngestEvent } from './envelope';
import {
  createToken,
  hasTokens,
  insightsAgents,
  ingestBatch,
  listAgents,
  listTraces,
  observeCounts,
  openDb,
  rebuildRollups,
  rollupSeries,
  traceDetail,
  verifyToken,
} from './store';
import { sweepAgents } from './sweep';

const T0 = 1_700_000_000_000;

function db(): SqlDatabase {
  return openDb(':memory:');
}

function obs(over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}): IngestEvent {
  return {
    type: 'observation',
    data: { obs_id: 'o1', trace_id: 't1', agent_id: 'a1', kind: 'span', name: 'invoke_agent a', start: T0, end: T0 + 100, status: 'ok', ...over },
  };
}

const heartbeat = (agentId: string, ts: number, project = 'proj'): IngestEvent => ({
  type: 'agent.heartbeat',
  data: { agent_id: agentId, project, name: 'a', ts },
});

describe('prompt_labels migration', () => {
  it('backfills array-form string labels (highest version wins) and leaves record-form labels alone', () => {
    const DatabaseSync = loadDatabaseSync();
    const database = new DatabaseSync(':memory:');
    try {
      const index = OBSERVE_MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE prompt_labels'));
      expect(index).toBeGreaterThan(0);
      migrate(database, OBSERVE_MIGRATIONS.slice(0, index));
      const insert = database.prepare('INSERT INTO prompts (prompt_id, name, version, labels, created_at) VALUES (?, ?, ?, ?, ?)');
      insert.run('m1', 'mira', 1, JSON.stringify(['prod', 'canary', 7]), T0);
      insert.run('m2', 'mira', 2, JSON.stringify(['prod']), T0 + 1);
      insert.run('m3', 'mira', 3, JSON.stringify({ env: 'staging' }), T0 + 2);
      insert.run('g1', 'ghost', 1, null, T0);
      migrateObserve(database);
      const rows = database.prepare('SELECT name, label, version FROM prompt_labels ORDER BY name, label').all();
      expect(rows.map((r) => [r.name, r.label, Number(r.version)])).toEqual([
        ['mira', 'canary', 1],
        ['mira', 'prod', 2],
      ]);
      expect(database.prepare("SELECT labels FROM prompts WHERE prompt_id = 'm3'").get()?.labels).toBe(JSON.stringify({ env: 'staging' }));
    } finally {
      database.close();
    }
  });
});

describe('ingestBatch', () => {

  it('truncates input/output at 64KB and sets the truncated flag', () => {
    const database = db();
    try {
      const big = 'x'.repeat(70 * 1024);
      ingestBatch(database, [obs({ input: big, output: 'ok' })]);
      const row = traceDetail(database, 't1')?.observations[0];
      expect(row?.input?.length).toBe(64 * 1024);
      expect(row?.output).toBe('ok');
      expect(row?.truncated).toBe(true);
    } finally {
      database.close();
    }
  });

  it('exposes the latest heartbeat dropped count on the agent row, null when absent', () => {
    const database = db();
    try {
      ingestBatch(database, [heartbeat('old', T0)]);
      expect(listAgents(database, T0)[0].dropped).toBeNull();
      ingestBatch(database, [{ type: 'agent.heartbeat', data: { agent_id: 'a1', ts: T0, meta: { dropped: 7 } } }]);
      ingestBatch(database, [{ type: 'agent.heartbeat', data: { agent_id: 'a1', ts: T0 + 1, meta: { dropped: 9 } } }]);
      expect(listAgents(database, T0 + 1).find((a) => a.agent_id === 'a1')?.dropped).toBe(9);
    } finally {
      database.close();
    }
  });
});

describe('tokens', () => {
  it('creates a hashed key that verifies, and rejects wrong or missing keys', () => {
    const database = db();
    try {
      expect(hasTokens(database)).toBe(false);
      const { key } = createToken(database, 'proj');
      expect(key.startsWith('lso_')).toBe(true);
      expect(hasTokens(database)).toBe(true);
      expect(verifyToken(database, key)).toBe(true);
      expect(verifyToken(database, 'lso_wrong')).toBe(false);
      expect(verifyToken(database, undefined)).toBe(false);
      // only the hash is stored
      const row = database.prepare('SELECT key_hash FROM tokens').get();
      expect(String(row?.key_hash)).not.toBe(key);
    } finally {
      database.close();
    }
  });
});

describe('eager root start (end NULL until the end event lands)', () => {
  /** A run's root start event: what the reporter sends when the root span opens. */
  const start = (over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}): IngestEvent =>
    obs({ session_id: 's1', end: undefined, status: undefined, input: 'question', attrs: { phase: 'start' }, ...over });
  /** The same run's end event, carrying every column the start lacked. */
  const end = (over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}): IngestEvent =>
    obs({
      session_id: 's1',
      end: T0 + 250,
      status: 'error',
      input: 'question',
      output: 'answer',
      model: 'm-2',
      usage_input_tokens: 21,
      usage_output_tokens: 8,
      usage_cached_tokens: 4,
      usage_reasoning_tokens: 3,
      cost_usd: 0.25,
      cost_partial: true,
      usage_estimated: true,
      attrs: { phase: 'end' },
      ...over,
    });
  const row = (database: SqlDatabase) => traceDetail(database, 't1')?.observations[0];
  const finished = {
    end: T0 + 250,
    status: 'error',
    output: 'answer',
    model: 'm-2',
    usage_input_tokens: 21,
    usage_output_tokens: 8,
    usage_cached_tokens: 4,
    usage_reasoning_tokens: 3,
    cost_usd: 0.25,
    cost_partial: true,
    usage_estimated: true,
    attrs: { phase: 'end' },
  };
  const hourMetric = (database: SqlDatabase, metric: string) =>
    rollupSeries(database, { agent_id: 'a1', granularity: 'hour' }).find((r) => r.metric === metric)?.value;

  it('a start event then an end event yields one row with the end values', () => {
    const database = db();
    try {
      ingestBatch(database, [start()], T0);
      expect(row(database)).toMatchObject({ end: null, status: null, output: null, cost_usd: null });
      ingestBatch(database, [end()], T0 + 300);
      expect(row(database)).toMatchObject(finished);
      expect(observeCounts(database)).toMatchObject({ observations: 1, traces: 1, sessions: 1 });
      const { traces, total } = listTraces(database, { limit: 50, offset: 0 });
      expect(total).toBe(1);
      expect(traces[0]).toMatchObject({ status: 'error', observations: 1, end: T0 + 250, cost_usd: 0.25, input_tokens: 21 });
      // one run in the rollups, with the end event's numbers
      expect(hourMetric(database, 'runs')).toBe(1);
      expect(hourMetric(database, 'errors')).toBe(1);
      expect(hourMetric(database, 'cost_usd')).toBe(0.25);
      expect(hourMetric(database, 'latency_ms')).toBe(250);
      expect(Number(database.prepare("SELECT ended_at FROM sessions WHERE session_id = 's1'").get()?.ended_at)).toBe(T0 + 250);
    } finally {
      database.close();
    }
  });
});

describe('agent instances (one agent_id, several processes over time)', () => {
  /** A heartbeat of agent a1 from one process: `instance` on `host`/`pid`. */
  const beat = (instance: string | undefined, ts: number, proc: { host?: string; pid?: number; interval?: number } = {}): IngestEvent => ({
    type: 'agent.heartbeat',
    data: {
      agent_id: 'a1',
      project: 'proj',
      name: 'a',
      ts,
      heartbeat_interval_ms: proc.interval ?? 60_000,
      ...(instance !== undefined ? { instance_id: instance } : {}),
      ...(proc.host !== undefined ? { hostname: proc.host } : {}),
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
    },
  });
  /** An open run root started by `instance` (the reporter stamps it in attrs). */
  const openRoot = (obsId: string, instance?: string): IngestEvent =>
    obs({ obs_id: obsId, trace_id: `t-${obsId}`, end: undefined, status: undefined, attrs: instance !== undefined ? { 'lousho.instance_id': instance } : {} });
  const statusOf = (database: SqlDatabase, obsId: string) =>
    database.prepare('SELECT status FROM observations WHERE obs_id = ?').get(obsId)?.status ?? null;
  const traceStatus = (database: SqlDatabase, obsId: string) =>
    listTraces(database, { limit: 50, offset: 0 }).traces.find((t) => t.trace_id === `t-${obsId}`)?.status;
  const instances = (database: SqlDatabase) =>
    database.prepare('SELECT instance_id FROM agent_instances ORDER BY instance_id').all().map((r) => r.instance_id);
  const hostA = { host: 'h1', pid: 100 };
  const hostB = { host: 'h1', pid: 200 };

  it('a restart on the same host and pid interrupts the silent old instance once it missed a beat (interval + slack)', () => {
    const database = db();
    try {
      const c1 = { host: 'c1', pid: 1 }; // a container restarted: pid 1 again
      ingestBatch(database, [beat('A', T0, c1), openRoot('runA', 'A')], T0);
      ingestBatch(database, [beat('B', T0 + 1_000, c1), openRoot('runB', 'B')], T0 + 1_000);
      // one heartbeat proves nothing: a live twin in another pid namespace looks the same
      expect(traceStatus(database, 'runA')).toBe('running');
      ingestBatch(database, [beat('B', T0 + 61_000, c1)], T0 + 61_000);
      // 61s since A's last beat is still a live gap (beats ride the 5s flush tick)
      expect(traceStatus(database, 'runA')).toBe('running');
      ingestBatch(database, [beat('B', T0 + 121_000, c1)], T0 + 121_000);
      // A stayed silent since before B was first seen, past interval + slack: it is the process B replaced
      expect(traceStatus(database, 'runA')).toBe('interrupted');
      expect(traceStatus(database, 'runB')).toBe('running');
      expect(instances(database)).toEqual(['B']);
    } finally {
      database.close();
    }
  });

  it('a restart under a new pid interrupts the old instance once it passes stale while the new one is healthy', () => {
    const database = db();
    try {
      ingestBatch(database, [beat('A', T0, hostA), openRoot('runA', 'A')], T0);
      // A is SIGKILLed; B starts at once and keeps heartbeating
      for (let t = 1_000; t <= 241_000; t += 60_000) ingestBatch(database, [beat('B', T0 + t, hostB)], T0 + t);
      ingestBatch(database, [openRoot('runB', 'B')], T0 + 1_000);
      sweepAgents(database, T0 + 125_000); // A 125s quiet: within 2 x 60s + 10s
      expect(statusOf(database, 'runA')).toBeNull();
      const result = sweepAgents(database, T0 + 135_000); // past the stale boundary
      expect(result.transitions).toHaveLength(0); // the agent itself stays healthy
      expect(traceStatus(database, 'runA')).toBe('interrupted');
      expect(traceStatus(database, 'runB')).toBe('running');
      expect(instances(database)).toEqual(['B']);
    } finally {
      database.close();
    }
  });

  it('leaves a silent instance to the agent-level down path when no process of the agent is healthy', () => {
    const database = db();
    try {
      ingestBatch(database, [beat('A', T0, hostA), openRoot('runA', 'A')], T0);
      sweepAgents(database, T0 + 200_000); // stale, but nobody else is alive: not a verdict yet
      expect(statusOf(database, 'runA')).toBeNull();
      const result = sweepAgents(database, T0 + 400_000);
      expect(result.transitions[0]).toMatchObject({ to: 'down', crashed: true });
      expect(statusOf(database, 'runA')).toBe('interrupted');
      expect(instances(database)).toEqual([]); // a down agent's instances are all gone
    } finally {
      database.close();
    }
  });
});

describe('insights math and per-agent series (O14)', () => {
  const DAY = 86_400_000;

  it('writes p95_latency_ms and error_rate per bucket, survives rebuild, and stays out of the aggregates', () => {
    const database = db();
    try {
      const otherHour = T0 + 4 * 3_600_000;
      ingestBatch(database, [
        ...Array.from({ length: 20 }, (_, i) => obs({ obs_id: `r${i}`, trace_id: `t${i}`, start: T0, end: T0 + (i + 1) * 10, status: i < 5 ? 'error' : 'ok' })),
        // an open run counts as a run but has no latency
        obs({ obs_id: 'open', trace_id: 't-open', start: T0, end: undefined, status: undefined }),
        // a bucket whose only run is still open gets no p95 row
        obs({ obs_id: 'open2', trace_id: 't-open2', start: otherHour, end: undefined, status: undefined }),
      ]);
      const hour = T0 - (T0 % 3_600_000);
      const other = otherHour - (otherHour % 3_600_000);
      const check = () => {
        const rows = rollupSeries(database, { agent_id: 'a1', granularity: 'hour' });
        const metric = (bucket: number, m: string) => rows.find((r) => r.bucket_start === bucket && r.metric === m);
        expect(metric(hour, 'p95_latency_ms')).toMatchObject({ agent_id: 'a1', granularity: 'hour', value: 190 });
        expect(metric(hour, 'error_rate')?.value).toBeCloseTo(5 / 21);
        expect(metric(other, 'p95_latency_ms')).toBeUndefined();
        expect(metric(other, 'error_rate')?.value).toBe(0);
        const day = rollupSeries(database, { agent_id: 'a1', granularity: 'day' });
        expect(day.find((r) => r.metric === 'p95_latency_ms')?.value).toBe(190);
      };
      check();
      database.exec('DELETE FROM rollups');
      rebuildRollups(database);
      check();
      // p95_latency_ms / error_rate rows sit beside the additive ones: they must never sum into the aggregates
      const [agent] = insightsAgents(database, { since: T0 - 1, until: T0 + DAY });
      expect(agent).toMatchObject({ runs: 22, errors: 5, p95_latency_ms: 190 });
      expect(agent.error_rate).toBeCloseTo(5 / 22);
    } finally {
      database.close();
    }
  });
});

describe('session reopen on ingest', () => {
  const session = (database: SqlDatabase) =>
    database.prepare("SELECT status, ended_at FROM sessions WHERE session_id = 's1'").get();
  const closed = (status: 'ended' | 'interrupted'): SqlDatabase => {
    const database = db();
    ingestBatch(database, [obs({ session_id: 's1', start: T0, end: T0 + 100 })], T0 + 100);
    database.prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE session_id = 's1'").run(status, T0 + 100);
    return database;
  };

  for (const status of ['ended', 'interrupted'] as const) {
    it(`a new open trace in an ${status} session reopens it`, () => {
      const database = closed(status);
      try {
        ingestBatch(database, [obs({ obs_id: 'o2', trace_id: 't2', session_id: 's1', start: T0 + 5000, end: undefined, status: undefined })]);
        expect(session(database)).toMatchObject({ status: 'active', ended_at: null });
      } finally {
        database.close();
      }
    });
  }
});
