import { describe, it, expect } from 'vitest';
import type { EvalResult } from '../evals/evalResult';
import { renderJunit, renderTable, summarize } from './evalReport';

const passing: EvalResult = {
  name: 'refund flow',
  case: 'Refund order 42',
  tags: ['smoke'],
  passed: true,
  assertions: [
    { name: 'completed()', kind: 'gate', passed: true, score: 1, threshold: 1 },
    { name: 'tone', kind: 'soft', passed: true, score: 0.85, threshold: 0.7 },
  ],
  durationMs: 12,
  steps: 2,
  toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }],
};

const softFail: EvalResult = {
  ...passing,
  case: 'polite',
  assertions: [
    { name: 'brevity', kind: 'soft', passed: false, score: 0.5, threshold: 0.9, message: "soft check 'brevity' failed: score 0.5 is below the threshold 0.9" },
  ],
  durationMs: 1500,
};

const gateFail: EvalResult = {
  name: 'broken <flow> & "co"',
  tags: [],
  passed: false,
  assertions: [
    {
      name: "calledTool('lookup_order')",
      kind: 'gate',
      passed: false,
      score: 0,
      threshold: 1,
      message: "calledTool('lookup_order') failed: tools called were [search_docs, issue_refund]",
    },
  ],
  durationMs: 7,
  steps: 1,
  toolCalls: [],
};

describe('aggregation', () => {

  it('counts soft failures on cases that also failed a gate', () => {
    const gateAndSoft: EvalResult = { ...gateFail, assertions: [...gateFail.assertions, ...softFail.assertions] };
    expect(summarize([gateAndSoft], false)).toMatchObject({ failed: 1, softFailed: 1 });
    expect(renderTable([gateAndSoft], false)).toContain('1 eval(s): 0 passed, 1 failed, 1 with soft failures');
    const xml = renderJunit([gateAndSoft], false);
    expect(xml).toContain('<failure');
    expect(xml).toContain('<system-out>soft failure: soft check');
  });
});
