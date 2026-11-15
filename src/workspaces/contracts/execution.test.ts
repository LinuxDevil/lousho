import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { WORK_TYPES } from './page';
import { formatArtifactUri, parseArtifactUri, STEP_KINDS, WORK_TYPE_STEP_KINDS } from './execution';

describe('execution contract', () => {

  it.each([
    'artifact://marketing/%2E%2E/a.md',
  ])('parseArtifactUri rejects %s', (uri) => {
    expect(parseArtifactUri(uri)).toBeUndefined();
  });

  it.each([
    { workspace: 'marketing', runId: '../../other', name: 'a.md' },
    { workspace: 'marketing', runId: 'run', name: '../../secrets' },
  ])('formatArtifactUri rejects $workspace / $runId / $name', (parts) => {
    expect(() => formatArtifactUri(parts)).toThrow(ValidationError);
  });

  it('every WorkType lists the step kinds it may emit', () => {
    expect(STEP_KINDS).toEqual(['single', 'workflow-step', 'delegate', 'goal-iteration']);
    for (const type of WORK_TYPES) {
      expect(WORK_TYPE_STEP_KINDS[type].length).toBeGreaterThan(0);
      for (const kind of WORK_TYPE_STEP_KINDS[type]) expect(STEP_KINDS).toContain(kind);
    }
    expect(WORK_TYPE_STEP_KINDS['goal-oriented']).toEqual(['goal-iteration', 'delegate']);
    expect(WORK_TYPE_STEP_KINDS.single).toEqual(['single']);
    expect(WORK_TYPE_STEP_KINDS.workflow).toContain('workflow-step');
    expect(WORK_TYPE_STEP_KINDS['multi-agent']).toContain('delegate');
  });
});
