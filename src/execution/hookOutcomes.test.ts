/**
 * Hook outcomes - a preToolCall hook may deny a call, supply its
 * result or modify its input; a postToolCall hook may replace the result.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockModel, type MockTurn } from '../testing';
import type { AgentEvent } from './agentEvents';
import type { AgentHook } from './hooks';
import type { PermissionDecisionEntry } from './permissions';

/** A `search` tool recording the queries it ran with. */
function searchTool(needsApproval?: (args: { query: string; limit: number }) => 'ask' | 'approve' | { deny: string }) {
  const ran: Array<{ query: string; limit: number }> = [];
  const defined = defineTool({
    name: 'search',
    description: 'Search',
    input: z.object({ query: z.string(), limit: z.number().max(10).default(5) }),
    ...(needsApproval && { needsApproval }),
    execute: async (args) => {
      ran.push(args);
      return `found ${args.query}`;
    },
  });
  return { defined, ran };
}

const call = (query: string, limit?: number): MockTurn => ({
  toolCalls: [{ name: 'search', args: limit === undefined ? { query } : { query, limit } }],
});

/** The tool results the model saw on its `n`-th call, parsed. */
function toolResults(model: MockModel, n = 1): unknown[] {
  return model.calls[n].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)) as unknown);
}

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('preToolCall outcomes', () => {
  it('{ deny } skips the call, gives the model a denied result, streams tool.error and audits it', async () => {
    const search = searchTool();
    const model = mockModel([call('secrets'), 'ok']);
    const audit: PermissionDecisionEntry[] = [];
    const later: string[] = [];
    const hooks: AgentHook[] = [
      { name: 'policy', preToolCall: (ctx) => (String(ctx.args.query).includes('secret') ? { deny: 'No secrets' } : undefined) },
      { name: 'later', preToolCall: (ctx) => void later.push(ctx.toolName) },
    ];
    const agent = createAgent({ provider: model, tools: [search.defined], hooks, onPermissionDecision: (e) => audit.push(e) });

    const events = await collect(agent.stream('go'));

    expect(search.ran).toEqual([]);
    expect(later).toEqual([]);
    expect(toolResults(model)[0]).toMatchObject({ error: 'ToolDeniedError', kind: 'denied', reason: 'No secrets' });
    expect(events.find((e) => e.type === 'tool.error')).toMatchObject({
      error: { name: 'ToolDeniedError', message: "Tool 'search' was denied by hook 'policy': No secrets" },
    });
    expect(audit).toEqual([expect.objectContaining({ toolName: 'search', decision: 'deny', hook: 'policy', reason: 'No secrets' })]);
    expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'ok' });
  });

  it('{ result } skips the call and becomes its result, marked as replaced by the hook', async () => {
    const search = searchTool();
    const model = mockModel([call('cached'), 'ok']);
    const cache: AgentHook = { name: 'cache', preToolCall: () => ({ result: { hits: ['from cache'] } }) };
    const agent = createAgent({ provider: model, tools: [search.defined], hooks: [cache] });

    const events = await collect(agent.stream('go'));

    expect(search.ran).toEqual([]);
    expect(toolResults(model)[0]).toEqual({ hits: ['from cache'] });
    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ result: { hits: ['from cache'] }, replacedByHook: 'cache' });
    expect(model.calls[1].messages.find((m) => m.role === 'tool')?.metadata).toEqual({ replacedByHook: 'cache' });
  });

  it('{ input } is validated again; a mismatch is an error naming the hook, and the tool does not run', async () => {
    const search = searchTool();
    const model = mockModel([call('cats'), 'ok']);
    const bad: AgentHook = { name: 'bad', preToolCall: (ctx) => ({ input: { ...ctx.args, limit: 50 } }) };
    await createAgent({ provider: model, tools: [search.defined], hooks: [bad] }).send('go');

    expect(search.ran).toEqual([]);
    const [result] = toolResults(model) as Array<{ kind: string; hook: string; message: string }>;
    expect(result).toMatchObject({ kind: 'validation', hook: 'bad' });
    expect(result.message).toMatch(/^Input from hook 'bad' for tool 'search' was refused: /);
  });
});

describe('order of evaluation', () => {
  it('permission rules and needsApproval see the hook-modified input; the approval record shows it', async () => {
    const asked: unknown[] = [];
    const search = searchTool((args) => (asked.push(args), 'ask'));
    const ruled: unknown[] = [];
    const cap: AgentHook = { name: 'cap', preToolCall: (ctx) => ({ input: { ...ctx.args, limit: 1 } }) };
    const agent = createAgent({
      provider: mockModel([call('cats', 9), 'done']),
      tools: [search.defined],
      hooks: [cap],
      permissions: [{ tool: 'search', when: (args) => (ruled.push(args), false), action: 'deny' }],
    });

    const paused = await agent.send('go');

    expect(ruled).toEqual([{ query: 'cats', limit: 1 }]);
    expect(asked).toEqual([{ query: 'cats', limit: 1 }]);
    expect((await agent.approvals.list())[0].args).toEqual({ query: 'cats', limit: 1 });
    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('done');
    expect(search.ran).toEqual([{ query: 'cats', limit: 1 }]);
  });

  it('on a resumed call, a hook may still supply the result', async () => {
    const search = searchTool(() => 'ask');
    let resumed = false;
    const cache: AgentHook = { name: 'cache', preToolCall: () => (resumed ? { result: 'cached' } : undefined) };
    const model = mockModel([call('cats'), 'done']);
    const agent = createAgent({ provider: model, tools: [search.defined], hooks: [cache] });

    const paused = await agent.send('go');
    resumed = true;
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(search.ran).toEqual([]);
    expect(toolResults(model)[0]).toBe('cached');
    expect(model.calls[1].messages.find((m) => m.role === 'tool')?.metadata).toMatchObject({ replacedByHook: 'cache' });
  });
});
