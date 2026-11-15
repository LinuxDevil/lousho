import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { addToCorpus, readCorpus, type CorpusCase } from './corpus';

let dir: string;

const item = (traceId: string, origin: CorpusCase['origin'], addedAt: string): CorpusCase => ({
  id: `case-${traceId}`,
  traceId,
  input: `input for ${traceId}`,
  addedAt,
  revision: 'a'.repeat(64),
  origin,
  baseline: { passed: 6, scored: 6 },
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-corpus-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('corpus', () => {
  it('adds and dedupes by traceId', async () => {
    await addToCorpus(dir, [item('t1', 'protected', '2026-11-01T00:00:00Z'), item('t2', 'fixed', '2026-11-02T00:00:00Z')], 30);
    const after = await addToCorpus(dir, [{ ...item('t1', 'fixed', '2026-11-03T00:00:00Z'), input: 'changed' }, item('t3', 'fixed', '2026-11-03T00:00:00Z')], 30);
    expect(after.map((c) => c.traceId)).toEqual(['t1', 't2', 't3']);
    expect(after[0]).toMatchObject({ origin: 'protected', input: 'input for t1' });
  });

  it('is empty without a file and refuses a broken one', () => {
    expect(readCorpus(dir)).toEqual([]);
    mkdirSync(path.join(dir, '.lousho'));
    writeFileSync(path.join(dir, '.lousho', 'corpus.json'), '{"cases": [{"id": 1}]}');
    expect(() => readCorpus(dir)).toThrow(ConfigurationError);
    writeFileSync(path.join(dir, '.lousho', 'corpus.json'), '{');
    expect(() => readCorpus(dir)).toThrow(/not valid JSON/);
  });

  it('refuses a malformed case and a bad maxCases', async () => {
    await expect(addToCorpus(dir, [{ ...item('t1', 'fixed', 'x'), origin: 'other' as 'fixed' }], 30)).rejects.toThrow(ConfigurationError);
    await expect(addToCorpus(dir, [item('t1', 'fixed', 'x')], 0)).rejects.toThrow(/maxCases/);
  });

  it('refuses a symlinked corpus file or .lousho folder instead of replacing it', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'lousho-corpus-outside-'));
    writeFileSync(path.join(outside, 'corpus.json'), JSON.stringify({ cases: [item('kept', 'protected', '2026-11-01T00:00:00Z')] }));
    mkdirSync(path.join(dir, '.lousho'));
    symlinkSync(path.join(outside, 'corpus.json'), path.join(dir, '.lousho', 'corpus.json'));
    await expect(addToCorpus(dir, [item('t1', 'fixed', '2026-11-02T00:00:00Z')], 30)).rejects.toThrow(/not a regular file/);
    rmSync(path.join(dir, '.lousho'), { recursive: true });
    symlinkSync(outside, path.join(dir, '.lousho'));
    await expect(addToCorpus(dir, [item('t1', 'fixed', '2026-11-02T00:00:00Z')], 30)).rejects.toThrow(/symlink/);
    expect(() => readCorpus(dir)).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(path.join(outside, 'corpus.json'), 'utf8')).cases).toHaveLength(1);
    rmSync(outside, { recursive: true, force: true });
  });

  it('leaves a broken file untouched and no temp file behind', async () => {
    mkdirSync(path.join(dir, '.lousho'));
    writeFileSync(path.join(dir, '.lousho', 'corpus.json'), 'null');
    await expect(addToCorpus(dir, [item('t1', 'fixed', '2026-11-01T00:00:00Z')], 30)).rejects.toThrow(/list of corpus cases/);
    expect(readFileSync(path.join(dir, '.lousho', 'corpus.json'), 'utf8')).toBe('null');
    expect(readdirSync(path.join(dir, '.lousho')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

