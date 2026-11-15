/**
 * ListTraces() and readTrace() over the fixture directory
 * (`__fixtures__/traces`: two traces on 2026-10-01 sharing the id prefix
 * `3f2`, one of them failed; one older trace with a sub-agent).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTraces, listTraces, readTrace } from './readTraces';

const dir = path.join(__dirname, '__fixtures__', 'traces');
const OK = '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f';
const FAILED = '3f2b7d00-1111-4222-8333-444455556666';

describe('listTraces', () => {

  it('skips a torn last line and summarizes a trace whose root never ended', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
    try {
      fs.mkdirSync(path.join(tmp, '2026-10-02'));
      const line = { v: 1, traceId: 'root', id: 'child', parentId: 'root', name: 'chat m', startTime: 100, endTime: 300, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 3 } };
      fs.writeFileSync(path.join(tmp, '2026-10-02', 'root.jsonl'), `${JSON.stringify(line)}\n{"v":1,"traceId":"ro`);

      const [summary] = await listTraces({ dir: tmp });
      expect(summary).toMatchObject({ traceId: 'root', name: 'chat m', durationMs: 200, modelCalls: 1, inputTokens: 3 });
      expect(summary.costUsd).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('readTrace', () => {

  it('rejects an ambiguous prefix and resolves [] for an unknown one', async () => {
    await expect(readTrace('3f2', { dir })).rejects.toThrow(/matches 2 traces/);
    expect(findTraces('3f2', { dir }).map((match) => match.traceId).sort()).toEqual([OK, FAILED]);
    expect(await readTrace('nope', { dir })).toEqual([]);
    expect(findTraces('', { dir })).toEqual([]);
  });
});
