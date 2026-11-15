/**
 * `GET /api/v1/scores` read surface: row filters (trace, name, eval-name
 * prefix, agent, source, time range) and the `aggregate=eval` pass-rate
 * rollup the Studio eval-history view reads.
 */
import { startEvaluatorWorker } from '../evaluatorWorker';
import { describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import type { IngestEvent } from '../envelope';
import { ingestBatch, openDb, type ScoreRow } from '../store';
import type { SqlDatabase } from '../../storage/sqlite/driver';
// Imported through the route registry (production's load order): importing
// './scores' first would hit the index<->feature-file cycle with scoresRoutes
// still uninitialized.
import { matchRoute } from './index';

const T0 = 1_700_000_000_000;

const score = (over: Record<string, unknown> = {}): IngestEvent => ({
  type: 'score',
  data: { score_id: `s${Math.random().toString(36).slice(2)}`, trace_id: 't1', name: 'eval-a/completed()', value: 1, source: 'eval', ts: T0, ...over },
});

function db(): SqlDatabase {
  return openDb(':memory:');
}

interface Captured {
  status: number;
  body: unknown;
}

/** Calls the route's handler with a recording ServerResponse stand-in. */
function get(database: SqlDatabase, query: string): Captured {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      captured.body = chunk === undefined ? undefined : JSON.parse(chunk);
    },
  } as unknown as http.ServerResponse;
  const matched = matchRoute('GET', '/api/v1/scores');
  if (!matched) throw new Error('scores route not registered');
  matched.route.handle({
    db: database,
    dbPath: ':memory:',
    evaluators: startEvaluatorWorker(database),
    req: {} as http.IncomingMessage,
    res,
    params: matched.params,
    query: new URLSearchParams(query),
    readBody: () => Promise.reject(new Error('GET has no body')),
  });
  return captured;
}

const scoresOf = (captured: Captured): ScoreRow[] => (captured.body as { scores: ScoreRow[] }).scores;

describe('GET /api/v1/scores filters', () => {

  it('matches the eval-name prefix with eval= (the row itself and its assertion family)', () => {
    const database = db();
    try {
      ingestBatch(database, [
        score({ score_id: 'a', name: 'refund/completed()' }),
        score({ score_id: 'b', name: 'refund/tone' }),
        score({ score_id: 'c', name: 'refund-extra/other' }),
        score({ score_id: 'd', name: 'plain' }),
      ]);
      const rows = scoresOf(get(database, 'eval=refund'));
      expect(rows.map((s) => s.score_id).sort()).toEqual(['a', 'b']);
      expect(scoresOf(get(database, 'eval=plain')).map((s) => s.score_id)).toEqual(['d']);
    } finally {
      database.close();
    }
  });

  it('bounds by created_at with since/until and honours limit', () => {
    const database = db();
    try {
      ingestBatch(database, [
        score({ score_id: 'old', ts: T0 - 10_000 }),
        score({ score_id: 'mid', ts: T0 }),
        score({ score_id: 'new', ts: T0 + 10_000 }),
      ]);
      expect(scoresOf(get(database, `since=${T0}`)).map((s) => s.score_id).sort()).toEqual(['mid', 'new']);
      expect(scoresOf(get(database, `until=${T0}`)).map((s) => s.score_id)).toEqual(['old']);
      expect(scoresOf(get(database, 'limit=1'))).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

describe('GET /api/v1/scores?aggregate=eval', () => {

  it('honours the same filters (agent, time range) as the row listing', () => {
    const database = db();
    try {
      ingestBatch(database, [
        score({ score_id: 'a', name: 'eval/a', agent_id: 'ag1', ts: T0 }),
        score({ score_id: 'b', name: 'eval/b', agent_id: 'ag2', ts: T0 + 999_999 }),
      ]);
      const res = get(database, `aggregate=eval&agent_id=ag1`);
      const { evals } = res.body as { evals: { name: string; count: number }[] };
      expect(evals).toEqual([{ name: 'eval', count: 1, passed: 1, pass_rate: 1, avg_value: 1, last_ts: T0 }]);
      const bounded = get(database, `aggregate=eval&until=${T0 + 1}`);
      expect((bounded.body as { evals: { count: number }[] }).evals[0].count).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects a bad aggregate or source value with 400', () => {
    const database = db();
    try {
      expect(get(database, 'aggregate=bogus').status).toBe(400);
      expect(get(database, 'source=bogus').status).toBe(400);
    } finally {
      database.close();
    }
  });
});

const obsEvent = (over: Record<string, unknown> = {}): IngestEvent => ({
  type: 'observation',
  data: { obs_id: 'o-root', trace_id: 'tf', kind: 'span', name: 'run', start: T0, agent_id: 'ag-root', ...over },
} as IngestEvent);

/** POSTs a raw body to the route through a recording ServerResponse stand-in. */
async function post(database: SqlDatabase, body: unknown): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      captured.body = chunk === undefined ? undefined : JSON.parse(chunk);
    },
  } as unknown as http.ServerResponse;
  const matched = matchRoute('POST', '/api/v1/scores');
  if (!matched) throw new Error('POST scores route not registered');
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  await matched.route.handle({
    db: database,
    dbPath: ':memory:',
    evaluators: startEvaluatorWorker(database),
    req: {} as http.IncomingMessage,
    res,
    params: matched.params,
    query: new URLSearchParams(),
    readBody: () => Promise.resolve(text),
  });
  return captured;
}

describe('POST /api/v1/scores (human feedback)', () => {
  const seeded = (): SqlDatabase => {
    const database = db();
    ingestBatch(database, [
      obsEvent(),
      obsEvent({ obs_id: 'o-child', parent_obs_id: 'o-root', kind: 'generation', agent_id: undefined }),
      obsEvent({ obs_id: 'o-other', trace_id: 'other' }),
    ]);
    return database;
  };

  it('is append-only: the same body twice makes two rows; null value and obs_id are accepted', async () => {
    const database = seeded();
    try {
      const a = await post(database, { trace_id: 'tf', obs_id: 'o-child', name: 'rating', value: null });
      const b = await post(database, { trace_id: 'tf', obs_id: 'o-child', name: 'rating', value: null });
      expect([a.status, b.status]).toEqual([201, 201]);
      const rows = scoresOf(get(database, 'trace_id=tf'));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ obs_id: 'o-child', value: null });
    } finally {
      database.close();
    }
  });

  it('404s for an unknown trace and for an obs_id outside the trace', async () => {
    const database = seeded();
    try {
      const noTrace = await post(database, { trace_id: 'nope', name: 'x', value: 1 });
      expect(noTrace.status).toBe(404);
      expect(noTrace.body).toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });
      expect((await post(database, { trace_id: 'tf', obs_id: 'o-other', name: 'x', value: 1 })).status).toBe(404);
      expect((await post(database, { trace_id: 'tf', obs_id: 'missing', name: 'x', value: 1 })).status).toBe(404);
      expect(scoresOf(get(database, ''))).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});
