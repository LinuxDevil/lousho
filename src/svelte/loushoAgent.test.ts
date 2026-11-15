// @vitest-environment node
/**
 * The Svelte loushoAgent() store driven through its subscribe()
 * contract (no DOM needed), in process with mockModel and remote with a
 * scripted fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { AGENT_EVENT_SCHEMA_VERSION } from '../execution/agentEvents';
import type { AgentUIState } from '../ui';
import { loushoTodos } from './loushoTodos';
import { createTodoTools } from '../tools/built-in/todo';
import type { TodoView } from '../ui';
import { loushoAgent, type LoushoAgentStore } from './loushoAgent';

/** What `$agent` reads: the latest value the store handed to a subscriber. */
function watch(store: LoushoAgentStore) {
  let value!: AgentUIState;
  const unsubscribe = store.subscribe((state) => (value = state));
  return { state: () => value, unsubscribe };
}

function emailAgent(...turns: Parameters<typeof mockModel>[0]) {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
  return { agent: createAgent({ provider: mockModel(turns), tools: [tool] }), execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam' }, id: 'call_email' }] };

describe('loushoAgent for Svelte', () => {

  it('shows a tool call and its state through the approval round trip', async () => {
    const { agent, execute } = emailAgent(callEmail, 'Email sent.');
    const store = loushoAgent({ agent });
    const { state } = watch(store);

    await store.send('Email Sam');
    expect(state().status).toBe('awaiting-approval');
    expect(state().pendingApproval).toMatchObject({ toolName: 'send_email', args: { to: 'sam' } });
    expect(state().messages[1].toolCalls).toMatchObject([{ name: 'send_email', status: 'awaiting-approval' }]);

    await store.approve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state().pendingApproval).toBeNull();
    expect(state().messages[1]).toMatchObject({ text: 'Email sent.', toolCalls: [{ name: 'send_email', status: 'done' }] });
  });

  it('a failing run ends in the error status', async () => {
    const store = loushoAgent({ agent: createAgent({ provider: mockModel([{ error: new Error('provider down') }]) }) });
    const { state } = watch(store);
    await store.send('Hi');
    expect(state().status).toBe('error');
    expect(state().error?.message).toMatch(/provider down/);
  });
});

describe('loushoAgent for Svelte remote and abort', () => {
  const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
  const partial = `data: ${JSON.stringify({ ...base, seq: 0, type: 'text.delta', text: 'partial' })}\n\n`;

  /** A fetch whose response never ends; aborting the request errors it. */
  function openFetch() {
    const signals: AbortSignal[] = [];
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(partial));
          signal.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return new Response(stream);
    };
    return { fetch: fetchMock as typeof fetch, signals };
  }

  it('a transient subscribe/unsubscribe (svelte/store get()) does not abort the run', async () => {
    const remote = openFetch();
    const store = loushoAgent({ url: '/api/agent', fetch: remote.fetch });
    const sending = store.send('Long story');
    await vi.waitFor(() => expect(remote.signals.length).toBe(1));
    let seen: AgentUIState | undefined;
    store.subscribe((state) => (seen = state))();
    expect(seen?.status).toBe('streaming');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(remote.signals[0].aborted).toBe(false);

    const watcher = watch(store);
    store.subscribe(() => {})();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(remote.signals[0].aborted).toBe(false);
    watcher.unsubscribe();
    await sending;
    expect(remote.signals[0].aborted).toBe(true);
  });

});

describe('loushoTodos', () => {
  const todoWrite = { name: 'todo_write', args: { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] } };

  it('follows the todo list of an in-process run and notifies only when it changes', async () => {
    const store = loushoAgent({ agent: createAgent({ provider: mockModel([{ toolCalls: [todoWrite] }, 'done']), tools: createTodoTools().tools }) });
    const views: TodoView[] = [];
    const unsubscribe = loushoTodos(store).subscribe((view) => views.push(view));
    expect(views).toHaveLength(1);
    expect(views[0].todos).toEqual([]);

    await store.send('Go');

    expect(views).toHaveLength(2);
    expect(views[1].counts).toEqual({ pending: 1, in_progress: 1, completed: 1, total: 3 });
    expect(views[1].current?.content).toBe('Build');
    unsubscribe();
  });
});
