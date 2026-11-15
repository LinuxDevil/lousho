import { describe, expect, it } from 'vitest';
import { diagnosisNote } from '../agentRecover';
import type { IngestEvent } from '../observe/envelope';
import { ingestBatch, openDb } from '../observe/store';
import { mockModel, type MockTurn } from '../testing';
import { casesFromRecoveries, improveAgent, type Harness, type ImproveOptions, type ProbeRun } from './index';

const T0 = 1_790_000_000_000;

type ObservationData = Extract<IngestEvent, { type: 'observation' }>['data'];

const obs = (data: ObservationData): IngestEvent => ({ type: 'observation', data });

const messages = (role: string, text: string) => JSON.stringify([{ role, parts: [{ type: 'text', content: text }] }]);

const rootRun = (trace: string, session: string, start: number, over: Partial<ObservationData> = {}): IngestEvent =>
  obs({
    obs_id: `r-${trace}`,
    trace_id: trace,
    session_id: session,
    agent_id: 'support',
    kind: 'span',
    name: 'invoke_agent support',
    start,
    end: start + 9,
    status: 'ok',
    input: messages('user', 'Refund order 42'),
    output: messages('assistant', 'Refunded order 42.'),
    attrs: { 'gen_ai.operation.name': 'invoke_agent' },
    ...over,
  });

const tool = (id: string, trace: string, start: number, over: Partial<ObservationData> = {}): IngestEvent =>
  obs({
    obs_id: id,
    trace_id: trace,
    parent_obs_id: `r-${trace}`,
    agent_id: 'support',
    kind: 'tool',
    name: 'execute_tool lookup',
    start,
    end: start + 2,
    status: 'ok',
    input: '{"order":42}',
    output: '{"status":"paid"}',
    attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup' },
    ...over,
  });

const failedTool = (id: string, trace: string, start: number, error = 'request timed out') =>
  tool(id, trace, start, { status: 'error', output: undefined, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', error } });

const diagnosis = diagnosisNote({ sessionId: 's1', checkpointId: 's1', kind: 'run', status: 'in-progress', step: 1, attempts: 10, lastError: { message: 'request timed out', at: '', retryable: true } } as never);

const diagnosed = (id: string, trace: string, start: number, text = diagnosis) =>
  obs({
    obs_id: id,
    trace_id: trace,
    parent_obs_id: `r-${trace}`,
    agent_id: 'support',
    kind: 'generation',
    name: 'chat mock',
    start,
    end: start + 1,
    status: 'ok',
    input: JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: 'Refund order 42' }] },
      { role: 'user', parts: [{ type: 'text', content: text }] },
    ]),
    attrs: { 'gen_ai.operation.name': 'chat' },
  });

const failedRun = (trace: string, session: string, start: number) => [rootRun(trace, session, start, { output: undefined }), failedTool(`f-${trace}`, trace, start + 1)];

const healedRun = (trace: string, session: string, start: number) => [rootRun(trace, session, start), diagnosed(`g-${trace}`, trace, start + 1), tool(`t-${trace}`, trace, start + 2)];

function database(events: IngestEvent[]) {
  const db = openDb(':memory:');
  ingestBatch(db, events);
  return db;
}

describe('casesFromRecoveries', () => {

  it('returns nothing when the fork failed, ran out of steps, scored low or never finished', () => {
    const failedFork = database([...failedRun('t1', 's1', T0), ...failedRun('h1', 's1.heal', T0 + 100)]);
    const noAnswer = database([...failedRun('t1', 's1', T0), rootRun('h1', 's1.heal', T0 + 100, { attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.run.finish_reason': 'max-steps' } }), diagnosed('g-h1', 'h1', T0 + 101)]);
    const open = database([...failedRun('t1', 's1', T0), rootRun('h1', 's1.heal', T0 + 100, { end: undefined, status: undefined }), diagnosed('g-h1', 'h1', T0 + 101)]);
    const lowScore = database([...failedRun('t1', 's1', T0), ...healedRun('h1', 's1.heal', T0 + 100)]);
    lowScore.prepare("INSERT INTO scores (score_id, trace_id, name, value, source, created_at, updated_at) VALUES ('sc1', 'h1', 'helpful', 0.1, 'api', ?, ?)").run(T0 + 200, T0 + 200);
    for (const db of [failedFork, noAnswer, open, lowScore]) {
      expect(casesFromRecoveries(db)).toEqual([]);
      db.close();
    }
  });

  it('gives one case per fork when the recovery loop retried the run many times', () => {
    const attempts = Array.from({ length: 8 }, (_, i) => failedRun(`a${i}`, 's1', T0 + i * 10)).flat();
    const db = database([...attempts, ...healedRun('h1', 's1.heal', T0 + 500)]);
    const cases = casesFromRecoveries(db);
    expect(cases).toHaveLength(1);
    expect(cases[0].recovery?.traceId).toBe('h1');
    expect(cases[0].traceId).toBe('a4');
    db.close();
  });
});

describe('recovery evidence', () => {
  const recovery = { caseId: 'stuck', traceId: 'h1', diagnosis: 'The last 10 attempts at this run failed.', answer: 'done', transcript: 'user: hi\nassistant: done' };

  const BASE: Harness = { instructions: 'You answer questions.', skills: {} };
  const noEdit: MockTurn[] = ['<notes>KEEP_BASE.</notes>'];
  const run = (passed: boolean): ProbeRun => ({ passed, transcript: 'user: hi', tokens: 1, ended: 'stop' });
  const options = (over: Partial<ImproveOptions>): ImproveOptions => ({
    harness: BASE,
    cases: ['stuck'],
    holdout: ['held-out'],
    probe: async () => run(false),
    editor: { provider: mockModel([...noEdit, ...noEdit, ...noEdit]) },
    repeats: 1,
    ...over,
  });

  it('refuses a recovery for a held-out or unknown case, so a gated case never reaches the editors', async () => {
    await expect(improveAgent(options({ recoveries: [{ ...recovery, caseId: 'held-out' }] }))).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    await expect(improveAgent(options({ recoveries: [{ ...recovery, caseId: 'nope' }] }))).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });
});
