/**
 * A tool whose `execute` is an `async function*` streams its output.
 * Every `yield` is a complete snapshot, reported as `tool.partial`; the last
 * one is the result. Snapshots never reach the model, the transcript, a
 * checkpoint or a trace span.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import type { Message } from '../providers';
import { type AgentEvent, type AgentEventOf } from './agentEvents';
import type { ExecutionResult } from './AgentExecutor';
import type { IoGuardrail, IoGuardrailResult } from './ioGuardrails';
import { defineOAuthProvider } from '../oauth/defineOAuthProvider';
import { fakeOAuthServer } from '../oauth/__fixtures__/fakeOAuth';

afterEach(() => {
  vi.restoreAllMocks();
});

const ALICE = { id: 'alice', type: 'user' as const, authenticator: 'test', issuer: 'https://id.example.com' };

/** `count_to`: yields `{ at: i }` for each step, then `{ done: true, n }`. */
function countTo(onFinally?: () => void) {
  return defineTool({
    name: 'count_to',
    description: 'Counts to n, reporting progress',
    input: z.object({ n: z.number() }),
    async *execute({ n }) {
      try {
        for (let i = 1; i < n; i++) yield { at: i };
        yield { done: true, n };
      } finally {
        onFinally?.();
      }
    },
  });
}

const call = (name: string, args: Record<string, unknown>, id: string): MockTurn => ({ toolCalls: [{ name, args, id }] });

