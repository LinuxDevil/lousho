import { describe, it, expect } from 'vitest';
import { appendLog, filterLogs } from '../logReducer';
import type { LogEntry } from '../../../shared/wireTypes';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: overrides.id ?? Math.random().toString(36),
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    level: 'info',
    phase: 'trigger',
    message: 'hello',
    ...overrides,
  };
}

describe('appendLog', () => {

  it('never mutates the input buffer', () => {
    const original = [entry({ id: '1' })];
    const next = appendLog(original, entry({ id: '2' }), 10);
    expect(original).toHaveLength(1);
    expect(next).not.toBe(original);
  });
});

describe('filterLogs', () => {
  const buf: LogEntry[] = [
    entry({ id: '1', level: 'info', phase: 'trigger', message: 'run started' }),
    entry({ id: '2', level: 'tool', phase: 'tool', toolName: 'current-date', message: 'Tool call: current-date' }),
    entry({ id: '3', level: 'error', phase: 'tool', toolName: 'current-date', message: 'Tool failed: boom' }),
  ];

  it('filters by level', () => {
    const result = filterLogs(buf, { levels: new Set(['error']) });
    expect(result.map((e) => e.id)).toEqual(['3']);
  });

  it('filters by case-insensitive search text against message and toolName', () => {
    expect(filterLogs(buf, { search: 'BOOM' }).map((e) => e.id)).toEqual(['3']);
    expect(filterLogs(buf, { search: 'current-date' }).map((e) => e.id)).toEqual(['2', '3']);
  });
});
