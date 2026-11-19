import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_INPUT } from '../../../../shared/runInput';
import type { ChatMessage, RunListRow, RunSetup } from '../../../../shared/wireTypes';
import { argPreview, buildTimeline, clipText, countRuns, filterRuns, runDurationMs, runPath, triggerLabel } from '../runsModel';

const row = (patch: Partial<RunListRow> = {}): RunListRow => ({
  workspaceId: 'w-1',
  workspaceName: 'W',
  agentId: 'ops',
  agentName: 'Ops',
  chatId: 'c1',
  status: 'ok',
  live: false,
  turns: 1,
  startTime: 1_000,
  lastActivity: 5_000,
  ...patch,
});

const msg = (patch: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => ({ content: '', timestamp: '2026-01-01T10:00:00.000Z', ...patch });

const setup: RunSetup = { accounts: [{ integration: 'github', tools: ['list_issues'], approvals: [] }], declared: ['github'], mcpServers: [], skipped: [], tools: 3 };

describe('run list helpers', () => {
  it('counts all, live and failed runs', () => {
    const rows = [row(), row({ chatId: 'c2', live: true, status: 'running' }), row({ chatId: 'c3', status: 'error' }), row({ chatId: 'c4', status: 'error' })];
    expect(countRuns(rows)).toEqual({ all: 4, live: 1, error: 2 });
  });

  it('filters by chip', () => {
    const rows = [row(), row({ chatId: 'c2', live: true, status: 'running' }), row({ chatId: 'c3', status: 'error' })];
    expect(filterRuns(rows, 'all')).toHaveLength(3);
    expect(filterRuns(rows, 'live').map((r) => r.chatId)).toEqual(['c2']);
    expect(filterRuns(rows, 'error').map((r) => r.chatId)).toEqual(['c3']);
  });

  it('builds a workspace-prefixed, encoded run path', () => {
    expect(runPath({ workspaceId: 'w-1', agentId: 'ops', chatId: 'a b' })).toBe('/w/w-1/runs/ops/a%20b');
  });

  it('names the trigger and derives a duration only for a finished run', () => {
    expect(triggerLabel(row())).toBe('manual');
    expect(triggerLabel(row({ source: 'trigger', triggerId: 'nightly' }))).toBe('nightly');
    expect(runDurationMs(row())).toBe(4_000);
    expect(runDurationMs(row({ live: true }))).toBeUndefined();
    expect(runDurationMs(row({ lastActivity: undefined }))).toBeUndefined();
  });
});

describe('argPreview and clipText', () => {
  it('flattens an object to one line', () => {
    expect(argPreview('{"query":"refund policy","limit":3}')).toBe('query: refund policy, limit: 3');
    expect(argPreview('not json\nsecond line')).toBe('not json second line');
  });

  it('clips long text by characters and by lines', () => {
    expect(clipText('short')).toEqual({ shown: 'short', clipped: false });
    expect(clipText('x'.repeat(2000)).clipped).toBe(true);
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    expect(clipText(lines).shown.split('\n')).toHaveLength(12);
  });
});

describe('buildTimeline', () => {
  const transcript: ChatMessage[] = [
    msg({ id: 's', role: 'system', content: 'You are Ops.' }),
    msg({ id: 'u1', role: 'user', content: 'Close stale issues\nplease', source: 'run' }),
    msg({
      id: 'a1',
      role: 'assistant',
      content: 'Looking now.\nI will list them first.',
      toolCalls: [
        { id: 't1', type: 'function', function: { name: 'list_issues', arguments: '{"state":"open"}' } },
        { id: 't2', type: 'function', function: { name: 'close_issue', arguments: '{"id":7}' } },
      ],
    }),
    msg({ id: 'r1', role: 'tool', toolCallId: 't1', toolName: 'list_issues', content: '{"issues":[7]}' }),
    msg({ id: 'r2', role: 'tool', toolCallId: 't2', toolName: 'close_issue', content: '{"error":"forbidden"}', isError: true }),
    msg({ id: 'a2', role: 'assistant', content: 'Done.' }),
  ];

  it('orders setup, run started, assistant text, tool calls and the final row', () => {
    const steps = buildTimeline({ messages: transcript, setup, row: row() });
    expect(steps.map((s) => [s.kind, s.title])).toEqual([
      ['setup', 'Setup · 1 connected account (github) · 1 declared integration (github) · 3 tools'],
      ['start', 'Run started'],
      ['assistant', 'Looking now.'],
      ['tool', 'list_issues'],
      ['tool', 'close_issue'],
      ['assistant', 'Done.'],
      ['end', 'Finished'],
    ]);
  });

  it('carries the user input and the setup detail', () => {
    const steps = buildTimeline({ messages: transcript, setup, row: row() });
    expect(steps[1]).toMatchObject({ preview: 'Close stale issues', body: 'Close stale issues\nplease' });
    expect(steps[0].body).toContain('github: list_issues');
    expect(steps[2].body).toBe('Looking now.\nI will list them first.');
  });

  it('shows the Run started marker alone for the default run input', () => {
    const steps = buildTimeline({ messages: [msg({ id: 'u', role: 'user', content: DEFAULT_RUN_INPUT, source: 'run' })], row: row() });
    expect(steps[0]).toMatchObject({ kind: 'start', title: 'Run started' });
    expect(steps[0].body).toBeUndefined();
    expect(steps[0].preview).toBeUndefined();
  });

  it('marks tool calls ok, failed, or waiting for approval', () => {
    const steps = buildTimeline({ messages: transcript, row: row() });
    const tools = steps.filter((s) => s.kind === 'tool');
    expect(tools.map((s) => s.toolState)).toEqual(['done', 'error']);
    expect(tools[0].preview).toBe('state: open');
    expect(tools[1].tool?.result).toContain('forbidden');

    const pending = [transcript[1], { ...transcript[2], toolCalls: [transcript[2].toolCalls![0]] }];
    const waiting = buildTimeline({ messages: pending, row: row({ status: 'paused', live: true }) });
    expect(waiting.find((s) => s.kind === 'tool')?.toolState).toBe('waiting');
    expect(waiting.at(-1)).toMatchObject({ title: 'Waiting for approval', endState: 'waiting' });
    const stopped = buildTimeline({ messages: pending, row: row({ status: 'error' }) });
    expect(stopped.find((s) => s.kind === 'tool')?.toolState).toBe('interrupted');
  });

  it('ends with Failed, Failed with the reason, or Running for a live run', () => {
    expect(buildTimeline({ messages: [], row: row({ status: 'error' }) }).at(-1)).toMatchObject({ title: 'Failed', endState: 'error' });
    expect(buildTimeline({ messages: [], row: row({ status: 'error' }), failure: 'Provider rejected the key' }).at(-1)?.title).toBe('Failed: Provider rejected the key');
    const running = buildTimeline({ messages: [], row: row({ status: 'running', live: true }) }).at(-1);
    expect(running).toMatchObject({ title: 'Running…', endState: 'running' });
    expect(running?.time).toBeUndefined();
  });

  it('leaves the Setup row out when none was recorded', () => {
    expect(buildTimeline({ messages: transcript, row: row() }).some((s) => s.kind === 'setup')).toBe(false);
  });

  it('labels a later user turn as a message, and a steer as Steered', () => {
    const steps = buildTimeline({
      messages: [msg({ id: 'u1', role: 'user', content: 'first' }), msg({ id: 'u2', role: 'user', content: 'second' }), msg({ id: 'u3', role: 'user', content: 'steer', source: 'steer' })],
      row: row(),
    });
    expect(steps.slice(0, 3).map((s) => s.title)).toEqual(['Run started', 'Message', 'Steered']);
  });
});
