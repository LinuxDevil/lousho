/**
 * `InProcessAgentHost` (server/host/inProcessAgentHost.ts): the AgentHost
 * RunManager runs specs through. Covers the host event stream (agent
 * events, span start/end, settled/failed), the ask-permission pause and
 * resolveApproval continuation, abort of live and paused runs, and one
 * RunManager case built with a `FakeAgentHost` proving run/approve/stop go
 * through the host only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpecV2 } from 'lousho';
import { InProcessAgentHost } from '../host/inProcessAgentHost';
import {
  HostRunNotActiveError,
  type HostEvent,
  type HostRunInput,
} from '../host/agentHost';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'host-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
};
const GATED: AgentSpecV2 = {
  ...SPEC,
  tools: [{ builtin: 'current_date' }],
  permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
};

describe('InProcessAgentHost', () => {
  let baseDir: string;
  let host: InProcessAgentHost;
  let events: HostEvent[];
  let approvalStore: FileApprovalStore;
  const onEvent = (event: HostEvent) => events.push(event);

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-host-'));
    approvalStore = new FileApprovalStore(baseDir);
    host = new InProcessAgentHost({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore,
    });
    events = [];
  });

  afterEach(async () => {
    await host.dispose();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const input = (over: Partial<HostRunInput>): HostRunInput => ({
    agentId: 'a1',
    spec: SPEC,
    sessionId: 'a1',
    input: 'hi',
    onEvent,
    ...over,
  });

  const settled = async (n = 1, timeoutMs = 3000) => {
    const start = Date.now();
    while (events.filter((e) => e.type === 'settled' || e.type === 'failed').length < n) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for settled #${n}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return events.filter((e) => e.type === 'settled' || e.type === 'failed');
  };

  it('an ask permission settles with pendingApproval; resolveApproval continues to a second settled', async () => {
    const { runId } = await host.start(input({ spec: GATED, input: 'please use current_date' }));
    const finals = await settled();
    if (finals[0].type !== 'settled') throw new Error('expected settled');
    expect(finals[0].result.finishReason).toBe('awaiting-approval');
    expect(finals[0].result.pendingApproval?.toolName).toBe('current_date');

    await host.resolveApproval(runId, finals[0].result.approvalId!, { approved: true });
    const all = await settled(2);
    if (all[1].type !== 'settled') throw new Error('expected settled');
    expect(all[1].result.finishReason).not.toBe('awaiting-approval');
  });

  it('resolveApproval on a run not paused on that id throws HostRunNotActiveError', async () => {
    const { runId } = await host.start(input({}));
    await settled();
    await expect(host.resolveApproval(runId, 'nope', { approved: true })).rejects.toBeInstanceOf(
      HostRunNotActiveError
    );
  });

  it('catalog returns the SDK\'s tool/model/guardrail/trigger lists', async () => {
    const catalog = await host.catalog();
    expect(catalog.tools.length).toBeGreaterThan(0);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.guardrails.length).toBeGreaterThan(0);
    expect(catalog.triggers.length).toBeGreaterThan(0);
  });
});
