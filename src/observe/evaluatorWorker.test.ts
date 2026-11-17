import { expect, it } from 'vitest';
import { startEvaluatorWorker } from './evaluatorWorker';
import type { EvaluatorRuleRow } from './evaluators';
import { ingestBatch, openDb } from './store';

it("a code evaluator that throws reports the error's message, not just 'driver'", async () => {
  const db = openDb(':memory:');
  try {
    ingestBatch(db, [{ type: 'observation', data: { obs_id: 'o1', trace_id: 't1', kind: 'span', name: 'invoke_agent a', start: 1, end: 2 } }], 3);
    const worker = startEvaluatorWorker(db, {
      isolateAvailable: () => true,
      sandbox: () => ({
        run: async () => {
          throw new SyntaxError("Unexpected token 'export'");
        },
      }),
    } as never);
    const rule = { rule_id: 'r1', name: 'short', kind: 'code', config: { source: 'export default 1' } } as unknown as EvaluatorRuleRow;
    expect(await worker.runOnce(rule, 't1')).toEqual({ value: null, comment: "driver: Unexpected token 'export'" });
  } finally {
    db.close();
  }
});
