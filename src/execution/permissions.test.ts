/**
 * Declarative permission policies - ordered allow/deny/ask rules
 * checked before a tool's `needsApproval`, with an audit trail.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel } from '../testing';
import type { AgentConfig } from '../types';
import type { AgentEvent, AgentEventOf } from './agentEvents';
import { AgentExecutor } from './AgentExecutor';
import {
  allow,
  deny,
  type PermissionDecisionEntry,
} from './permissions';

/** A tool named `name` that records its calls; `needsApproval` as given. */
function tool(name: string, needsApproval = false) {
  const calls: unknown[] = [];
  const defined = defineTool({
    name,
    description: `The ${name} tool`,
    input: z.object({ value: z.string().optional() }),
    needsApproval,
    execute: async (args) => {
      calls.push(args);
      return `${name} ran`;
    },
  });
  return { defined, calls };
}

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const decisions = (events: AgentEvent[]): AgentEventOf<'permission.decision'>[] =>
  events.filter((e): e is AgentEventOf<'permission.decision'> => e.type === 'permission.decision');

describe('permission policies', () => {

  it('matches tools by name list and by pattern', async () => {
    const tools = ['read_a', 'read_b', 'danger_rm', 'other'].map((name) => tool(name, true));
    const audit: PermissionDecisionEntry[] = [];
    const agent = createAgent({
      provider: mockModel([{ toolCalls: tools.map((t) => ({ name: t.defined.name })) }, 'done']),
      tools: tools.map((t) => t.defined),
      permissions: [deny(/^danger_/), allow(['read_a', 'read_b'])],
      onPermissionDecision: (entry) => audit.push(entry),
    });

    const result = await agent.send('go');

    expect(audit.map((e) => [e.toolName, e.decision])).toEqual([
      ['read_a', 'allow'],
      ['read_b', 'allow'],
      ['danger_rm', 'deny'],
      ['other', 'default'],
    ]);
    // `other` matched no rule, so its own needsApproval pauses the run.
    expect(result.finishReason).toBe('awaiting-approval');
    expect(tools.map((t) => t.calls.length)).toEqual([1, 1, 0, 0]);
  });

  it('writes an audit entry per call, with the args unless redactContent is set', async () => {
    const lookup = tool('lookup');
    const entries = async (redactContent: boolean | ((text: string) => string)) => {
      const audit: PermissionDecisionEntry[] = [];
      const toolRegistry = new ToolRegistry();
      toolRegistry.registerMany([lookup.defined]);
      const agent: AgentConfig = { id: 'a1', name: 'A', prompt: 'p', tools: { lookup: { tool: 'lookup' } } };
      await AgentExecutor.execute({
        agent,
        toolRegistry,
        input: 'go',
        provider: mockModel([{ toolCalls: [{ name: 'lookup', id: 'x1', args: { value: 'secret' } }] }, 'done']),
        onPermissionDecision: (entry) => audit.push(entry),
        redactContent,
      });
      return audit;
    };

    const [entry] = await entries(false);
    expect(entry).toEqual({ toolName: 'lookup', toolCallId: 'x1', decision: 'default', args: { value: 'secret' }, at: expect.any(String) });
    expect(new Date(entry.at).toISOString()).toBe(entry.at);
    expect(await entries(true)).toEqual([{ toolName: 'lookup', toolCallId: 'x1', decision: 'default', at: expect.any(String) }]);
    // A custom redactor counts as redaction on.
    expect((await entries((text) => text))[0]).not.toHaveProperty('args');
  });

  it("sub-agents inherit the parent's rules, ahead of their own", async () => {
    const lookup = tool('lookup');
    const fetchPage = tool('fetch_page');
    const researcher = createAgent({
      name: 'researcher',
      description: 'Researches',
      provider: mockModel([{ toolCalls: [{ name: 'lookup' }, { name: 'fetch_page' }] }, 'found nothing']),
      tools: [lookup.defined, fetchPage.defined],
      permissions: [allow('*')],
    });
    const audit: PermissionDecisionEntry[] = [];
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'look', description: 'look' } }] }, 'done']),
      subagents: { researcher },
      permissions: [deny('lookup', 'Not for sub-agents')],
      onPermissionDecision: (entry) => audit.push(entry),
    });

    const events = await collect(lead.stream('go'));

    expect(lookup.calls).toHaveLength(0);
    expect(fetchPage.calls).toHaveLength(1);
    expect(audit.map((e) => [e.toolName, e.decision])).toEqual([
      ['task', 'default'],
      ['lookup', 'deny'],
      ['fetch_page', 'allow'],
    ]);
    expect(decisions(events).filter((e) => e.subagent).map((e) => e.toolName)).toEqual(['lookup', 'fetch_page']);
  });
});

describe('rules naming an unknown tool', () => {

  it('createAgent warns at creation about a typo in a deny rule', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const writer = tool('write_file').defined;
      createAgent({ provider: mockModel(['hi']), tools: [writer], permissions: [deny('write_flie'), allow('*')] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'write_flie'"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Did you mean 'write_file'?"));
      warn.mockClear();
      createAgent({ provider: mockModel(['hi']), tools: [writer], permissions: [deny('write_file'), allow('*')] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
