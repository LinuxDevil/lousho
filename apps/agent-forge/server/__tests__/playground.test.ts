import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { type AgentEvent } from 'lousho';
import request from 'supertest';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { SecretsStore } from '../secretsStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { pumpRunEvents, substituteVariables, type PlaygroundEvent, type SseStream } from '../playground';

type Ingested = { type: string; data: Record<string, unknown> };

/** POSTs a playground run and parses the SSE body into its events. */
async function runPlayground(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await request(app)
    .post('/playground/run')
    .send(body as object)
    .buffer(true)
    .parse((response, callback) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => callback(null, text));
    });
  const raw = String(res.body);
  const events = raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as PlaygroundEvent);
  return { res, events };
}

describe('POST /playground/run', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let ingested: Ingested[];
  let authHeaders: (string | undefined)[];
  const savedObserve = process.env.LOUSHO_OBSERVE;

  beforeEach(() => {
    delete process.env.LOUSHO_OBSERVE;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-'));
    // Each test's reporter writes to its own array: an earlier test's reporter may still flush.
    const sink: Ingested[] = [];
    ingested = sink;
    const auth: (string | undefined)[] = [];
    authHeaders = auth;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { batch?: Ingested[] };
      sink.push(...(body.batch ?? []));
      auth.push((init?.headers as Record<string, string> | undefined)?.authorization);
      return new Response(JSON.stringify({ accepted: body.batch?.length ?? 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir, repo);
    const secretsStore = new SecretsStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
      secretsStore,
    });
    app = createApp({
      agentStore,
      runManager,
      baseDir,
      secretsStore,
      playgroundObserve: { url: 'http://127.0.0.1:7999', fetchFn, registerExitHooks: false, flushIntervalMs: 10 },
    });
  });

  afterEach(() => {
    delete process.env.LOUSHO_OBSERVE_TOKEN;
    if (savedObserve === undefined) delete process.env.LOUSHO_OBSERVE;
    else process.env.LOUSHO_OBSERVE = savedObserve;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const rootEnd = () =>
    ingested.find((e) => e.type === 'observation' && e.data.parent_obs_id === undefined && e.data.end !== undefined);

  it('reports the run as agent playground with lousho.prompt.ref', async () => {
    const { events } = await runPlayground(app, {
      model: 'mock',
      promptRef: 'greeter@prod',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const done = events[events.length - 1] as { type: string; traceId?: string };
    expect(done.type).toBe('done');
    await vi.waitFor(() => expect(rootEnd()).toBeDefined());
    const heartbeat = ingested.find((e) => e.type === 'agent.heartbeat');
    expect(heartbeat?.data.name).toBe('playground');
    const root = rootEnd()!;
    expect(root.data.trace_id).toBe(done.traceId);
    const attrs = root.data.attrs as Record<string, unknown>;
    expect(attrs['gen_ai.agent.name']).toBe('playground');
    expect(attrs['lousho.prompt.ref']).toBe('greeter@prod');
  });

  it('sends LOUSHO_OBSERVE_TOKEN as the bearer, like the env reporter', async () => {
    process.env.LOUSHO_OBSERVE_TOKEN = 'test-observe-token';
    await runPlayground(app, { model: 'mock', messages: [{ role: 'user', content: 'hi' }] });
    await vi.waitFor(() => expect(rootEnd()).toBeDefined());
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === 'Bearer test-observe-token')).toBe(true);
  });

  it('ends a run whose tool needs approval with awaiting-approval', async () => {
    const { events } = await runPlayground(app, {
      model: 'mock',
      tools: ['demo-approval'],
      messages: [{ role: 'user', content: 'call demo-approval' }],
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'demo-approval' }));
    expect(events[events.length - 1]).toMatchObject({ type: 'done', finishReason: 'awaiting-approval' });
  });

  it('streams an error event for an unknown tool', async () => {
    const { events } = await runPlayground(app, { model: 'mock', tools: ['no-such-tool'], messages: [{ role: 'user', content: 'hi' }] });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it.each([
    [{ model: 'mock', messages: [{ role: 'user', content: 'hi' }], variables: { a: 1 } }, /variables/],
  ])('rejects a bad body with 400 (%j)', async (body, message) => {
    const res = await request(app).post('/playground/run').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });
});

describe('substituteVariables', () => {
  it('replaces known placeholders and leaves unknown ones', () => {
    expect(substituteVariables('{a} and {b} and {a}', { a: 'x' })).toBe('x and {b} and x');
    expect(substituteVariables('no vars', undefined)).toBe('no vars');
    expect(substituteVariables('{toString}', {})).toBe('{toString}');
  });
});

describe('pumpRunEvents', () => {
  const recorder = () => {
    const sent: PlaygroundEvent[] = [];
    const stream: SseStream = {
      send: (event) => {
        if (!stream.ended) sent.push(event);
      },
      get ended() {
        return sent.some((e) => e.type === 'done' || e.type === 'error');
      },
    };
    return { sent, stream };
  };
  async function* events(...list: Partial<AgentEvent>[]): AsyncIterable<AgentEvent> {
    for (const event of list) yield event as AgentEvent;
  }

  it("turns run.done 'error' into one error event with the run's first error", async () => {
    const { sent, stream } = recorder();
    await pumpRunEvents(
      events(
        { type: 'error', error: { name: 'Error', message: 'first' } } as Partial<AgentEvent>,
        { type: 'error', error: { name: 'Error', message: 'second' } } as Partial<AgentEvent>,
        { type: 'run.done', finishReason: 'error', text: '' } as Partial<AgentEvent>
      ),
      stream,
      () => 't1'
    );
    expect(sent).toEqual([{ type: 'error', message: 'first' }]);
  });
});
