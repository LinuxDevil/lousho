import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { AgentRepo } from '../agentRepo';
import { VersionStore, type CaptureInput } from '../versionStore';

const SPEC_A: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run the ops checks.' };
const SPEC_B: AgentSpecV2 = { ...SPEC_A, description: 'Second draft.' };
const UPDATE: CaptureInput = { kind: 'update', source: 'editor' };

const FIXED = new Date('2026-02-03T04:05:06.000Z');

describe('VersionStore', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let store: VersionStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d03-versions-'));
    repo = new AgentRepo(baseDir);
    store = new VersionStore(repo, () => FIXED);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const versionsDir = (id: string) => path.join(repo.sidecarDir(id), 'versions');

  it('ignores a truncated last index line and numbers the next capture after the last good line', async () => {
    await repo.writeSpec('ops', SPEC_A);
    await store.capture('ops', UPDATE);
    // A crash can leave a partial last line behind.
    fs.appendFileSync(path.join(versionsDir('ops'), 'index.jsonl'), '{"version":2,"kind":"upda');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await store.list('ops')).map((i) => i.version)).toEqual([1]);
    expect(warn).toHaveBeenCalledOnce();

    await repo.writeSpec('ops', SPEC_B);
    const item = await store.capture('ops', UPDATE);
    expect(item!.version).toBe(2);
    warn.mockRestore();
  });
});
