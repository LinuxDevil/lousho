/**
 * Code mode, offline with mockModel. The scripted model returns a
 * `run_code` call with fixed code; each test checks what the script could do,
 * what the gate did with its inner calls, and what reached the model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockModel } from '../testing';
import type { AgentEvent, AgentEventOf } from './agentEvents';
import type { ExecutionResult } from './AgentExecutor';
import type { Message } from '../providers';
import { ask } from './permissions';
import type { IoGuardrail } from './ioGuardrails';
import { ALICE, fakeOAuthServer, githubProvider, listReposTool } from '../oauth/__fixtures__/fakeOAuth';
import { runScript, type ScriptHost } from './codeModeIsolate';

afterEach(() => {
  vi.restoreAllMocks();
});

const PRICES: Record<string, number> = { apple: 1.5, pear: 2, plum: 0.75 };
const RATES: Record<string, number> = { EUR: 0.5, USD: 1 };

/** `get_price` and `convert` with fixed tables; `calls` records every execution. */
function shopTools() {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const getPrice = defineTool({
    name: 'get_price',
    description: 'Price of an item in USD',
    input: z.object({ item: z.string() }),
    annotations: { readOnlyHint: true },
    execute: async ({ item }) => {
      calls.push({ tool: 'get_price', args: { item } });
      if (!(item in PRICES)) throw new Error(`Unknown item '${item}'`);
      return { item, usd: PRICES[item] };
    },
  });
  const convert = defineTool({
    name: 'convert',
    description: 'Converts USD to another currency',
    input: z.object({ amount: z.number(), to: z.enum(['EUR', 'USD']) }),
    execute: async ({ amount, to }) => {
      calls.push({ tool: 'convert', args: { amount, to } });
      return { amount: amount * RATES[to], currency: to };
    },
  });
  return { getPrice, convert, calls };
}

/** A model that calls run_code once with `code`, then answers `final`. */
function scripted(code: string, final = 'Done.'): MockModel {
  return mockModel([{ toolCalls: [{ name: 'run_code', id: 'call_code', args: { code } }] }, final]);
}

async function collect(run: AsyncIterable<AgentEvent> & { result: Promise<ExecutionResult> }) {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return { events, result: await run.result };
}

/** The parsed `tool` message of `id`. */
function toolResult(messages: readonly Message[], id = 'call_code'): { result?: unknown; logs?: string[]; toolCalls?: number; message?: string; error?: string } {
  const message = messages.find((m) => m.role === 'tool' && m.toolCallId === id);
  if (!message) throw new Error(`no tool message for ${id}`);
  return JSON.parse(String(message.content)) as never;
}

const names = (model: MockModel, call: number) => (model.calls[call].tools ?? []).map((tool) => tool.function.name);
const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((e): e is AgentEventOf<T> => e.type === type);

describe('code mode: run_code', () => {

  it('an inner call to a needsApproval tool rejects inside the script and the run does not pause', async () => {
    const executed = vi.fn();
    const pay = defineTool({ name: 'pay', description: 'Pays', input: z.object({ amount: z.number() }), needsApproval: true, execute: executed });
    const model = scripted(`try { await tools.pay({ amount: 5 }); return 'paid'; } catch (error) { return error.message; }`);
    const agent = createAgent({ provider: model, tools: [pay], codeMode: true });
    const { events, result } = await collect(agent.stream('pay'));

    expect(result.finishReason).toBe('stop');
    expect(toolResult(result.messages).result).toBe('Tool pay needs approval; call it directly, not from run_code.');
    expect(executed).not.toHaveBeenCalled();
    expect(await agent.approvals.list()).toEqual([]);
    expect(ofType(events, 'approval.requested')).toEqual([]);
    expect(ofType(events, 'tool.error')).toMatchObject([{ toolCallId: 'call_code:1', parentToolCallId: 'call_code', error: { message: 'Tool pay needs approval; call it directly, not from run_code.' } }]);
  });

  it('a deferred tool named in codeMode.tools is callable from scripts', async () => {
    const hidden = defineTool({ name: 'rare_tool', description: 'Rarely needed', input: z.object({}), deferLoading: true, execute: async () => 'rare' });
    const model = scripted(`return await tools.rare_tool({});`);
    const agent = createAgent({ provider: model, tools: [hidden], toolSearch: { thresholdPercent: 0 }, codeMode: { tools: ['rare_tool'] } });
    const result = await agent.send('x');
    expect(toolResult(result.messages).result).toBe('rare');
    // Still withheld from the model's own tool list.
    expect(names(model, 0)).toEqual(['tool_search', 'run_code']);
  });

  it('console.log lines are captured', async () => {
    const model = scripted(`console.log('hello', 1, { a: [1] }); console.error('bad'); console.warn(new Error('w')); return null;`);
    const result = await createAgent({ provider: model, codeMode: true }).send('x');
    expect(toolResult(result.messages)).toEqual({ result: null, logs: ['hello 1 {"a":[1]}', '[error] bad', '[warn] Error: w'], toolCalls: 0 });
  });

  it('values cross the boundary as JSON copies', async () => {
    const received: unknown[] = [];
    const shared = { list: [1, 2], when: new Date('2026-01-02T03:04:05Z'), fn: () => 1, big: undefined };
    const echo = defineTool({
      name: 'echo',
      description: 'Echoes',
      input: z.object({ value: z.unknown() }),
      execute: async ({ value }) => {
        received.push(value);
        return shared;
      },
    });
    const model = scripted(`
      const out = await tools.echo({ value: { n: 1, skip: undefined, f: () => 2 } });
      out.list.push(3);
      return { out, keys: Object.keys(out) };
    `);
    const result = await createAgent({ provider: model, tools: [echo], codeMode: true }).send('x');
    expect(received).toEqual([{ n: 1 }]);
    expect(toolResult(result.messages).result).toEqual({ out: { list: [1, 2, 3], when: '2026-01-02T03:04:05.000Z' }, keys: ['list', 'when'] });
    expect(shared.list).toEqual([1, 2]);
  });
});

