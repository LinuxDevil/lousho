/**
 * Handoffs. A triage agent hands the conversation to a specialist, which
 * answers in the same run and keeps the conversation in later session turns.
 * One mockModel per agent, so each test sees which agent made each model call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from './createAgent';
import { handoff, handoffFilters, type Handoff } from './handoffs';
import { defineTool } from './tools/defineTool';
import { once } from './tools/approvalPolicies';
import { ask, deny } from './execution/permissions';
import { PropagatingToolError } from './execution/propagatingToolError';
import { remoteAgent } from './subagents/remoteAgent';
import { memoryStore } from './storage/agentStore';
import { defineMemory, inMemoryMemory, memoryKey } from './memory';
import { mockModel, type MockModel } from './testing';
import type { AgentEvent } from './execution/agentEvents';
import type { Message } from './providers';
import type { HandoffInputData } from './execution/handoffRun';

const toBilling = (args: Record<string, unknown> = { reason: 'billing question' }, id = 'call_handoff') => ({ toolCalls: [{ name: 'transfer_to_billing', args, id }] });

function lookupTool() {
  return defineTool({ name: 'lookup_account', description: 'Looks up the account', input: z.object({}), execute: async () => ({ plan: 'pro' }) });
}

function refundTool(options: { needsApproval?: boolean; crash?: { once: boolean } } = {}) {
  const execute = vi.fn(async ({ amount }: { amount: number }, ctx?: { principal?: { id: string } }) => {
    if (options.crash?.once) {
      options.crash.once = false;
      throw new PropagatingToolError('process died while refunding');
    }
    return { refunded: amount, for: ctx?.principal?.id ?? null };
  });
  const tool = defineTool({ name: 'refund', description: 'Refunds a charge', input: z.object({ amount: z.number() }), needsApproval: options.needsApproval, execute });
  return { tool, execute };
}

/** A billing specialist and a triage agent that hands off to it. */
function setup(
  triageScript: Parameters<typeof mockModel>[0],
  billingScript: Parameters<typeof mockModel>[0],
  options: {
    triage?: Partial<Parameters<typeof createAgent>[0]>;
    billing?: Partial<Parameters<typeof createAgent>[0]>;
    entry?: (billing: SimpleAgent) => SimpleAgent | Handoff;
    refund?: ReturnType<typeof refundTool>;
  } = {}
) {
  const triageModel = mockModel(triageScript);
  const billingModel = mockModel(billingScript);
  const refund = options.refund ?? refundTool();
  const billing = createAgent({
    name: 'billing',
    description: 'Answers billing questions',
    instructions: 'You handle billing.',
    provider: billingModel,
    tools: [refund.tool],
    ...options.billing,
  } as Parameters<typeof createAgent>[0]);
  const triage = createAgent({
    name: 'triage',
    description: 'Routes the user',
    instructions: 'You route the user.',
    provider: triageModel,
    tools: [lookupTool()],
    handoffs: [options.entry ? options.entry(billing) : billing],
    ...options.triage,
  } as Parameters<typeof createAgent>[0]);
  return { triage, billing, triageModel, billingModel, refund };
}

const toolNames = (model: MockModel, call: number) => (model.calls[call].tools ?? []).map((tool) => tool.function.name);
const systemPrompts = (messages: readonly Message[]) => messages.filter((m) => m.role === 'system').map((m) => m.content);
/**
 * The routing notes of a transcript (each handoff leaves a system message marked with `metadata.handoff`)
 * or of a model request, where they are appended to the leading system prompt.
 */
const routingNotes = (messages: readonly Message[]) =>
  messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => (m.metadata?.handoff !== undefined ? [String(m.content)] : String(m.content).split('\n\n').filter((line) => line.startsWith('[routing note'))));
const handoffResult = (messages: readonly Message[]) => messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_handoff');

afterEach(() => { vi.restoreAllMocks(); });

