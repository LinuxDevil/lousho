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
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { VersionStore } from '../storage/versionStore';
import { createIdleVersioner } from '../storage/idleVersioner';
import type { VersionListItem } from '../../shared/wireTypes';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

const V1_SPEC_EDITED: AgentSpec = {
  ...V1_SPEC,
  prompt: 'Check the queues faster.',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The idle-version wiring: `PUT /agents/:id` (autosave) re-arms the
 * workspace's `IdleVersioner`, `POST /agents/:id/versions` and `DELETE`
 * cancel it, and `close()` flushes. `createApp`'s `idleVersioner` seam
 * injects one with `delayMs: 20` over a real VersionStore.
 */
describe('idle editor versions', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d16-idle-'));
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

  const app = () => createApp({ agentStore, runManager, baseDir, idleVersioner: createIdleVersioner(new VersionStore(repo), 50) });
  const put = (a: ReturnType<typeof app>, id: string, spec: AgentSpec) => request(a).put(`/agents/${id}`).send(spec);
  const listVersions = (a: ReturnType<typeof app>, id = 'ops') => request(a).get(`/agents/${id}/versions`);

  it('a second quiet window after more autosaves captures an update', async () => {
    const a = app();
    await put(a, 'ops', V1_SPEC).expect(204);
    await sleep(120);
    await put(a, 'ops', V1_SPEC_EDITED).expect(204);
    await sleep(120);

    const list = await listVersions(a);
    expect(list.body.map((item: VersionListItem) => item.version)).toEqual([2, 1]);
    expect(list.body[0]).toMatchObject({ version: 2, kind: 'update', source: 'editor' });
  });
});
