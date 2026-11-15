// @vitest-environment node
/**
 * UseLoushoAgent() rendered with react-test-renderer (no DOM
 * needed), in process with mockModel and remote with a scripted fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent } from '../execution/agentEvents';
import { useTodos } from './useTodos';
import { useLoushoAgent, type LoushoAgentSource, type UseLoushoAgentOptions, type UseLoushoAgentResult } from './useLoushoAgent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hook: UseLoushoAgentResult;
let renderer: ReactTestRenderer | undefined;
const statuses: string[] = [];

let todoView: ReturnType<typeof useTodos>;
const todoViews: unknown[] = [];

function Probe({ source, options }: { source: LoushoAgentSource; options?: UseLoushoAgentOptions }) {
  hook = useLoushoAgent(source, options);
  todoView = useTodos(hook);
  todoViews.push(todoView);
  statuses.push(hook.status);
  return null;
}

function mount(source: LoushoAgentSource, options?: UseLoushoAgentOptions): void {
  statuses.length = 0;
  act(() => {
    renderer = create(createElement(Probe, { source, options }));
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
const sse = (events: AgentEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** A fetch whose response body streams `body` and, unless `close` is false, ends; aborting the request errors it. */
function scriptedFetch(responses: { body: string; close?: boolean; status?: number }[]) {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { body, close = true, status = 200 } = responses.shift() ?? { body: '' };
    const signal = init?.signal ?? new AbortController().signal;
    signals.push(signal);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        if (close) controller.close();
        else signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return new Response(stream, { status });
  });
  return { fetch: fetchMock as unknown as typeof fetch, fetchMock, signals };
}

describe('useLoushoAgent remote', () => {

  it('approve() POSTs to approvalsUrl and applies the outcome; without it, it does nothing', async () => {
    const paused = sse([
      { ...base, seq: 0, type: 'approval.requested', approvalId: 'ap 1', toolCallId: 'c1', toolName: 'pay', args: {} },
      { ...base, seq: 1, type: 'run.done', finishReason: 'awaiting-approval', text: '' },
    ]);
    const remote = scriptedFetch([{ body: paused }, { body: JSON.stringify({ text: 'Paid.', finishReason: 'stop' }) }, { body: paused }]);
    mount({ url: '/api/agent', fetch: remote.fetch }, { approvalsUrl: '/api/approvals' });

    await act(() => hook.send('Pay'));
    expect(hook.status).toBe('awaiting-approval');
    await act(() => hook.approve('ok'));

    expect(remote.fetchMock.mock.calls[1][0]).toBe('/api/approvals/ap%201');
    expect(remote.fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ approved: true, note: 'ok' }));
    expect(hook.status).toBe('idle');
    expect(hook.messages[1].text).toBe('Paid.');

    act(() => renderer?.unmount());
    mount({ url: '/api/agent', fetch: remote.fetch });
    await act(() => hook.send('Pay'));
    await act(() => hook.approve());
    expect(remote.fetchMock).toHaveBeenCalledTimes(3);
    expect(hook.status).toBe('awaiting-approval');
  });

  it('a failed response sets the error status', async () => {
    mount({ url: '/api/agent', fetch: scriptedFetch([{ body: 'nope', status: 500 }]).fetch });
    await act(() => hook.send('Hi'));
    expect(hook.status).toBe('error');
    expect(hook.error?.message).toMatch(/500/);
  });

});
