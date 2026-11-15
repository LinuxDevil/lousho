/**
 * Durable execution gaps:
 * - an approval in the middle of a tool batch keeps the transcript valid.
 * - resuming a session with new input (unfinished / finished / awaiting approval).
 * - a checkpoint after every model turn, so a crash never re-calls the model.
 *
 * Every checkpoint goes through the real KVCheckpointStore (JSON round-trip)
 * and every approval snapshot through a JSON round-trip, as a real store would.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, ExecuteOptions, ExecutionResult, PropagatingToolError } from './AgentExecutor';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import type { CheckpointStore } from './checkpoint';
import { resumeAfterApproval } from './resume';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, MockTurn } from '../testing';
import { AgentConfig } from '../types';
import type { Message } from '../providers';

type Runs = Record<string, number>;

interface ToolOptions {
  needsApproval?: boolean;
  /** Throw a non-recoverable error (a simulated process death) on the first run. */
  crashOnce?: boolean;
  input?: z.ZodObject<z.ZodRawShape>;
  seenIds?: string[];
}

function tool(name: string, runs: Runs, options: ToolOptions = {}): DefinedTool {
  runs[name] = 0;
  return defineTool({
    name,
    description: name,
    input: options.input ?? z.object({}),
    needsApproval: options.needsApproval,
    execute: async (_args, ctx) => {
      runs[name]++;
      options.seenIds?.push(ctx.toolCallId);
      if (options.crashOnce && runs[name] === 1) {
        throw new PropagatingToolError(`process died while running ${name}`);
      }
      return `${name} done`;
    },
  });
}

function agentFor(tools: DefinedTool[]): AgentConfig {
  const config: AgentConfig['tools'] = {};
  for (const t of tools) config[t.name] = { tool: t.name };
  return { id: 'agent-1', name: 'Agent', prompt: 'p', tools: config };
}

function registryOf(tools: DefinedTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(tools);
  return registry;
}

function turnCalling(...names: string[]): MockTurn {
  return { toolCalls: names.map((name) => ({ name, id: `call_${name}` })) };
}

function roles(messages: readonly Message[]): string[] {
  return messages.map((m) => m.role);
}

/** A KVCheckpointStore over a Map, optionally failing the n-th save (1-based). */
function checkpointStore(failSave?: number): KVCheckpointStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  let saves = 0;
  const store = new KVCheckpointStore({
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      // Run leases (`<id>#lease`) are not checkpoint saves.
      if (!key.endsWith('#lease')) saves++;
      if (saves === failSave && !key.endsWith('#lease')) throw new Error('disk gone');
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  }, undefined, undefined, { historyLimit: 0 }); // these tests count puts as saves
  return Object.assign(store, { data });
}

/** An ApprovalStore that JSON round-trips its records, like a real one. */
function approvalStore(): ApprovalStore & { snapshots: ExecutionSnapshot[]; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const snapshots: ExecutionSnapshot[] = [];
  return {
    raw,
    snapshots,
    async save(pending: PendingApproval, snapshot: ExecutionSnapshot) {
      snapshots.push(JSON.parse(JSON.stringify(snapshot)) as ExecutionSnapshot);
      raw.set(pending.id, JSON.stringify({ pending, snapshot }));
    },
    async resolve(id: string) {
      const record = raw.get(id);
      raw.delete(id);
      return record ? JSON.parse(record) : null;
    },
  };
}

interface Harness {
  tools: DefinedTool[];
  checkpoints?: CheckpointStore;
  approvals?: ApprovalStore;
}

function execute(h: Harness, script: MockTurn[], extra: Partial<ExecuteOptions> = {}) {
  const model = mockModel(script);
  const result = AgentExecutor.execute({
    agent: agentFor(h.tools),
    input: 'go',
    provider: model,
    toolRegistry: registryOf(h.tools),
    approvalStore: h.approvals,
    checkpointStore: h.checkpoints,
    sessionId: h.checkpoints ? 's1' : undefined,
    ...extra,
  });
  return { model, result };
}

async function resume(h: Harness, paused: ExecutionResult, script: MockTurn[], approved = true) {
  const model = mockModel(script);
  const result = await resumeAfterApproval(
    { id: paused.approvalId!, approved, note: approved ? undefined : 'not today' },
    h.approvals!,
    registryOf(h.tools),
    model,
    {},
    h.checkpoints
  );
  return { model, result };
}

describe('resume with new input', () => {

  it('new input queued behind pending calls survives another approval pause', async () => {
    const runs: Runs = {};
    const approvals = approvalStore();
    const h: Harness = {
      tools: [tool('a', runs, { crashOnce: true }), tool('b', runs, { needsApproval: true })],
      checkpoints: checkpointStore(),
      approvals,
    };
    await expect(execute(h, [turnCalling('a', 'b')], { toolConcurrency: 1 }).result).rejects.toThrow('process died');

    const paused = await execute(h, [], { input: 'queued question' }).result;
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.messages.some((m) => m.content === 'queued question')).toBe(false);
    expect(approvals.snapshots[0].currentMessages.at(-1)).toEqual({ role: 'user', content: 'queued question' });

    const { model } = await resume(h, paused, ['answered']);

    const sent = model.calls[0].messages as Message[];
    expect(roles(sent)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(sent.at(-1)?.content).toBe('queued question');
    expect(runs).toEqual({ a: 2, b: 1 });
  });
});
