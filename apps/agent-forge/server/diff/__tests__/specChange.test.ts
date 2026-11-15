import { describe, it, expect } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import { diffSpecs } from '../specChange';
import type { SpecSnapshot } from '../../../shared/wireTypes';

/**
 * `diffSpecs` - the `SpecChange[]` the version diff route, draft cards and
 * Author proposal cards render: one entry per changed plain field, per-item
 * entries for keyed lists (`tools[web-fetch]`), and a unified line diff for
 * instructions.
 */
function snapshot(spec: Record<string, unknown>, labels: string[] = []): SpecSnapshot {
  return {
    spec: { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run.', ...spec } as AgentSpecV2,
    labels,
  };
}

describe('diffSpecs', () => {

  it('keys two identical builtin refs as http and http#2', () => {
    const before = snapshot({ tools: [{ builtin: 'http' }] });
    const after = snapshot({ tools: [{ builtin: 'http' }, { builtin: 'http' }] });
    expect(diffSpecs(before, after)).toEqual([
      {
        field: 'tools[http#2]',
        label: 'Tool: http#2',
        section: 'Tools',
        op: 'add',
        after: { builtin: 'http' },
      },
    ]);
  });

  it('reports an edit on the one guardrail that changed and nothing for untouched ones', () => {
    const guardrails = [
      { id: 'g1', name: 'pii' },
      { id: 'g2', name: 'regex' },
    ];
    const before = snapshot({ guardrails });
    const after = snapshot({ guardrails: [guardrails[0], { ...guardrails[1], options: { action: 'block' } }] });
    expect(diffSpecs(before, after)).toEqual([
      {
        field: 'guardrails[g2]',
        label: 'Guardrail: g2',
        section: 'Safety',
        op: 'edit',
        before: guardrails[1],
        after: after.spec.guardrails![1],
      },
    ]);
  });

  it('line-diffs a mid-file instructions change: gap, context, del, add, context, gap', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const before = snapshot({ instructions: lines.join('\n') });
    const afterLines = [...lines];
    afterLines[19] = 'line 20 changed';
    const after = snapshot({ instructions: afterLines.join('\n') });

    const changes = diffSpecs(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: 'instructions', label: 'Instructions', section: 'Instructions', op: 'edit' });
    expect(changes[0].lines).toEqual([
      { kind: 'gap', count: 16 },
      { kind: 'context', text: 'line 17' },
      { kind: 'context', text: 'line 18' },
      { kind: 'context', text: 'line 19' },
      { kind: 'del', text: 'line 20' },
      { kind: 'add', text: 'line 20 changed' },
      { kind: 'context', text: 'line 21' },
      { kind: 'context', text: 'line 22' },
      { kind: 'context', text: 'line 23' },
      { kind: 'gap', count: 17 },
    ]);
  });

  it('diffs labels as a plain field: add, remove and edit', () => {
    expect(diffSpecs(snapshot({}, []), snapshot({}, ['ops']))).toEqual([
      { field: 'labels', label: 'Labels', section: 'Identity', op: 'add', after: ['ops'] },
    ]);
    expect(diffSpecs(snapshot({}, ['ops']), snapshot({}, []))).toEqual([
      { field: 'labels', label: 'Labels', section: 'Identity', op: 'remove', before: ['ops'] },
    ]);
    expect(diffSpecs(snapshot({}, ['ops']), snapshot({}, ['ops', 'nightly']))).toEqual([
      { field: 'labels', label: 'Labels', section: 'Identity', op: 'edit', before: ['ops'], after: ['ops', 'nightly'] },
    ]);
  });
});
