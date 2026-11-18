import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpecV2 } from 'lousho';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'pauser',
  model: 'mock/mock-1',
  instructions: 'You are a test agent.',
  tools: [{ builtin: 'current_date', approval: 'always' }],
};

function manager(baseDir: string): RunManager {
  return new RunManager({
    baseDir,
    checkpointStore: new FileCheckpointStore(baseDir),
    approvalStore: new FileApprovalStore(baseDir),
    host: newTestHost(baseDir),
    loadSpec: async () => SPEC,
    saveSpec: async () => {},
  });
}

async function settled(rm: RunManager, agentId: string): Promise<ReturnType<RunManager['status']>> {
  const start = Date.now();
  while (rm.status(agentId).status === 'running' || rm.status(agentId).status === 'idle') {
    if (Date.now() - start > 5000) throw new Error('run never settled');
    await new Promise((r) => setTimeout(r, 10));
  }
  return rm.status(agentId);
}

describe('a pause left on disk by a Studio restart', () => {
  let baseDir: string;
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  it('comes back as a pending approval on the next message, and approving it continues the run', async () => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-orphan-')));
    const before = manager(baseDir);
    await before.sendMessage('pauser', 'please call current_date', SPEC);
    const paused = await settled(before, 'pauser');
    expect(paused.status).toBe('paused');
    const approvalId = (paused as { pendingApproval?: { approvalId: string } }).pendingApproval?.approvalId;
    expect(approvalId).toBeDefined();

    const after = manager(baseDir);
    await after.sendMessage('pauser', 'hello again', SPEC);
    const adopted = await settled(after, 'pauser');
    expect(adopted.status).toBe('paused');
    expect((adopted as { pendingApproval?: { approvalId: string; toolName: string } }).pendingApproval).toMatchObject({
      approvalId,
      toolName: 'current_date',
    });

    await after.approve('pauser', approvalId!, false);
    const resumed = await settled(after, 'pauser');
    expect(resumed.status).toBe('done');
  });
});
