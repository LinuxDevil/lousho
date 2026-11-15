/**
 * Hosted tool calls in the run loop, driven by `mockModel` hosted turns:
 * mockModel itself (generate and stream), events on both paths, the
 * transcript cap, usage (also rolled up from a sub-agent), the finish-reason
 * rule, traces, the fingerprint, and that sub-agents do not inherit the
 * lead's hosted tools.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { webSearch } from '../tools/hosted';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';
import { HOSTED_RESULT_LIMIT, cappedHostedResult } from './hostedToolCalls';
import { fingerprintOf } from './agentFingerprint';
import { AgentBuilder } from '../core/AgentBuilder';
import { emptyRunUsage, mergeDelegatedUsage, usageSince } from './runUsage';
import { withFallback, withRetry } from '../providers/resilience';

afterEach(() => {
  vi.restoreAllMocks();
});

function agentWith(turns: Parameters<typeof mockModel>[0]) {
  const execute = vi.fn(async () => 'ran');
  const lookup = defineTool({ name: 'lookup', description: 'Look up', input: z.object({}), execute });
  const events: AgentEvent[] = [];
  const model = mockModel(turns);
  const agent = createAgent({ provider: model, instructions: 'x', tools: [webSearch(), lookup], onEvent: (event) => events.push(event) });
  return { agent, events, execute, model };
}

describe('hosted calls in a run (mockModel)', () => {

  it('large results are capped at 20,000 characters of JSON in events and the transcript', async () => {
    const big = { text: 'x'.repeat(HOSTED_RESULT_LIMIT + 500) };
    const { agent, events } = agentWith([{ text: 'answer', hostedToolCalls: [{ name: 'web_search', id: 'ws_big', result: big }] }]);
    const result = await agent.send('go');
    const kept = (result.messages.at(-1)?.metadata?.hostedToolCalls as Array<{ result: unknown }>)[0]!.result;
    expect(typeof kept).toBe('string');
    expect(kept as string).toMatch(/\.\.\. \[truncated 51\d characters\]$/);
    expect((kept as string).length).toBeLessThan(HOSTED_RESULT_LIMIT + 50);
    expect(events.find((event) => event.type === 'tool.done')).toMatchObject({ result: kept });
    expect(cappedHostedResult({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('hosted calls in usage', () => {
  it('a delegated child adds its counts; usageSince subtracts them', () => {
    const lead = emptyRunUsage();
    lead.hostedToolCalls = { web_search: 1 };
    const child = emptyRunUsage();
    child.hostedToolCalls = { web_search: 2, code_interpreter: 1 };
    mergeDelegatedUsage(lead, child);
    expect(lead.hostedToolCalls).toEqual({ web_search: 3, code_interpreter: 1 });
    expect(usageSince(lead, { ...emptyRunUsage(), hostedToolCalls: { web_search: 3 } }).hostedToolCalls).toEqual({ code_interpreter: 1 });
  });
});

describe('sub-agents and resume', () => {

  it('the fingerprint changes with the hosted tools, under their names', async () => {
    const agent = AgentBuilder.create().setName('a').setPrompt('x').build();
    const provider = mockModel([]);
    const none = await fingerprintOf(agent, undefined, provider);
    const withSearch = await fingerprintOf(agent, undefined, provider, [webSearch()]);
    const lowSearch = await fingerprintOf(agent, undefined, provider, [webSearch({ searchContextSize: 'low' })]);
    expect(Object.keys(withSearch.tools)).toEqual(['web_search']);
    expect(withSearch.hash).not.toBe(none.hash);
    expect(lowSearch.tools.web_search).not.toBe(withSearch.tools.web_search);
    expect((await fingerprintOf(agent, undefined, provider, [])).hash).toBe(none.hash);
  });
});

describe('wrappers, cassettes and the UI stream', () => {
  const bare = { name: 'bare', generate: vi.fn(), stream: vi.fn(), supportsTools: () => true, supportsStreaming: () => true, getModels: async () => [] };

  it('withRetry() and withFallback() ask the (first) wrapped provider', () => {
    expect(withRetry(mockModel([])).supportsHostedTool?.('web_search')).toBe(true);
    expect(withRetry(bare).supportsHostedTool?.('web_search')).toBe(false);
    expect(withFallback([mockModel([]), bare]).supportsHostedTool?.('web_search')).toBe(true);
    expect(withFallback([bare, mockModel([])]).supportsHostedTool?.('web_search')).toBe(false);
  });
});