describe('handoffs: options', () => {
  it('inputFilter gets the transcript without the system prompt, ending with the handoff call, its result and the routing note', async () => {
    let seen: HandoffInputData | undefined;
    const onHandoff = vi.fn();
    const { triage, billingModel } = setup([toBilling({ reason: 'double charge' })], ['OK.'], {
      entry: (billing) =>
        handoff(billing, {
          inputFilter: (data) => {
            seen = data;
            return data.messages;
          },
          onHandoff,
        }),
    });

    await triage.send('I was charged twice', { sessionId: undefined });

    expect(seen?.from).toBe('triage');
    expect(seen?.to).toBe('billing');
    expect(seen?.args).toEqual({ reason: 'double charge' });
    expect(seen?.messages[0]).toMatchObject({ role: 'user', content: 'I was charged twice' });
    expect(seen?.messages.at(-3)?.toolCalls?.[0].id).toBe('call_handoff');
    expect(seen?.messages.at(-2)).toMatchObject({ role: 'tool', toolCallId: 'call_handoff' });
    // The routing note is the last message, marked so a filter can recognise it.
    expect(seen?.messages.at(-1)).toMatchObject({ role: 'system', metadata: { handoff: { from: 'triage', to: 'billing' } } });
    expect(String(seen?.messages.at(-1)?.content)).toContain('reason="double charge"');
    expect(onHandoff).toHaveBeenCalledWith(expect.objectContaining({ from: 'triage', to: 'billing', args: { reason: 'double charge' } }));
    expect(billingModel.calls).toHaveLength(1);
  });

  it('handoffFilters.removeToolCalls: the target sees user and assistant text plus the routing note (the marker)', async () => {
    const turn = { text: 'Let me get billing.', toolCalls: [{ name: 'lookup_account', args: {}, id: 'call_lookup' }, { name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] };
    const { triage, billingModel } = setup([turn], ['Billing here.'], { entry: (billing) => handoff(billing, { inputFilter: handoffFilters.removeToolCalls }) });

    const result = await triage.send('I was charged twice');

    const seen = billingModel.calls[0].messages as Message[];
    // The transcript keeps the routing note last; the request carries it in the system prompt.
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'system', 'assistant']);
    expect(result.messages[3].metadata?.handoff).toEqual({ from: 'triage', to: 'billing' });
    expect(seen.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(seen[2]).not.toHaveProperty('toolCalls');
    expect(seen[2].content).toBe('Let me get billing.');
    expect(String(seen[0].content)).toContain('handoff triage -> billing');
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('handoffFilters.lastUserMessage: the target sees only the last user message', async () => {
    const { triage, billingModel } = setup([toBilling()], ['Billing here.'], { entry: (billing) => handoff(billing, { inputFilter: handoffFilters.lastUserMessage }) });

    await triage.send([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'I was charged twice' },
    ]);

    const seen = billingModel.calls[0].messages as Message[];
    expect(seen.map((m) => [m.role, m.content])).toEqual([
      ['system', 'You handle billing.'],
      ['user', 'I was charged twice'],
    ]);
    expect(seen[1].metadata?.handoff).toEqual({ from: 'triage', to: 'billing' });
  });

  it('isEnabled: false (or a function of the run returning false) hides the handoff tool', async () => {
    const hidden = setup(['Hi.'], [], { entry: (billing) => handoff(billing, { isEnabled: false }) });
    await hidden.triage.send('Hi');
    expect(toolNames(hidden.triageModel, 0)).toEqual(['lookup_account']);

    const perRun = setup(['Hi.', 'Hi again.'], [], { entry: (billing) => handoff(billing, { isEnabled: ({ metadata }) => metadata?.plan === 'pro' }) });
    await perRun.triage.send('Hi', { metadata: { plan: 'free' } });
    await perRun.triage.send('Hi', { metadata: { plan: 'pro' } });
    expect(toolNames(perRun.triageModel, 0)).toEqual(['lookup_account']);
    expect(toolNames(perRun.triageModel, 1)).toEqual(['lookup_account', 'transfer_to_billing']);
  });

  it('two handoffs in one step: the first is honored, the other gets an error result', async () => {
    const refundsModel = mockModel([]);
    const refunds = createAgent({ name: 'refunds', description: 'Refunds', provider: refundsModel });
    const turn = { toolCalls: [{ name: 'transfer_to_billing', args: {}, id: 'call_handoff' }, { name: 'transfer_to_refunds', args: {}, id: 'call_second' }] };
    const billingModel = mockModel(['Billing here.']);
    const billing = createAgent({ name: 'billing', description: 'Billing', provider: billingModel });
    const triage = createAgent({ name: 'triage', provider: mockModel([turn]), handoffs: [billing, refunds] });

    const result = await triage.send('Help');

    expect(result.agentName).toBe('billing');
    expect(refundsModel.calls).toHaveLength(0);
    const second = result.messages.find((m) => m.toolCallId === 'call_second');
    expect(second?.isError).toBe(true);
    expect(JSON.parse(second?.content as string).message).toMatch(/only one handoff per turn/);
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_handoff', 'call_second']);
  });

  it('maxHandoffs: a handoff over the limit gets a tool error and the agent answers itself', async () => {
    const backModel = mockModel([{ toolCalls: [{ name: 'transfer_to_triage', args: {}, id: 'call_back' }] }, 'I will answer myself.']);
    const billingHandoffs: Handoff[] = [];
    const billing = createAgent({ name: 'billing', description: 'Billing', provider: backModel, handoffs: billingHandoffs });
    const triageModel = mockModel([toBilling()]);
    const triage = createAgent({ name: 'triage', description: 'Routes the user', provider: triageModel, handoffs: [billing], maxHandoffs: 1 });
    billingHandoffs.push(handoff(triage));

    const result = await triage.send('Help');

    expect(result.agentName).toBe('billing');
    expect(result.text).toBe('I will answer myself.');
    expect(triageModel.calls).toHaveLength(1);
    expect(JSON.parse(result.messages.find((m) => m.toolCallId === 'call_back')?.content as string).message).toMatch(/maxHandoffs/);
  });
});

describe('handoffs: what stays the lead run\'s', () => {

  it('a target does not inherit approvals the source remembered with once()', async () => {
    const approved = vi.fn(async () => 'ok');
    const lead = defineTool({ name: 'refund', description: 'Lead refund', input: z.object({}), needsApproval: once(), execute: approved });
    const targetRefund = vi.fn(async () => 'target ok');
    const billing = createAgent({
      name: 'billing',
      description: 'Billing',
      provider: mockModel([{ toolCalls: [{ name: 'refund', args: {}, id: 'call_target_refund' }] }]),
      tools: [defineTool({ name: 'refund', description: 'Target refund', input: z.object({}), needsApproval: once(), execute: targetRefund })],
    });
    const triage = createAgent({
      name: 'triage',
      provider: mockModel([{ toolCalls: [{ name: 'refund', args: {}, id: 'call_lead_refund' }] }, toBilling()]),
      tools: [lead],
      handoffs: [billing],
    });

    const first = await triage.send('Refund me');
    expect(first.finishReason).toBe('awaiting-approval');
    const second = await triage.approvals.resolve({ id: first.approvalId!, approved: true });

    // The target's own `once()` tool asks again: the lead's approval is not in its transcript.
    expect(second.finishReason).toBe('awaiting-approval');
    expect(second.agentName).toBe('billing');
    expect(targetRefund).not.toHaveBeenCalled();
    expect(second.messages.some((m) => m.metadata?.approval !== undefined)).toBe(false);
  });
});

describe('handoffs: approvals and durable resume', () => {

  it('a handoff call next to a call that needs approval hands off once the approval is decided', async () => {
    const approveMe = vi.fn(async () => 'looked up');
    const turn = { toolCalls: [{ name: 'check', args: {}, id: 'call_check' }, { name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] };
    const billingModel = mockModel(['Billing here.']);
    const billing = createAgent({ name: 'billing', description: 'Billing', instructions: 'You handle billing.', provider: billingModel });
    const triage = createAgent({
      name: 'triage',
      provider: mockModel([turn]),
      tools: [defineTool({ name: 'check', description: 'Check', input: z.object({}), needsApproval: true, execute: approveMe })],
      handoffs: [billing],
    });

    const paused = await triage.send('Help');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.agentName).toBe('triage');
    expect(paused.messages.some((m) => m.metadata?.handoff)).toBe(false);

    const result = await triage.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(approveMe).toHaveBeenCalledTimes(1);
    expect(result.agentName).toBe('billing');
    expect(result.text).toBe('Billing here.');
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_check', 'call_handoff']);
  });

  it('a crash after the handoff resumes in the target from the checkpoint (agent.resume), with no drift warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memoryStore();
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const crashing = setup([toBilling()], [callRefund], { refund: refundTool({ crash: { once: true } }), triage: { store }, billing: { store } });
    await expect(crashing.triage.send('Refund me', { sessionId: 'job-1' })).rejects.toThrow('process died');

    // A new process: the same agents, created again, on the same store.
    const events: AgentEvent[] = [];
    const restarted = setup([], ['Refunded 5.'], { triage: { store, onEvent: (event: AgentEvent) => events.push(event) }, billing: { store } });
    const result = await restarted.triage.resume('job-1');

    expect(result?.text).toBe('Refunded 5.');
    expect(result?.agentName).toBe('billing');
    expect(restarted.refund.execute).toHaveBeenCalledTimes(1);
    expect(restarted.triageModel.calls).toHaveLength(0);
    expect(restarted.billingModel.calls).toHaveLength(1);
    expect(systemPrompts(restarted.billingModel.calls[0].messages as Message[])).toEqual([
      'You handle billing.\n\n[routing note - not from the user] handoff triage -> billing: reason="billing question"',
    ]);
    expect(events.some((event) => event.type === 'agent.drift')).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/drift|changed/i);
  });
});