async function collect(run: AsyncIterable<AgentEvent> & { result: Promise<ExecutionResult> }) {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return { events, result: await run.result };
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

const toolMessages = (messages: readonly Message[]) => messages.filter((m) => m.role === 'tool').map((m) => m.content);

describe('generator tools stream tool.partial', () => {

  it('send() and the session transcript hold only the final result; nothing partial is checkpointed', async () => {
    const store = memoryStore();
    const saved: string[] = [];
    const save = store.checkpoints!.save.bind(store.checkpoints);
    vi.spyOn(store.checkpoints!, 'save').mockImplementation(async (sessionId, checkpoint) => {
      saved.push(JSON.stringify(checkpoint));
      return save(sessionId, checkpoint);
    });
    const partials: AgentEvent[] = [];
    const onEvent = (e: AgentEvent) => void (e.type === 'tool.partial' && partials.push(e));
    const agent = createAgent({ provider: mockModel([call('count_to', { n: 3 }, 'call_1'), 'Counted.']), tools: [countTo()], store, onEvent });

    const result = await agent.session({ id: 's1' }).send('Count to 3.');

    expect(partials).toHaveLength(3);
    expect(toolMessages(result.messages)).toEqual([JSON.stringify({ done: true, n: 3 })]);
    const transcript = (await store.sessions.load('s1')) ?? [];
    expect(transcript.length).toBeGreaterThan(0);
    expect(toolMessages(transcript)).toEqual([JSON.stringify({ done: true, n: 3 })]);
    expect(JSON.stringify(transcript)).not.toContain('\\"at\\"');
    // The checkpoint written after the call holds its final result, and no snapshot.
    expect(saved.join('\n')).toContain('\\"done\\":true');
    expect(saved.join('\n')).not.toContain('\\"at\\"');
  });

  it('aborting the run mid-generator runs its finally and settles the run as aborted', async () => {
    let finalized = false;
    let resume!: () => void;
    const slow = defineTool({
      name: 'slow',
      description: 'Takes a while',
      input: z.object({}),
      async *execute() {
        try {
          yield { step: 1 };
          await new Promise<void>((resolve) => (resume = resolve));
          yield { step: 2 };
        } finally {
          finalized = true;
        }
      },
    });
    const controller = new AbortController();
    const agent = createAgent({ provider: mockModel([call('slow', {}, 'call_1'), 'never']), tools: [slow] });

    const events: AgentEvent[] = [];
    const run = agent.stream('Go.', { signal: controller.signal });
    for await (const event of run) {
      events.push(event);
      if (event.type === 'tool.partial') controller.abort();
    }
    const result = await run.result;

    expect(result.finishReason).toBe('aborted');
    expect(ofType(events, 'tool.partial')).toHaveLength(1);
    // An async generator runs its finally once the await it is in settles.
    resume();
    await vi.waitFor(() => expect(finalized).toBe(true));
    expect(ofType(events, 'tool.partial')).toHaveLength(1);
  });

  it('a generator that yields nothing has a null result', async () => {
    const quiet = defineTool({
      name: 'quiet',
      description: 'Yields nothing',
      input: z.object({}),
      async *execute() {
        return 'ignored';
      },
    });
    const model = mockModel([call('quiet', {}, 'call_1'), 'Done.']);
    const agent = createAgent({ provider: model, tools: [quiet] });

    const { events } = await collect(agent.stream('Go.'));

    expect(ofType(events, 'tool.partial')).toEqual([]);
    expect(ofType(events, 'tool.done')[0].result).toBeNull();
  });

  it('a blocking runInParallel input guardrail: the tool never starts, no partial leaks', async () => {
    let decide!: (result: IoGuardrailResult) => void;
    const gate: IoGuardrail = { name: 'gate', runInParallel: true, check: () => new Promise((resolve) => (decide = resolve)) };
    const model = mockModel([call('count_to', { n: 3 }, 'call_1'), 'never']);
    const agent = createAgent({ provider: model, tools: [countTo()], guardrails: { input: [gate] } });

    const run = agent.stream('bad input');
    const done = collect(run);
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    decide({ ok: false, reason: 'no' });
    const { events, result } = await done;

    expect(result.finishReason).toBe('guardrail');
    expect(events.some((e) => e.type === 'tool.partial' || e.type === 'tool.start')).toBe(false);
  });
});

describe('generator tools on the resume path', () => {

  it('a generator that needs sign-in mid-stream pauses; after sign-in it runs again from the start (index 0); tokens are redacted from partials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = fakeOAuthServer();
    const github = defineOAuthProvider({
      name: 'github',
      authorizationUrl: 'https://github.example.com/login/oauth/authorize',
      tokenUrl: 'https://github.example.com/login/oauth/access_token',
      clientId: 'client-123',
      redirectUri: 'https://agent.example.com/api/agent/oauth/callback',
      fetch: server.fetch,
    });
    let runs = 0;
    const repos = defineTool({
      name: 'list_repos',
      description: 'Lists repositories',
      input: z.object({}),
      async *execute(_args, ctx) {
        runs++;
        yield { status: 'connecting' };
        const { accessToken } = await ctx.getToken(github);
        yield { status: 'listing', debug: `token=${accessToken}` };
        yield { repos: ['lousho-demo'] };
      },
    });
    const store = memoryStore();
    const turn = call('list_repos', {}, 'call_1');
    const agent = createAgent({ provider: mockModel([turn, 'You have lousho-demo.']), tools: [repos], store });

    const paused = await collect(agent.stream('List my repos.', { principal: ALICE }));
    expect(paused.result.finishReason).toBe('awaiting-approval');
    expect(ofType(paused.events, 'tool.partial').map((e) => e.output)).toEqual([{ status: 'connecting' }]);
    expect(ofType(paused.events, 'tool.done')).toEqual([]);
    const approval = ofType(paused.events, 'approval.requested')[0];
    expect(approval.kind).toBe('sign-in');

    const state = new URL(approval.signIn?.url ?? '').searchParams.get('state') ?? '';
    await agent.oauth.complete({ state, code: 'code-alice' });
    const resumed = await collect(agent.approvals.streamResolve({ id: approval.approvalId, approved: true }));

    expect(runs).toBe(2);
    const partials = ofType(resumed.events, 'tool.partial');
    expect(partials.map((e) => [e.index, e.output])).toEqual([
      [0, { status: 'connecting' }],
      [1, { status: 'listing', debug: 'token=[REDACTED]' }],
      [2, { repos: ['lousho-demo'] }],
    ]);
    expect(JSON.stringify(resumed.events)).not.toContain('gho_SECRET');
    expect(toolMessages(resumed.result.messages)).toEqual([JSON.stringify({ repos: ['lousho-demo'] })]);
  });
});
