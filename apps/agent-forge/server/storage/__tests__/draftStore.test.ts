import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRepo } from '../agentRepo';
import { DraftStore, DraftMismatchError, type NewDraftInput } from '../draftStore';

const INPUT: NewDraftInput = {
  patch: { description: 'Triage faster.' },
  origin: 'author',
  reason: 'Tighten the description.',
  baseVersion: 3,
  baseSpecHash: 'sha256:abc',
};

let NOW = new Date('2026-02-03T04:05:06.000Z');
const FIXED = () => NOW;

describe('DraftStore', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let store: DraftStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d04-drafts-'));
    repo = new AgentRepo(baseDir);
    NOW = new Date('2026-02-03T04:05:06.000Z');
    store = new DraftStore(repo, FIXED);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const draftsDir = (id: string) => path.join(repo.sidecarDir(id), 'drafts');

  it('settle with a matching draftId settles; a wrong draftId throws DraftMismatchError and changes nothing', async () => {
    const { draft } = await store.create('ops', INPUT);

    await expect(store.settle('ops', 'rejected', { draftId: 'not-the-id' })).rejects.toBeInstanceOf(
      DraftMismatchError
    );
    await expect(store.settle('ops', 'rejected', { draftId: 'not-the-id' })).rejects.toMatchObject({
      code: 'LOUSHO_DRAFT_STALE',
    });

    // Nothing moved: current.json still holds the pending draft, history is empty.
    expect(await store.current('ops')).toEqual(draft);
    expect(fs.existsSync(path.join(draftsDir('ops'), 'history'))).toBe(false);
    expect(await store.history('ops')).toEqual([]);

    const settled = await store.settle('ops', 'rejected', { draftId: draft.id });
    expect(settled.status).toBe('rejected');
    expect(await store.current('ops')).toBeUndefined();
  });

  it('history is newest respondedAt first, mixing settles and auto-withdrawals', async () => {
    NOW = new Date('2026-02-03T04:01:00.000Z');
    const a = (await store.create('ops', { ...INPUT, reason: 'a' })).draft;
    NOW = new Date('2026-02-03T04:02:00.000Z');
    const b = (await store.create('ops', { ...INPUT, reason: 'b' })).draft; // withdraws a at 04:02
    NOW = new Date('2026-02-03T04:03:00.000Z');
    const c = (await store.create('ops', { ...INPUT, reason: 'c' })).draft; // withdraws b at 04:03
    NOW = new Date('2026-02-03T04:04:00.000Z');
    await store.settle('ops', 'approved'); // settles c at 04:04

    const history = await store.history('ops');
    expect(history.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
    expect(history.map((d) => d.status)).toEqual(['approved', 'withdrawn', 'withdrawn']);
    expect(history.map((d) => d.respondedAt)).toEqual([
      '2026-02-03T04:04:00.000Z',
      '2026-02-03T04:03:00.000Z',
      '2026-02-03T04:02:00.000Z',
    ]);
  });

  it('unparsable history files are skipped with a warning', async () => {
    await store.create('ops', INPUT);
    const settled = await store.settle('ops', 'approved');
    fs.mkdirSync(path.join(draftsDir('ops'), 'history'), { recursive: true });
    fs.writeFileSync(path.join(draftsDir('ops'), 'history', 'broken.json'), '{not json');
    fs.writeFileSync(path.join(draftsDir('ops'), 'history', 'note.txt'), 'ignored - not .json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await store.history('ops')).toEqual([settled]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
