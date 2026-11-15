import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mockModel, type MockTurn } from '../testing';
import { cachedProbe, emptyLedger, improveAgent, probeCacheKey, pruneCache, type Harness, type ImproveOptions, type ProbeRun } from './index';

const BASE: Harness = { instructions: 'You answer questions.', skills: {} };
const FIX = 'You answer questions. If a document is forbidden, say so and stop.';
const write = (content: string): MockTurn => ({ toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content } }] });
const run = (passed: boolean | null): ProbeRun => ({ passed, transcript: `assistant: ${passed}`, tokens: 10, ended: 'stop' });
const probe: ImproveOptions['probe'] = async (harness) => run(harness.instructions.includes('forbidden'));

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lousho-cache-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const editorTurns = (): MockTurn[] => ['<notes>KEEP_BASE.</notes>', write(FIX), '<notes>Fixed.</notes>', write(FIX), '<notes>Composed.</notes>'];
const routed = (model = 'mock-model') => {
  const queues: Record<string, MockTurn[]> = { invariant: editorTurns().slice(0, 1), domain: editorTurns().slice(1, 3), compose: editorTurns().slice(3) };
  const next: MockTurn = (request) => {
    const system = String(request.messages.find((message) => message.role === 'system')?.content ?? '');
    const stage = system.includes('You are the composer.') ? 'compose' : system.includes('earliest point of divergence') ? 'invariant' : 'domain';
    const turn = queues[stage].shift();
    if (turn === undefined || typeof turn === 'function') throw new Error(`No turn left for ${stage}.`);
    return turn;
  };
  return mockModel(Array.from({ length: 5 }, () => next), { defaultModel: model });
};

describe('editor-session cache', () => {

  it('different model, different key', async () => {
    const cacheDir = tempDir();
    await improveAgent({ harness: BASE, cases: ['c'], probe, editor: { provider: routed('model-a') }, repeats: 2, cacheDir });
    const other = routed('model-b');
    await improveAgent({ harness: BASE, cases: ['c'], probe, editor: { provider: other }, repeats: 2, cacheDir });
    expect(other.calls.length).toBeGreaterThan(0);
    const harness = { ...BASE };
    expect(probeCacheKey({ model: 'a', salt: '', caseId: 'c', repeat: 0, harness })).not.toBe(probeCacheKey({ model: 'b', salt: '', caseId: 'c', repeat: 0, harness }));
  });
});

describe('ledger', () => {
  it('ledger counts add up', async () => {
    const dir = tempDir();
    let n = 0;
    const flaky: ImproveOptions['probe'] = async (harness) => run(n++ === 0 ? null : harness.instructions.includes('forbidden'));
    const options = (ledger = emptyLedger()) => ({ harness: BASE, cases: ['c'], holdout: ['h'], probe: cachedProbe(flaky, { dir, model: 'm', ledger }), editor: { provider: routed() }, repeats: 2 });
    const result = await improveAgent(options());
    const ledger = result.ledger!;
    expect(ledger.planned).toBe(ledger.run + ledger.cached);
    expect(ledger.excluded).toBe(1);
    const again = await improveAgent(options());
    expect(again.ledger!.cached).toBeGreaterThan(ledger.cached);
    expect(again.ledger!.planned).toBe(again.ledger!.run + again.ledger!.cached);
    expect(again.ledger!.planned).toBe(ledger.planned);
  });
});

describe('pruneCache', () => {
  const key = (name: string) => name.repeat(64).slice(0, 64);
  const entry = (dir: string, name: string, bytes: number, ageMs: number, now: number, file = path.join(dir, `${key(name)}.json`)) => {
    writeFileSync(file, 'x'.repeat(bytes));
    const time = (now - ageMs) / 1000;
    utimesSync(file, time, time);
  };

  it('eviction by size', () => {
    const dir = tempDir();
    const now = Date.now();
    entry(dir, 'a', 100, 3_000, now);
    entry(dir, 'b', 100, 2_000, now);
    entry(dir, 'c', 100, 1_000, now);
    pruneCache(dir, { maxBytes: 250, now });
    expect(readdirSync(dir).sort()).toEqual([`${key('b')}.json`, `${key('c')}.json`]);
  });
});
