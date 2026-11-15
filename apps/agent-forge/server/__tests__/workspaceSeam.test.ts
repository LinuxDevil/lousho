import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';

/**
 * The workspace seam: every per-agent route reads its stores from
 * `workspaceOf(req)` (x-lousho-workspace header / ?ws=, else the launch
 * folder's single workspace). Studio still serves exactly one workspace,
 * so nothing user-visible changes - these tests pin the seam, the
 * `GET /workspace` ref and the 400/404 id validation.
 */
describe('workspace seam', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w00-seam-')));
    agentStore = createFsAgentStore(baseDir);
    const repo = new AgentRepo(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('rejects an unknown workspace id 404 and a malformed one 400', async () => {
    const app = createApp({ agentStore, runManager, baseDir });
    const unknown = await request(app).get('/agents').set('x-lousho-workspace', 'other-abc123');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "No workspace 'other-abc123'", code: 'LOUSHO_WORKSPACE_NOT_FOUND' });
    const invalid = await request(app).get('/agents').set('x-lousho-workspace', '../x');
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'Invalid workspace id', code: 'LOUSHO_WORKSPACE_ID_INVALID' });
  });
});