describe('handoffs: the transfer call passes the run\'s gate', () => {
  it('a deny rule on the transfer tool refuses the handoff with a model-visible error, audited', async () => {
    const onPermissionDecision = vi.fn();
    const events: AgentEvent[] = [];
    const { triage, billingModel } = setup([toBilling(), 'I cannot transfer you.'], [], {
      triage: { permissions: [deny('transfer_to_billing', 'transfers are off')], onPermissionDecision, onEvent: (event: AgentEvent) => events.push(event) },
    });

    const result = await triage.send('Refund me');

    expect(result.agentName).toBe('triage');
    expect(result.text).toBe('I cannot transfer you.');
    expect(billingModel.calls).toHaveLength(0);
    const refused = handoffResult(result.messages);
    expect(refused?.isError).toBe(true);
    expect(JSON.parse(refused?.content as string)).toMatchObject({ kind: 'denied' });
    expect(refused?.metadata?.handoff).toBeUndefined();
    expect(onPermissionDecision.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: 'transfer_to_billing', toolCallId: 'call_handoff', decision: 'deny' })])
    );
    expect(events.some((event) => event.type === 'permission.decision' && event.toolName === 'transfer_to_billing')).toBe(true);
    expect(events.some((event) => event.type === 'tool.error' && event.toolCallId === 'call_handoff')).toBe(true);
  });

  it('an ask rule on the transfer tool pauses for approval and hands off once approved', async () => {
    const events: AgentEvent[] = [];
    const onPermissionDecision = vi.fn();
    const { triage, triageModel, billingModel } = setup([toBilling()], ['Billing here.'], {
      triage: { permissions: [ask('transfer_to_billing')], onPermissionDecision, onEvent: (event: AgentEvent) => events.push(event) },
    });

    const paused = await triage.send('Refund me');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.agentName).toBe('triage');
    expect(billingModel.calls).toHaveLength(0);
    expect(paused.messages.some((m) => m.metadata?.handoff)).toBe(false);
    expect(onPermissionDecision.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: 'transfer_to_billing', decision: 'ask' })])
    );
    expect(events.some((event) => event.type === 'approval.requested' && event.toolName === 'transfer_to_billing')).toBe(true);

    const result = await triage.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.agentName).toBe('billing');
    expect(result.text).toBe('Billing here.');
    expect(triageModel.calls).toHaveLength(1);
    expect(billingModel.calls).toHaveLength(1);
    expect(routingNotes(result.messages)).toEqual(['[routing note - not from the user] handoff triage -> billing: reason="billing question"']);
  });
});

