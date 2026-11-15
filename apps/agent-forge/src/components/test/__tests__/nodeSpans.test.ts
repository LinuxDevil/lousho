import { describe, expect, it } from 'vitest';
import { spansForNode } from '../nodeSpans';
import type { SpanEvent } from '../../../../shared/wireTypes';

let seq = 0;
function span(id: string, nodeId: string | undefined, parentId?: string): SpanEvent {
  seq += 1;
  return {
    id,
    name: id,
    parentId,
    startTime: seq,
    attributes: nodeId === undefined ? {} : { 'lousho.node.id': nodeId },
  };
}

describe('spansForNode', () => {

  it('cuts parentId when the parent span is filtered out, so the span becomes a root', () => {
    const parent = span('sub-root', 'sub:research');
    const child = span('child', 'sub:research/tool:web_fetch', 'sub-root');
    // Asking for the child path alone leaves its parent outside the set.
    const [matched] = spansForNode([parent, child], 'sub:research/tool:web_fetch');
    expect(matched.id).toBe('child');
    expect(matched.parentId).toBeUndefined();
    // The original span is not mutated.
    expect(child.parentId).toBe('sub-root');
  });
});
