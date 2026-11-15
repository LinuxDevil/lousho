import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { upgradeSpec, type AgentSpec, type AgentSpecV2 } from 'lousho';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'test-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
  tools: [{ builtin: 'current_date' }],
};

function waitForStatus(
  runManager: RunManager,
  agentId: string,
  predicate: (status: { status: string }) => boolean,
  timeoutMs = 2000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runManager.off('status', onStatus);
      reject(new Error('Timed out waiting for status'));
    }, timeoutMs);
    function onStatus(payload: any) {
      if (payload.agentId !== agentId) return;
      if (predicate(payload)) {
        clearTimeout(timer);
        runManager.off('status', onStatus);
        resolve(payload);
      }
    }
    runManager.on('status', onStatus);
  });
}

describe('RunManager', () => {
  let baseDir: string;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-n-test-'));
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: async () => undefined,
      saveSpec: async () => {},
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('stop() then run() resumes from the last checkpoint instead of restarting', async () => {
    const checkpointStore = new FileCheckpointStore(baseDir);
    const agentId = 'agent-3';

    // Abort the run right after the first tool result is recorded (and its
    // checkpoint written), but before the loop's next provider.generate()
    // call - deterministic because this handler runs synchronously within
    // the same event-loop turn AgentExecutor's onAgentEvent listener fires in,
    // before the `continue` to the next step's generate() call is reached.
    let stopped = false;
    runManager.on('event', (id: string, event: any) => {
      if (id === agentId && event.type === 'tool.done' && !stopped) {
        stopped = true;
        runManager.stop(agentId);
      }
    });

    await runManager.run(agentId, 'please use current_date', SPEC);
    await waitForStatus(runManager, agentId, (s) => s.status === 'stopped');

    // The checkpoint from the aborted run must survive, still unfinished
    // (see abortableProvider.ts's doc comment).
    const checkpoint = await checkpointStore.load(agentId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.stepIndex).toBeGreaterThanOrEqual(1);

    // Running again picks the same checkpoint back up (AgentExecutor
    // rehydrates from it; the resumed run appends the new `input` after the resumed
    // turn) rather than starting a brand new conversation from scratch.
    await runManager.run(agentId, 'a follow-up appended on resume', SPEC);
    const resumed = await waitForStatus(runManager, agentId, (s) => s.status === 'done');
    expect(resumed.resultText).toBe('This is a mock response.');

    // And the checkpoint is kept, marked finished, once that resumed run
    // completes successfully (the next run continues the session).
    const afterResume = await checkpointStore.load(agentId);
    expect(afterResume?.status).toBe('finished');
    expect(afterResume?.messages.map((m) => m.content)).toContain('please use current_date');
    expect(afterResume?.messages.map((m) => m.content)).toContain('a follow-up appended on resume');
  });

  describe('branching graphs run through FlowExecutor', () => {
    // The equivalent of the old v1 canvas's router graph, as spec.policy.flow
    // directly (the v1 canvas -> graphToSpec pipeline is gone: C24 cut the
    // builder over to spec v2). The mock provider's fixed default response
    // text - see SPEC's runs above ('This is a mock response.') - makes the
    // conditioned branch deterministically true end-to-end through the real
    // server plumbing.
    function branchingSpec(): AgentSpec {
      return {
        name: 'branch-agent',
        prompt: 'classify this',
        provider: { type: 'mock', model: 'mock-1' },
        tools: ['current-date'],
        policy: {
          flow: {
            code: 'branch-agent',
            name: 'branch-agent',
            flow: {
              type: 'sequence',
              steps: [
                { type: 'llmCall', prompt: 'classify this', outputVariable: 'classify' },
                {
                  type: 'oneOf',
                  options: [
                    {
                      condition: "'{{classify}}' === 'This is a mock response.'",
                      step: { type: 'toolCall', tool: 'current-date', arguments: {} },
                    },
                    { step: { type: 'end', value: 'default branch' } },
                  ],
                },
              ],
            },
          },
        },
      } as unknown as AgentSpec;
    }

    it('runs a spec.policy.flow to completion via FlowExecutor, not AgentExecutor', async () => {
      const spec = branchingSpec();
      expect((spec.policy as { flow?: unknown })?.flow).toBeDefined();

      await runManager.run('branch-agent', 'unused for a flow run', upgradeSpec(spec));
      const final = await waitForStatus(runManager, 'branch-agent', (s) => s.status === 'done');

      // The router's conditioned branch matched (see the condition above),
      // so the tool step ran (current-date returns an ISO timestamp string)
      // and its result became the flow's final output - proving the
      // compiled-spec -> RunManager -> FlowExecutor wiring actually
      // executed the branch's tool step, not just returned the LLM text.
      expect(final.resultText).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('a spec with an ask permission rule pauses in Studio (was ignored before v2)', async () => {
    const gated: AgentSpecV2 = {
      ...SPEC,
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    await runManager.run('ask-agent', 'please use current_date', gated);
    const paused = await waitForStatus(runManager, 'ask-agent', (s) => s.status === 'paused');
    expect(paused.reason).toBe('awaiting_approval');
    expect(paused.pendingApproval?.toolName).toBe('current_date');
  });
});