describe('code mode: limits', () => {

  it('an infinite loop stops at timeoutMs and the host goes on', async () => {
    const model = scripted(`for (;;) {}`);
    const timer = vi.fn();
    setTimeout(timer, 10);
    const started = Date.now();
    const result = await createAgent({ provider: model, codeMode: { timeoutMs: 300 } }).send('x');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(toolResult(result.messages).message).toMatch(/^run_code stopped: the script ran longer than timeoutMs \(300 ms\)/);
    expect(result.finishReason).toBe('stop');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timer).toHaveBeenCalled();
  });

  it('an uncatchable stop: try/catch around an infinite loop does not keep it running', async () => {
    const result = await createAgent({ provider: scripted(`try { for (;;) {} } catch { return 'caught'; }`), codeMode: { timeoutMs: 200 } }).send('x');
    expect(toolResult(result.messages).message).toMatch(/timeoutMs \(200 ms\)/);
  });

  it('a returned value over maxOutputChars is a tool error; logs are cut to what is left', async () => {
    const big = await createAgent({ provider: scripted(`return 'x'.repeat(200);`), codeMode: { maxOutputChars: 100 } }).send('x');
    expect(toolResult(big.messages).message).toMatch(/return value is 202 characters of JSON, over maxOutputChars \(100\)/);
    const chatty = await createAgent({ provider: scripted(`for (let i = 0; i < 50; i++) console.log('line ' + i); return 'ok';`), codeMode: { maxOutputChars: 40 } }).send('x');
    const { result, logs = [] } = toolResult(chatty.messages);
    expect(result).toBe('ok');
    expect(logs.join('').length).toBeLessThan(120);
    expect(logs.at(-1)).toMatch(/logs truncated/);
  });
});

