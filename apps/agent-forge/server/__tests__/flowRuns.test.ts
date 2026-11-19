import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpecV2 } from 'lousho';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import type { LogEntry } from '../../shared/wireTypes';

function flowSpec(tools: unknown[], steps: unknown[]): AgentSpecV2 {
  return {
    version: 2,
    name: 'flowy',
    model: 'mock/mock-1',
    instructions: 'Run the flow.',
    tools,
    flow: { code: 'flowy', name: 'Flowy', flow: { type: 'sequence', steps } },
  } as unknown as AgentSpecV2;
}

function manager(baseDir: string, spec: AgentSpecV2): { rm: RunManager; logs: LogEntry[] } {
  const rm = new RunManager({
    baseDir,
    checkpointStore: new FileCheckpointStore(baseDir),
    approvalStore: new FileApprovalStore(baseDir),
    host: newTestHost(baseDir),
    loadSpec: async () => spec,
    saveSpec: async () => {},
  });
  const logs: LogEntry[] = [];
  rm.on('log', (_agentId: string, entry: LogEntry) => logs.push(entry));
  return { rm, logs };
}

async function settled(rm: RunManager, agentId: string): Promise<void> {
  const start = Date.now();
  while (rm.status(agentId).status === 'running' || rm.status(agentId).status === 'idle') {
    if (Date.now() - start > 5000) throw new Error('run never settled');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('flow runs through RunManager.run', () => {
  let baseDir: string;
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const dir = () => (baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-flow-'))));

  it('resolves a builtin tool named by its legacy alias in a toolCall step', async () => {
    const spec = flowSpec(
      [{ builtin: 'current_date' }],
      [
        { type: 'toolCall', tool: 'current-date', outputVariable: 'today' },
        { type: 'return', value: '$today' },
      ]
    );
    const { rm } = manager(dir(), spec);
    await rm.run('flowy', 'go', spec);
    await settled(rm, 'flowy');
    const status = rm.status('flowy');
    expect(status.status).toBe('done');
    expect(status.resultText).toMatch(/\d{4}/);
  });

  it('refuses a toolCall step whose tool needs approval instead of running it', async () => {
    const spec = flowSpec([{ registry: 'demo-approval' }], [{ type: 'toolCall', tool: 'demo-approval' }]);
    const { rm } = manager(dir(), spec);
    await rm.run('flowy', 'go', spec);
    await settled(rm, 'flowy');
    const status = rm.status('flowy');
    expect(status.status).toBe('error');
    expect(status.error).toMatch(/demo-approval/);
    expect(status.error).toMatch(/approval/);
    expect(status.pendingApproval).toBeUndefined();
  });

  it('logs that flow agents get no connected accounts', async () => {
    const spec = flowSpec([], [{ type: 'return', value: 'ok' }]);
    const { rm, logs } = manager(dir(), spec);
    await rm.run('flowy', 'go', spec);
    await settled(rm, 'flowy');
    expect(logs.some((entry) => entry.message.includes('Flow agents do not get connected accounts yet.'))).toBe(true);
  });
});