describe('handoffs: configuration errors', () => {
  const provider = () => mockModel([]);

  it('a target without a name or a description', () => {
    const unnamed = createAgent({ description: 'No name', provider: provider() });
    expect(() => createAgent({ provider: provider(), handoffs: [unnamed] })).toThrow(/needs a name/);
    const undescribed = createAgent({ name: 'billing', provider: provider() });
    expect(() => createAgent({ provider: provider(), handoffs: [undescribed] })).toThrow(/needs a description/);
    // A description given on the handoff is enough.
    expect(() => createAgent({ provider: provider(), handoffs: [handoff(undescribed, { description: 'Billing' })] })).not.toThrow();
  });

  it('duplicate names, a clash with a tool, a remote agent, the agent itself', () => {
    const a = createAgent({ name: 'billing', description: 'A', provider: provider() });
    const b = createAgent({ name: 'billing', description: 'B', provider: provider() });
    expect(() => createAgent({ provider: provider(), handoffs: [a, b] })).toThrow(/two handoff targets are named 'billing'/);
    const clashing = defineTool({ name: 'transfer_to_billing', description: 'x', input: z.object({}), execute: async () => 'x' });
    expect(() => createAgent({ provider: provider(), tools: [clashing], handoffs: [a] })).toThrow(/has the name of one of the agent's tools/);
    const remote = remoteAgent({ url: 'https://agents.example.com/billing', description: 'Remote billing' });
    expect(() => createAgent({ provider: provider(), handoffs: [remote as unknown as SimpleAgent] })).toThrow(/remote agent/);
    expect(() => createAgent({ name: 'billing', provider: provider(), handoffs: [a] })).toThrow(/cannot hand off to itself/);
    expect(() => createAgent({ provider: provider(), maxHandoffs: -1 })).toThrow(/maxHandoffs/);
  });

  it('a clash with a tool from a per-run tools function is refused when the run starts', async () => {
    const billing = createAgent({ name: 'billing', description: 'Billing', provider: provider() });
    const clashing = defineTool({ name: 'transfer_to_billing', description: 'x', input: z.object({}), execute: async () => 'x' });
    const triage = createAgent({ provider: mockModel(['unused']), tools: () => [clashing], handoffs: [billing] });
    await expect(triage.send('Hi')).rejects.toThrow(/uses the tool name 'transfer_to_billing'/);
  });
});

describe('handoffs: memory stays on after a handoff', () => {
  const principal = { id: 'C100', type: 'user' as const, authenticator: 'custom' };

  async function memorySetup(billingScript: Parameters<typeof mockModel>[0], billing: Partial<Parameters<typeof createAgent>[0]> = {}) {
    const provider = inMemoryMemory();
    const notes = defineMemory({ name: 'customer_notes', scope: ({ principal: who }) => (who ? `customer:${who.id}` : undefined), provider });
    await provider.add(memoryKey(notes, { principal })!, { text: 'Shoe size EU 42.' });
    return { provider, ...setup([toBilling()], billingScript, { triage: { memory: [notes] }, billing }) };
  }

  it('a target\'s own memory slots are not used; createAgent warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const own = defineMemory({ name: 'billing_notes', scope: 'global', provider: inMemoryMemory() });
    const { triage, billingModel } = await memorySetup(['Refund issued.'], { memory: [own] });

    await triage.send('I was charged twice', { principal });

    expect(toolNames(billingModel, 0)).toEqual(['refund', 'remember_customer_notes', 'recall_customer_notes']);
    const warnings = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("'memory'"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/handoff target 'billing'/);
  });
});

describe('handoffs: the target\'s own tool search', () => {
  const lookup = defineTool({ name: 'lookup_invoice', description: 'Look up an invoice', input: z.object({ id: z.string() }), deferLoading: true, execute: async () => 'inv' });
  const toolNames = (model: MockModel) => (model.calls[0]?.tools ?? []).map((tool) => tool.function.name);

  it.each([
    ['the lead turns it off', { toolSearch: false as const }],
  ])('applies the target\'s toolSearch when %s', async (_label, leadOptions) => {
    const billingModel = mockModel(['billing answer']);
    const billing = createAgent({ name: 'billing', description: 'Billing desk', provider: billingModel, tools: [lookup], toolSearch: { thresholdPercent: 0 } });
    const triage = createAgent({
      name: 'triage',
      provider: mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: {} }] }]),
      handoffs: [billing],
      ...leadOptions,
    });

    const result = await triage.send('charged twice');

    expect(result.agentName).toBe('billing');
    expect(toolNames(billingModel)).toContain('tool_search');
    expect(toolNames(billingModel)).not.toContain('lookup_invoice');
  });
});
