/**
 * R2: `fileStore(dir)`, an AgentStore of JSON files. Runs the shared store
 * contracts, then the file-specific behavior: layout, atomic claims of
 * approvals, id validation, a corrupt history file, and two agents on one dir.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fileStore } from './fileStore';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers/llm';
import {
  describeApprovalStoreContract,
  describeCheckpointStoreContract,
  describeSessionStoreContract,
  makeCheckpoint,
  makePending,
  makeSnapshot,
} from './sqlite/__fixtures__/storeContracts';

// Real files: slow on a loaded Windows machine (antivirus scans every temp file).
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-filestore-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describeSessionStoreContract('fileStore().sessions', () => fileStore(tempDir()).sessions);
describeCheckpointStoreContract('fileStore().checkpoints', () => fileStore(tempDir()).checkpoints);
describeApprovalStoreContract('fileStore().approvals', () => fileStore(tempDir()).approvals);

const save = (store: ReturnType<typeof fileStore>, sessionId: string, stepIndex: number) =>
  store.checkpoints.save(sessionId, makeCheckpoint({ sessionId, stepIndex }));

describe('fileStore(dir) (R2)', () => {

  it('two concurrent resolves of one approval (two store instances on one dir) give exactly one record', async () => {
    const dir = tempDir();
    for (let round = 0; round < 10; round++) {
      const id = `appr_race_${round}`;
      const pending = makePending(id);
      await fileStore(dir).approvals.save(pending, makeSnapshot(pending));
      const results = await Promise.all([fileStore(dir).approvals.resolve(id), fileStore(dir).approvals.resolve(id)]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    }
    expect(readdirSync(join(dir, 'approvals'))).toEqual([]);
  });

  it('a claim a crashed resolver left long ago is taken over, so the approval is not stuck forever', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    const pending = makePending('appr_old');
    await store.approvals.save(pending, makeSnapshot(pending));
    const claim = join(dir, 'approvals', 'appr_old.json.claim');
    writeFileSync(claim, '1234');
    const old = new Date(Date.now() - 120_000);
    utimesSync(claim, old, old);
    const [first, second] = await Promise.all([store.approvals.resolve('appr_old'), fileStore(dir).approvals.resolve('appr_old')]);
    expect([first, second].filter(Boolean).map((record) => record?.pending.id)).toEqual(['appr_old']);
    expect(await store.approvals.resolve('appr_old')).toBeNull();
  });

  it('a corrupt checkpoint fails load() with LOUSHO_CHECKPOINT_CORRUPT and is listed as an in-progress run with that error', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await save(store, 'run-1', 1);
    writeFileSync(join(dir, 'checkpoints', 'run-1.json'), '{"agentId": "a", "mess');
    writeFileSync(join(dir, 'checkpoints', 'run-2.json'), '[]');
    await expect(store.checkpoints.load('run-1')).rejects.toMatchObject({ code: 'LOUSHO_CHECKPOINT_CORRUPT' });
    await expect(store.checkpoints.load('run-2')).rejects.toMatchObject({ code: 'LOUSHO_CHECKPOINT_CORRUPT' });
    const listed = await store.checkpoints.list!({ status: 'in-progress' });
    expect(listed.map((entry) => [entry.sessionId, entry.checkpoint.lastError?.code, entry.checkpoint.lastError?.retryable])).toEqual([
      ['run-1', 'LOUSHO_CHECKPOINT_CORRUPT', false],
      ['run-2', 'LOUSHO_CHECKPOINT_CORRUPT', false],
    ]);
    await store.checkpoints.delete('run-1');
    expect(await store.checkpoints.load('run-1')).toBeNull();
  });

  it('a run lease held by a process that is gone from this host is taken over at once', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    expect(await store.checkpoints.acquireLease!('run-1', '999999999:dead-run', 60_000)).toBe(true);
    expect(await fileStore(dir).checkpoints.acquireLease!('run-1', 'claim:other', 60_000)).toBe(true);
    expect(await fileStore(dir).checkpoints.acquireLease!('run-1', 'claim:third', 60_000)).toBe(false);
  });

  it('rejects session, checkpoint and approval ids that would escape the directory', async () => {
    const store = fileStore(tempDir());
    await expect(store.sessions.save('../evil', [])).rejects.toThrow(/Invalid session id/);
    await expect(store.sessions.load('a/../../b')).rejects.toThrow(/Invalid session id/);
    await expect(save(store, '../evil', 1)).rejects.toThrow(/Invalid session id/);
    await expect(store.checkpoints.load('..')).rejects.toThrow(/Invalid session id/);
    await expect(store.approvals.resolve('../evil')).rejects.toThrow(/Invalid approval id/);
    const pending = makePending('../evil');
    await expect(store.approvals.save(pending, makeSnapshot(pending))).rejects.toThrow(/Invalid approval id/);
  });

  it('approvals.load reads a malformed id as not found (only writes reject it)', async () => {
    const store = fileStore(tempDir());
    for (const id of ['bogus id!', '../evil', '', undefined as unknown as string]) {
      expect(await store.approvals.load!(id)).toBeNull();
    }
  });
});

describe('fileStore(dir): case-safe file names', () => {
  const hi: Message[] = [{ role: 'user', content: 'hi' }];

  it('reads a transcript, checkpoint and approval saved under the legacy mixed-case name, and moves it on the next save', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    // Write files the way the store named them before the fix, then remove the case-safe copies.
    await store.sessions.save('Alice', hi);
    await save(store, 'Alice', 1);
    const pending = makePending('Appr_1');
    await store.approvals.save(pending, makeSnapshot(pending));
    for (const [sub, from, to] of [
      ['sessions', '^alice', 'Alice'],
      ['checkpoints', '^alice', 'Alice'],
      ['checkpoint-history', '^alice', 'Alice'],
      ['approvals', '^appr_1', 'Appr_1'],
    ]) {
      renameSync(join(dir, sub, `${from}.json`), join(dir, sub, `${to}.json`));
    }

    expect(await store.sessions.load('Alice')).toEqual(hi);
    expect((await store.checkpoints.load('Alice'))?.stepIndex).toBe(1);
    expect(await store.approvals.load!('Appr_1')).not.toBeNull();

    await store.sessions.save('Alice', [...hi, { role: 'assistant', content: 'hello' }]);
    await save(store, 'Alice', 2);
    expect(readdirSync(join(dir, 'sessions'))).toEqual(['^alice.json']);
    expect(readdirSync(join(dir, 'checkpoints'))).toEqual(['^alice.json']);
    expect(readdirSync(join(dir, 'checkpoint-history'))).toEqual(['^alice.json']);
    expect((await store.checkpoints.history!('Alice')).map((entry) => entry.step)).toEqual([2, 1]);

    expect((await store.approvals.resolve('Appr_1'))?.pending).toEqual(pending);
    expect(readdirSync(join(dir, 'approvals'))).toEqual([]);
  });
});

describe('fileStore(dir).prune()', () => {
  /** Backdates every file under `dir` whose name starts with one of `prefixes` by an hour. */
  const age = (dir: string, prefixes: string[]) => {
    const old = new Date(Date.now() - 60 * 60_000);
    for (const sub of ['sessions', 'checkpoints', 'checkpoint-history']) {
      for (const name of readdirSync(join(dir, sub))) if (prefixes.some((prefix) => name.startsWith(prefix))) utimesSync(join(dir, sub, name), old, old);
    }
  };

  it('deletes old transcripts, checkpoints and history files, but keeps recent ones and a run paused on a pending approval', async () => {
    const dir = tempDir();
    const tools = [defineTool({ name: 'deploy', description: 'deploy', input: z.object({}), needsApproval: true, execute: async () => 'deployed' })];
    const model = mockModel([(request) => (request.messages.at(-1)?.content === 'deploy' ? { toolCalls: [{ name: 'deploy', id: 'call_1' }] } : 'ok')], { onExhausted: 'repeat-last' });
    const store = fileStore(dir);
    const agent = createAgent({ provider: model, tools, store });
    await agent.session({ id: 'old' }).send('hi');
    await agent.session({ id: 'recent' }).send('hi');
    const paused = await agent.session({ id: 'waiting' }).send('deploy');
    expect(paused.finishReason).toBe('awaiting-approval');
    await agent.send('hi', { sessionId: 'old-run' });
    age(dir, ['old', 'waiting']);

    await expect(store.prune({ olderThanMs: -1 })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    // 'old' also leaves a turn-counter checkpoint and its history entry, pruned with it.
    expect(await store.prune({ olderThanMs: 60_000 })).toEqual({ sessions: 1, checkpoints: 2, checkpointHistory: 3, oauthPending: 0 });
    expect(readdirSync(join(dir, 'sessions'))).toEqual(['recent.json']);
    expect(readdirSync(join(dir, 'checkpoints')).filter((name) => name.startsWith('waiting')).sort()).toEqual(['waiting.paused.json', 'waiting.turn-0.json']);
    expect(readdirSync(join(dir, 'checkpoint-history')).some((name) => name.startsWith('old'))).toBe(false);
    expect(await store.checkpoints.load('old-run')).toBeNull();
    // The paused turn is intact and still resolves.
    const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(done.text).toBe('ok');
    // Once decided, the old paused-turn pointer is stale and goes.
    expect(await store.prune({ olderThanMs: 60_000 })).toEqual({ sessions: 0, checkpoints: 1, checkpointHistory: 1, oauthPending: 0 });
    expect(readdirSync(join(dir, 'sessions')).sort()).toEqual(['recent.json', 'waiting.json']);
  });
});
