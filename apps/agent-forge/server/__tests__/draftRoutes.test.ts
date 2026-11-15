import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { DraftStore } from '../storage/draftStore';
import type { ChangeDraft } from '../../shared/wireTypes';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

/**
 * The draft routes: `GET/POST/DELETE /agents/:id/draft` and
 * `POST /agents/:id/draft/approve` · `/reject` over the workspace seam's
 * stores. An approved draft applies its patch over the *current* spec
 * (not the base it was drafted against) and lands as one
 * `source: 'draft'` version.
 */
describe('draft routes', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d08a-drafts-'));
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    repo = new AgentRepo(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir });

  /** Saves the agent through the real v1 PUT route (the file on disk is v2). */
  const saveAgent = async (id = 'ops', spec: AgentSpec = V1_SPEC) => {
    const res = await request(app()).put(`/agents/${id}`).send(spec);
    expect(res.status).toBe(204);
  };

  const createDraft = (id = 'ops', body: object = { patch: { description: 'Triage faster.' }, origin: 'author', reason: 'Tighter.' }) =>
    request(app()).post(`/agents/${id}/draft`).send(body);
  const indexPath = (id: string) => path.join(repo.sidecarDir(id), 'versions', 'index.jsonl');
  const indexLines = (id: string): { source: string; kind: string; changedFields: string[] }[] =>
    fs.existsSync(indexPath(id))
      ? fs
          .readFileSync(indexPath(id), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line))
      : [];

  it('GET returns 204 when the agent has no pending draft, 404 when the agent is unknown', async () => {
    await saveAgent();
    expect((await request(app()).get('/agents/ops/draft')).status).toBe(204);
    const missing = await request(app()).get('/agents/ghost/draft');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_AGENT_NOT_FOUND');
  });

  it('POST validates the body: unknown keys, version and empty patches are 400 LOUSHO_BODY_INVALID', async () => {
    await saveAgent();
    for (const patch of [{ version: 3 }, { bogus: 1 }, {}, 'not-an-object']) {
      const res = await createDraft('ops', { patch, origin: 'author', reason: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    }
    for (const body of [
      { patch: { description: 'x' }, origin: 'robot', reason: 'x' },
      { patch: { description: 'x' }, origin: 'author' },
      { patch: { description: 'x' }, origin: 'author', reason: '   ' },
    ]) {
      const res = await createDraft('ops', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    }
  });

  it('POST a patch that breaks the schema is 400 LOUSHO_DRAFT_INVALID with issues', async () => {
    await saveAgent();
    const res = await createDraft('ops', { patch: { name: '' }, origin: 'author', reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_DRAFT_INVALID');
    expect(Array.isArray(res.body.details?.issues)).toBe(true);
  });

  it('POST a patch that changes nothing is 400 LOUSHO_DRAFT_EMPTY', async () => {
    await saveAgent();
    const res = await createDraft('ops', { patch: { promptRef: null }, origin: 'author', reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_DRAFT_EMPTY');
    expect(res.body.error).toBe('This draft matches the current agent.');
  });

  it('DELETE withdraws the pending draft; a second DELETE is 404', async () => {
    await saveAgent();
    const draft = (await createDraft()).body as ChangeDraft;

    const res = await request(app()).delete('/agents/ops/draft');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: draft.id, status: 'withdrawn', respondedAt: expect.any(String) });
    expect((await request(app()).get('/agents/ops/draft')).status).toBe(204);

    const again = await request(app()).delete('/agents/ops/draft');
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('LOUSHO_DRAFT_NOT_FOUND');
  });

  it('approve moves a labels patch into meta.json, not the spec', async () => {
    await saveAgent();
    const draft = (await createDraft('ops', { patch: { labels: ['ops', 'nightly'] }, origin: 'author', reason: 'x' }))
      .body as ChangeDraft;
    const res = await request(app()).post('/agents/ops/draft/approve').send({ draftId: draft.id });
    expect(res.status).toBe(200);

    const meta = await repo.readMeta('ops');
    expect(meta.labels).toEqual(['ops', 'nightly']);
    const spec = await repo.readSpec('ops');
    expect('labels' in (spec as object)).toBe(false);
    expect(indexLines('ops')[0].changedFields).toContain('labels');
  });

  it('approve with a replaced draftId is 409 LOUSHO_DRAFT_STALE and changes nothing', async () => {
    await saveAgent();
    const stale = (await createDraft()).body as ChangeDraft;
    await createDraft('ops', { patch: { name: 'renamed' }, origin: 'author', reason: 'x' });

    const res = await request(app()).post('/agents/ops/draft/approve').send({ draftId: stale.id });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'This draft was replaced. Reload to see the current one.',
      code: 'LOUSHO_DRAFT_STALE',
    });
    const spec = await repo.readSpec('ops');
    expect(spec?.name).toBe('ops');
    expect(indexLines('ops')).toEqual([]);
  });

  it('approve a patch that no longer validates over today\'s spec is 400 LOUSHO_DRAFT_INVALID', async () => {
    await saveAgent();
    // Seed a draft straight through the store, bypassing the create route's
    // validation - as if the spec had moved on since the draft was valid.
    const store = new DraftStore(repo);
    await store.create('ops', {
      patch: { name: null },
      origin: 'author',
      reason: 'Seeded stale draft.',
      baseVersion: null,
      baseSpecHash: 'sha256:x',
    });
    const res = await request(app()).post('/agents/ops/draft/approve').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_DRAFT_INVALID');
    // The draft stays pending: nothing was settled or written.
    expect((await request(app()).get('/agents/ops/draft')).status).toBe(200);
    expect(indexLines('ops')).toEqual([]);
  });

  it('reject is 404 without a draft and 409 for a replaced draftId', async () => {
    await saveAgent();
    const missing = await request(app()).post('/agents/ops/draft/reject').send({});
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_DRAFT_NOT_FOUND');

    const draft = (await createDraft()).body as ChangeDraft;
    const stale = await request(app()).post('/agents/ops/draft/reject').send({ draftId: 'wrong-id' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('LOUSHO_DRAFT_STALE');
    expect((await request(app()).get('/agents/ops/draft')).body.id).toBe(draft.id);
  });

  it('settle bodies are validated: a non-string draftId or oversized note is 400 LOUSHO_BODY_INVALID', async () => {
    await saveAgent();
    await createDraft();
    for (const body of [{ draftId: 42 }, { note: 'x'.repeat(2001) }, { note: 7 }]) {
      const res = await request(app()).post('/agents/ops/draft/approve').send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    }
  });
});
