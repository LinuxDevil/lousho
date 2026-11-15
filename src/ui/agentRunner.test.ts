/**
 * Approve() / reject() / answer() of the runner consume the streamed
 * continuation event by event, and fall back to an older server's JSON outcome.
 */
import { describe, it, expect } from 'vitest';
import { createAgentRunner } from './agentRunner';
import { AGENT_EVENT_SCHEMA_VERSION } from '../execution/agentEvents';
import { initialAgentUIState, reduceAgentEvents, type AgentUIState } from './reducer';

const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
const frame = (event: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify({ ...base, seq: 0, ...event })}\n\n`);

describe('remote mode session id', () => {

  it('keeps the server { error } message in a failed request', async () => {
    let state: AgentUIState = initialAgentUIState;
    const fetchMock = (async () => Response.json({ error: 'Invalid API key' }, { status: 401 })) as typeof fetch;
    const runner = createAgentRunner({
      source: () => ({ url: '/send', fetch: fetchMock }),
      options: () => ({}),
      state: () => state,
      dispatch: (action) => (state = reduceAgentEvents(state, action)),
    });
    await runner.send('hi');
    expect(state.status).toBe('error');
    expect(state.error?.message).toBe('POST /send failed with 401: Invalid API key');
  });
});

describe('a remote stream that ends before run.done', () => {
  function remote(body: Uint8Array[]) {
    let state: AgentUIState = initialAgentUIState;
    const fetchMock = (async () => new Response(new Blob(body as BlobPart[]), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
    const runner = createAgentRunner({
      source: () => ({ url: '/send', fetch: fetchMock }),
      options: () => ({}),
      state: () => state,
      dispatch: (action) => (state = reduceAgentEvents(state, action)),
    });
    return { runner, state: () => state };
  }

  it("does not count a sub-agent's run.done as the end of the run", async () => {
    const h = remote([frame({ type: 'run.done', finishReason: 'stop', text: '', subagent: { name: 's', depth: 1, toolCallId: 't' } })]);
    await h.runner.send('hi');
    expect(h.state().status).toBe('error');
  });
});

describe('createAgentRunner request headers', () => {
  async function sentHeaders(headers: unknown): Promise<Headers> {
    let seen: RequestInit | undefined;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return new Response(new Blob([frame({ type: 'run.done', finishReason: 'stop', text: 'ok' })] as BlobPart[]), { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
    let state: AgentUIState = initialAgentUIState;
    const runner = createAgentRunner({
      source: () => ({ url: '/send', fetch: fetchMock, headers: headers as Record<string, string> }),
      options: () => ({}),
      state: () => state,
      dispatch: (action) => (state = reduceAgentEvents(state, action)),
    });
    await runner.send('hi');
    return new Headers(seen?.headers);
  }

  it('sends one content-type when the caller sets its own in another case', async () => {
    const headers = await sentHeaders({ Authorization: 'Bearer t', 'content-type': 'application/json' });
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer t');
  });
});
