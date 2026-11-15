import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IngestEvent } from './envelope';
import { failureReportFromDb, failureReportFromTraces, formatFailureReport, groupFailures, type FailureSample } from './failures';
import { ingestBatch, interruptAgentWork, openDb } from './store';

const T0 = 1_790_000_000_000;

const sample = (over: Partial<FailureSample> = {}): FailureSample => ({
  agent: 'support',
  source: 'lookup',
  operation: 'execute_tool',
  error: 'request timed out after 100ms',
  traceId: 't1',
  at: T0,
  ...over,
});

function tool(id: string, trace: string, over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}, attrs: Record<string, unknown> = {}): IngestEvent {
  return {
    type: 'observation',
    data: {
      obs_id: id,
      trace_id: trace,
      agent_id: 'support',
      kind: 'tool',
      name: 'execute_tool lookup',
      start: T0,
      end: T0 + 5,
      attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', ...attrs },
      ...over,
    },
  };
}

const failed = (id: string, trace: string, error: string, attrs: Record<string, unknown> = {}, over = {}) =>
  tool(id, trace, { status: 'error', ...over }, { error, ...attrs });

describe('groupFailures', () => {

  it('labels the guard own denials, and counts hints', () => {
    const [denied] = groupFailures([sample({ error: "hook 'progress-guard' denied: [progress-guard] 'lookup' was called 3 times" })]);
    expect(denied.failureClass).toBe('guard-denied');
    const [stopped] = groupFailures([sample({ error: 'The run was stopped.\n[LOUSHO_RUN_NO_PROGRESS] Read the events.' })]);
    expect(stopped.failureClass).toBe('guard-denied');
    const [hinted] = groupFailures([sample({ hinted: true }), sample({ traceId: 't2' })]);
    expect(hinted.hints).toBe(1);
  });
});

describe('failureReportFromDb', () => {

  it('lists runs whose process died, so they are not read as the agent stopping', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [
      { type: 'observation', data: { obs_id: 'r1', trace_id: 't1', agent_id: 'a', kind: 'span', name: 'invoke_agent doc-qa', start: T0, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'doc-qa' } } },
    ]);
    interruptAgentWork(db, 'a', T0 + 100);
    const report = failureReportFromDb(db, {});
    expect(report.scanned.interrupted).toBe(1);
    expect(report.groups[0]).toMatchObject({ agent: 'doc-qa', source: 'run', failureClass: 'interrupted' });
    db.close();
  });

  it('survives attrs that are not valid JSON objects', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [failed('o1', 't1', 'boom')]);
    db.prepare("UPDATE observations SET attrs = 'not json' WHERE obs_id = 'o1'").run();
    expect(failureReportFromDb(db, {}).groups).toEqual([]);
    db.close();
  });
});

describe('failureReportFromTraces', () => {
  it('lists no-answer runs from trace files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-failures-'));
    const day = path.join(dir, '2026-11-01');
    fs.mkdirSync(day);
    const line = { v: 1, traceId: 'abc', id: 'abc', name: 'invoke_agent doc-qa', startTime: T0, endTime: T0 + 1, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'doc-qa', 'lousho.run.finish_reason': 'max-steps' } };
    fs.writeFileSync(path.join(day, 'abc.jsonl'), `${JSON.stringify(line)}\n`);
    const report = await failureReportFromTraces([dir]);
    expect(report.scanned.noAnswer).toBe(1);
    expect(report.groups[0]).toMatchObject({ failureClass: 'no-answer', agent: 'doc-qa' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads trace files from each directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-failures-'));
    const day = path.join(dir, '2026-11-01');
    fs.mkdirSync(day);
    const base = { v: 1, traceId: 'abc', startTime: T0, endTime: T0 + 1 };
    const lines = [
      { ...base, id: 'abc', name: 'invoke_agent support', status: { code: 'error' }, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', error: 'boom' } },
      { ...base, id: 's1', parentId: 'abc', name: 'execute_tool lookup', status: { code: 'error' }, attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', 'gen_ai.agent.name': 'support', error: 'boom' } },
      { ...base, id: 's2', parentId: 'abc', name: 'chat m', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.agent.name': 'support' } },
    ];
    fs.writeFileSync(path.join(day, 'abc.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const report = await failureReportFromTraces([dir]);
    expect(report.scanned).toEqual({ traces: 1, spans: 2, failed: 1, noAnswer: 0, interrupted: 0, lowScores: 0 });
    expect(report.groups[0]).toMatchObject({ agent: 'support', source: 'lookup', example: 'boom' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatFailureReport', () => {

  it('marks recurring failures and links their traces', () => {
    const text = formatFailureReport({ scanned: { traces: 2, spans: 4, failed: 2, noAnswer: 0, interrupted: 0, lowScores: 0 }, groups: groupFailures([sample({ traceId: 't1' }), sample({ traceId: 't2' })]) });
    expect(text).toContain('RECURRING');
    expect(text).toContain('timeout');
    expect(text).toContain('t1');
  });
});
