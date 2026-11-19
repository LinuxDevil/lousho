import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { listAllRuns } from '../runsList';
import type { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { ChatSessionRecord, RunListRow } from '../../shared/wireTypes';

const SPEC: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' };

describe('chat transcript and runs list routes', () => {
  let baseDir: string;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-chat-routes-')));
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

  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const app = () => createApp({ agentStore: createFsAgentStore(baseDir), runManager, baseDir });

  async function settled(): Promise<void> {
    const start = Date.now();
    while (runManager.status('ops').status === 'running' || runManager.status('ops').status === 'idle') {
      if (Date.now() - start > 5000) throw new Error('run never settled');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('returns a chat with the setup the run started with, and 404s an unknown chat', async () => {
    await request(app()).put('/agents/ops').send({ spec: SPEC }).expect(204);
    await runManager.sendMessage('ops', 'hello', SPEC);
    await settled();

    const res = await request(app()).get('/agents/ops/chats/ops').expect(200);
    const record = res.body as ChatSessionRecord;
    expect(record.messages.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true);
    expect(record.setup).toMatchObject({ accounts: [], declared: [], mcpServers: [], skipped: [] });
    await request(app()).get('/agents/ops/chats/nope').expect(404);
  });

  it('lists a trigger run with the trigger that started it after it finished', async () => {
    await request(app()).put('/agents/ops').send({ spec: SPEC }).expect(204);
    await runManager.run('ops', 'go', SPEC, { source: 'trigger', triggerId: 'nightly' });
    await settled();

    const registry = { list: async () => [{ id: 'w', name: 'w', root: baseDir }] } as unknown as WorkspaceRegistry;
    const rows: RunListRow[] = await listAllRuns({ registry, warm: () => [] }, 10);
    expect(rows.find((r) => r.agentId === 'ops')).toMatchObject({ chatId: 'ops', live: false, source: 'trigger', triggerId: 'nightly' });
    expect(rows.find((r) => r.agentId === 'ops')?.lastMessage).toBeTruthy();
  });
});
