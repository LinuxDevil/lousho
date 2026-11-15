import { describe, it, expect } from 'vitest';
import { AUTHOR_TOOL_NAMES } from '../../../server/author/toolNames';
import { ACTIVITY_LABELS, activityStateOf } from '../activityLabels';
import type { AuthorToolPart } from '../../../shared/authorWire';

function part(over: Partial<AuthorToolPart>): AuthorToolPart {
  return { type: 'tool', toolCallId: 't1', name: 'getCurrentSpec', input: {}, state: 'done', ...over };
}

describe('ACTIVITY_LABELS', () => {
  it('has a busy/done/failed row for every Author tool name', () => {
    for (const name of AUTHOR_TOOL_NAMES) {
      const row = ACTIVITY_LABELS[name];
      expect(row, `missing ACTIVITY_LABELS row for ${name}`).toBeDefined();
      expect(row.busy, `${name}.busy`).toBeTruthy();
      expect(row.done, `${name}.done`).toBeTruthy();
      expect(row.failed, `${name}.failed`).toBeTruthy();
    }
  });
});

describe('activityStateOf', () => {

  it('is failed on state error or output.ok === false', () => {
    expect(activityStateOf(part({ state: 'error' }))).toBe('failed');
    expect(activityStateOf(part({ state: 'done', output: { ok: false, code: 'NOT_FOUND' } }))).toBe('failed');
  });
});
