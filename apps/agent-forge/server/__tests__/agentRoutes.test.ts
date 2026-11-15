/**
 * Agent routes v2 - `GET /agents` (AgentListItem[]), `GET /agents/:id`
 * (AgentRecord), `PUT /agents/:id` (`{ spec }` v2 or a bare v1 spec) and
 * `DELETE /agents/:id`, with the temporary `?view=legacy` v1 bridge the
 * canvas still reads (routes/agentRoutes.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { AgentListItem } from '../../shared/wireTypes';

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  description: 'Watches the queues.',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
};

describe('agent routes v2', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d06a-agents-'));
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
    vi.restoreAllMocks();
  });

  const app = () => createApp({ agentStore, runManager, baseDir });

  const putV2 = (id: string, spec: unknown = V2_SPEC) =>
    request(app()).put(`/agents/${id}`).send({ spec });

  describe('GET /agents', () => {

    it('skips a spec file it cannot read instead of failing the list', async () => {
      await putV2('good');
      fs.mkdirSync(repo.agentsDir(), { recursive: true });
      fs.writeFileSync(path.join(repo.agentsDir(), 'broken.yaml'), 'name: [unclosed\n');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      expect((res.body as AgentListItem[]).map((item) => item.id)).toEqual(['good']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'broken'"));
    });

    it('?view=legacy keeps the LegacyAgentStoreEntry list shape', async () => {
      await putV2('ops');
      const res = await request(app()).get('/agents?view=legacy');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      const entry = res.body[0];
      expect(entry.id).toBe('ops');
      expect(entry.spec).toMatchObject({
        name: 'ops',
        prompt: 'Check the queues.',
        provider: { type: 'mock', model: 'mock-1' },
      });
      expect(entry.spec.version).toBeUndefined();
      expect(typeof entry.updatedAt).toBe('string');
    });
  });

  describe('lastRun', () => {

    it('falls back to the newest persisted trace', async () => {
      await putV2('ops');
      const dir = path.join(baseDir, '.lousho', 'agents', 'ops', 'traces', '2026-10-02');
      fs.mkdirSync(dir, { recursive: true });
      const root = {
        v: 1,
        traceId: 't1',
        id: 't1',
        name: 'invoke_agent ops',
        kind: 'internal',
        startTime: 1000,
        endTime: 1500,
        attributes: {},
        status: { code: 'ok' },
      };
      fs.writeFileSync(path.join(dir, 't1.jsonl'), `${JSON.stringify(root)}\n`);
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      expect((res.body as AgentListItem[])[0].lastRun).toEqual({
        status: 'done',
        at: new Date(1500).toISOString(),
        traceId: 't1',
      });
    });
  });

  describe('GET /agents/:id', () => {

    it('?view=legacy returns the v1 spec and 404s the same way', async () => {
      await putV2('ops');
      const res = await request(app()).get('/agents/ops?view=legacy');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'ops',
        prompt: 'Check the queues.',
        provider: { type: 'mock', model: 'mock-1' },
      });
      expect(res.body.version).toBeUndefined();

      const missing = await request(app()).get('/agents/nope?view=legacy');
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "No saved agent 'nope'", code: 'LOUSHO_AGENT_NOT_FOUND' });
    });
  });

  describe('PUT /agents/:id', () => {

    it('rejects an invalid spec with LOUSHO_SPEC_INVALID and issue details', async () => {
      const res = await putV2('ops', { version: 2, name: 'ops' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_SPEC_INVALID');
      expect(typeof res.body.details.issues[0].path).toBe('string');
      expect(res.body.details.issues[0].path.length).toBeGreaterThan(0);
    });

    it.each([[[2]],])('rejects a garbage body %j with LOUSHO_BODY_INVALID', async (body) => {
      const res = await request(app()).put('/agents/ops').send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    });
  });
});