describe('code mode: every inner call passes the run\'s gate', () => {

  it('a tool guardrail block on an inner call stops the run, as for a direct call', async () => {
    const sent = vi.fn();
    const email = defineTool({ name: 'send_email', description: 'Sends', input: z.object({ to: z.string() }), execute: sent });
    const guardrail: IoGuardrail = { name: 'no-evil', check: (ctx) => (ctx.text.includes('evil.com') ? { ok: false, reason: 'mentions evil.com' } : { ok: true }) };
    // The address is built in the script, so run_code's own arguments (the code) pass the guardrail.
    const model = scripted(`try { await tools.send_email({ to: 'x@' + 'evil' + '.com' }); } catch (e) { return 'caught'; } return 'sent';`);
    const result = await createAgent({ provider: model, tools: [email], codeMode: true, guardrails: { tools: [guardrail] } }).send('x');
    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail).toMatchObject({ name: 'no-evil', kind: 'tool', toolName: 'send_email' });
    expect(sent).not.toHaveBeenCalled();
  });

  it('a tool that needs a sign-in (ctx.getToken()) rejects inside the script; the run does not pause', async () => {
    const server = fakeOAuthServer();
    const { tool, executions } = listReposTool(githubProvider(server));
    const model = scripted(`try { return await tools.list_repos({}); } catch (e) { return e.message; }`);
    const agent = createAgent({ provider: model, tools: [tool], codeMode: true, store: memoryStore() });
    const result = await agent.send('x', { principal: ALICE });
    expect(result.finishReason).toBe('stop');
    expect(toolResult(result.messages).result).toBe('Tool list_repos needs the user to sign in to GitHub; call it directly, not from run_code.');
    expect(executions).toEqual([]);
    expect(await agent.approvals.list()).toEqual([]);
  });

  it('Promise.all respects toolConcurrency', async () => {
    let running = 0;
    let peak = 0;
    const work = defineTool({
      name: 'work',
      description: 'Works',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running--;
        return n;
      },
    });
    const code = `return await Promise.all([1, 2, 3, 4].map((n) => tools.work({ n })));`;
    const serial = await createAgent({ provider: scripted(code), tools: [work], codeMode: true, toolConcurrency: 1 }).send('x');
    expect(toolResult(serial.messages).result).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(1);
    peak = 0;
    await createAgent({ provider: scripted(code), tools: [work], codeMode: true }).send('x');
    expect(peak).toBe(4);
  });

  it('run_code itself can need approval: the script runs, through the gate, after the decision', async () => {
    const { getPrice, calls } = shopTools();
    const model = mockModel([{ toolCalls: [{ name: 'run_code', id: 'call_code', args: { code: `return await tools.get_price({ item: 'plum' });` } }] }, 'Done.']);
    const seen: string[] = [];
    const agent = createAgent({
      provider: model,
      tools: [getPrice],
      codeMode: true,
      permissions: [ask('run_code')],
      hooks: [{ name: 'spy', preToolCall: (ctx) => void seen.push(ctx.toolCallId) }],
    });
    const paused = await agent.send('x');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(calls).toEqual([]);
    const [pending] = await agent.approvals.list();
    const resumed = await agent.approvals.resolve({ id: pending.id, approved: true });
    expect(resumed.finishReason).toBe('stop');
    expect(toolResult(resumed.messages).result).toEqual({ item: 'plum', usd: 0.75 });
    expect(seen).toEqual(['call_code', 'call_code', 'call_code:1']);
  });
});

describe('code mode: configuration', () => {
  it('rejects invalid options and a tool already named run_code', () => {
    expect(() => createAgent({ provider: mockModel(['x']), codeMode: { timeoutMs: 0 } })).toThrow(/'codeMode.timeoutMs' must be a whole number >= 1/);
    expect(() => createAgent({ provider: mockModel(['x']), codeMode: { tools: ['run_code'] } })).toThrow(/cannot name 'run_code'/);
    expect(() => createAgent({ provider: mockModel(['x']), codeMode: { nope: 1 } as never })).toThrow(/'codeMode.nope' is not an option/);
  });
});

describe('code mode: the isolate', () => {
  const limits = { timeoutMs: 2_000, memoryLimitBytes: 16 * 1024 * 1024, maxToolCalls: 5, maxOutputChars: 1_000 };
  const host = (overrides: Partial<ScriptHost> = {}): ScriptHost => ({
    toolNames: ['echo'],
    callTool: async (_name, args) => ({ json: JSON.stringify(args) }),
    ...overrides,
  });

  it('disposes every handle: the debug build reports no leak on any ending', async () => {
    const { newQuickJSWASMModule, DEBUG_SYNC } = await import('quickjs-emscripten');
    const debug = await newQuickJSWASMModule(DEBUG_SYNC);
    const run = (code: string, overrides?: Partial<ScriptHost>, extra?: Partial<typeof limits>) => runScript(debug, code, host(overrides), { ...limits, ...extra });
    await expect(run(`return await tools.echo({ a: 1 })`)).resolves.toMatchObject({ result: { a: 1 } });
    await expect(run(`throw new Error('boom')`)).rejects.toThrow(/boom/);
    await expect(run(`await tools.echo({}); for (;;) {}`, {}, { timeoutMs: 100 })).rejects.toThrow(/timeoutMs/);
    // (The debug build does not enforce the memory limit; the release build's is tested above.)
    await expect(run(`let s = 'x'; for (;;) s = s + s + '';`)).rejects.toThrow(/run_code failed: the script threw InternalError: string too long/);
    await expect(run(`for (let i = 0; i < 9; i++) await tools.echo({});`)).rejects.toThrow(/maxToolCalls/);
    await expect(run(`tools.echo({}); return 1;`, { callTool: () => new Promise((resolve) => setTimeout(() => resolve({ json: '1' }), 30)) })).resolves.toMatchObject({ result: 1 });
    await expect(run(`return await tools.echo({});`, { callTool: async () => ({ error: 'nope' }) })).rejects.toThrow(/ToolError: nope/);
    await expect(run(`await Promise.all([tools.echo({}), tools.echo({})]);`, { callTool: () => new Promise((resolve) => setTimeout(() => resolve({ json: '1' }), 500)) }, { timeoutMs: 100 })).rejects.toThrow(/timeoutMs/);
  });
});
