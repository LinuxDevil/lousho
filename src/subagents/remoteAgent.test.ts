import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { serveFetch, type ServeAuth } from '../server/fetchRoutes';
import type { Message } from '../providers';
import type { AgentEventUsage } from '../execution/agentEvents';
import { SqliteStore } from '../storage/sqlite';
import { remoteAgent } from './remoteAgent';

const TOKEN = 'secret-token-123';
type Fetch = typeof fetch;

/** An in-process deployed agent: the real `/chat` routes (with bearer auth) in front of `agent`. */
function deployed(agent: SimpleAgent, token: ServeAuth = TOKEN): { fetch: Fetch; requests: Request[] } {
  const requests: Request[] = [];
  const handler: Fetch = async (input, init) => {
    const request = new Request(input as string, init);
    requests.push(request.clone());
    return serveFetch(request, { name: 'remote', agent: () => agent, exposeErrors: true }, token);
  };
  return { fetch: handler, requests };
}

const delegate = (prompt = 'research this') => ({
  text: 'asking',
  toolCalls: [{ name: 'task', args: { agent: 'remote', prompt, description: 'remote task' } }],
});

function lead(remote: ReturnType<typeof remoteAgent>, turns: MockTurn[] = [delegate(), 'done']) {
  const model = mockModel(turns);
  return { model, agent: createAgent({ provider: model, instructions: 'lead', subagents: { remote } }) };
}

const toolResult = (messages: readonly Message[]) => JSON.parse(messages.find((m) => m.role === 'tool')?.content as string) as unknown;
const errorMessage = (messages: readonly Message[]) => (toolResult(messages) as { message: string }).message;

describe('remoteAgent', () => {

  it('returns a structured coded tool error on 401 and never exposes the token', async () => {
    const server = deployed(createAgent({ provider: mockModel(['unused']), instructions: 'remote' }), 'another-token');
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const events: string[] = [];

    const run = agent.stream('go');
    for await (const event of run) events.push(JSON.stringify(event));
    const result = await run.result;

    expect(toolResult(result.messages)).toMatchObject({ toolName: 'task', kind: 'execution' });
    expect(errorMessage(result.messages)).toContain('LOUSHO_REMOTE_UNAUTHORIZED');
    expect(errorMessage(result.messages)).toContain('401');
    expect(JSON.stringify(result.messages) + events.join('')).not.toContain(TOKEN);
  });

  it('reports a network error, scrubbing the token from the message', async () => {
    const failing: Fetch = async () => {
      throw new TypeError(`connect ECONNREFUSED while sending ${TOKEN}`);
    };
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: failing }));
    const message = errorMessage((await agent.send('go')).messages);
    expect(message).toContain('could not be reached');
    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toContain(TOKEN);
  });

  it('fails when the remote run ends in an error', async () => {
    const server = deployed(createAgent({ provider: mockModel([{ error: new Error('model exploded') }]), instructions: 'remote' }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const message = errorMessage((await agent.send('go')).messages);
    expect(message).toContain('LOUSHO_REMOTE_REQUEST_FAILED');
    expect(message).toContain('model exploded');
  });

  it('says when the remote agent awaits approval and the caller cannot pause, with its session id', async () => {
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
    const remoteModel = mockModel([{ toolCalls: [{ name: 'deploy' }] }, 'never']);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote', tools: [deploy] }));
    const remote = remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch });
    const error = await remote.run('go', { name: 'remote', taskId: 'task_1' }).then(
      () => new Error('expected the run to reject'),
      (e: unknown) => e as Error
    );
    expect(error.message).toContain('awaiting approval');
    expect(error.message).toMatch(/session 'task_[\w-]+'/);
    expect(error).toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
    expect(error.message).toContain("then continue task 'task_1'");
  });

  it("aborts the in-flight request when the lead run's signal aborts", async () => {
    let seen: AbortSignal | undefined | null;
    const hanging: Fetch = (_input, init) => {
      seen = init?.signal;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    };
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', fetch: hanging }));
    const controller = new AbortController();
    const run = agent.send('go', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await run;
    expect(seen?.aborted).toBe(true);
    expect(result.finishReason).toBe('aborted');
  });
});

describe('remote sub-agent approvals through the lead run', () => {
  /** A deployed agent with a `deploy` tool that needs approval; `turns` are its model's. */
  function approvingRemote(turns: MockTurn[], auth: ServeAuth = TOKEN) {
    const runs: string[] = [];
    const deploy = defineTool({
      name: 'deploy',
      description: 'Deploys',
      input: z.object({ env: z.string() }),
      needsApproval: true,
      execute: ({ env }) => (runs.push(env), `deployed to ${env}`),
    });
    const model = mockModel(turns);
    const server = deployed(createAgent({ provider: model, instructions: 'remote', tools: [deploy] }), auth);
    return { model, runs, server };
  }
  const deployCall = (env = 'prod'): MockTurn => ({ toolCalls: [{ name: 'deploy', args: { env } }] });
  const taskResult = (messages: readonly Message[]) => String(toolResult(messages));

  it('is decided from a fresh lead agent on the same SQLite store, without the token being stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-y73-'));
    const file = join(dir, 'agent.db');
    const { server, runs } = approvingRemote([deployCall(), 'Deployed.']);
    const subagents = () => ({ remote: remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }) });
    try {
      const first = new SqliteStore(file);
      const paused = await createAgent({ provider: mockModel([delegate()]), store: first, subagents: subagents() }).session({ id: 'chat' }).send('go');
      first.close();
      const stored = readdirSync(dir).map((name) => readFileSync(join(dir, name)).toString('latin1')).join('');
      expect(stored).toContain(paused.approvalId!);
      expect(stored).not.toContain(TOKEN);

      const second = new SqliteStore(file);
      const fresh = createAgent({ provider: mockModel(['done']), store: second, subagents: subagents() });
      const result = await fresh.approvals.resolve({ id: paused.approvalId!, approved: true });
      second.close();

      expect(runs).toEqual(['prod']);
      expect(result.text).toBe('done');
      expect(taskResult(result.messages)).toMatch(/^Deployed\.\n\n.*taskId 'task_1'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a remote 401 while resolving is a coded tool error on the task call, and the lead run continues', async () => {
    const { server, runs } = approvingRemote([deployCall(), 'never']);
    let calls = 0;
    const auth = () => (calls++ === 0 ? TOKEN : 'stale-token');
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth, fetch: server.fetch }));
    const paused = await agent.send('go');

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(runs).toEqual([]);
    expect(result.text).toBe('done');
    expect(toolResult(result.messages)).toMatchObject({ toolName: 'task' });
    expect(errorMessage(result.messages)).toContain('LOUSHO_REMOTE_UNAUTHORIZED');
    expect(JSON.stringify(result.messages)).not.toContain('stale-token');
  });

  it('surfaces a remote ask_question as a question on the lead and forwards the answer', async () => {
    const remoteModel = mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Which env?' } }] }, 'Using staging.']);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote', askQuestion: true }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const paused = await agent.send('go');
    expect((await agent.approvals.list())[0]).toMatchObject({ kind: 'question', question: { text: 'Which env?' }, subagentPath: ['remote'] });

    const result = await agent.approvals.answer({ id: paused.approvalId!, answer: 'staging' });
    expect(taskResult(result.messages)).toMatch(/^Using staging\./);
    expect(JSON.stringify(remoteModel.calls[1].messages)).toContain('staging');
  });
});

describe("remote sub-agent usage in the lead's totals", () => {

  /** The deployed agent's stream with its `run.done` usage replaced by `usage` (removed when `undefined`, as an older server sends it). */
  function rewriteUsage(fetcher: Fetch, usage: AgentEventUsage | undefined): Fetch {
    return async (input, init) => {
      const response = await fetcher(input, init);
      const body = (await response.text())
        .split('\n\n')
        .map((frame) => {
          if (!frame.startsWith('data: ')) return frame;
          const event = JSON.parse(frame.slice(6)) as { type: string; usage?: unknown };
          if (event.type === 'run.done') event.usage = usage;
          return `data: ${JSON.stringify(event)}`;
        })
        .join('\n\n');
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }

  it("passes each turn's usage to onUsage and keeps the remote's reported cost", async () => {
    const reported: AgentEventUsage = { promptTokens: 7, completionTokens: 3, totalTokens: 10, inputTokens: 7, outputTokens: 3, estimated: false, costUsd: 0.25, modelCalls: 2 };
    const server = deployed(createAgent({ provider: mockModel(['ok', 'ok']), instructions: 'remote' }));
    const remote = remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: rewriteUsage(server.fetch, reported) });
    const seen: AgentEventUsage[] = [];
    await expect(remote.run('go', { onUsage: (usage) => seen.push(usage) })).resolves.toContain('ok');
    expect(seen).toEqual([reported]);

    const model = mockModel([delegate(), 'done']);
    const { usage } = await createAgent({ provider: model, instructions: 'lead', subagents: { remote } }).send('go');
    expect(usage.byModel['remote:remote']).toEqual({ inputTokens: 7, outputTokens: 3, calls: 2, costUsd: 0.25 });
    expect(usage.delegated).toMatchObject({ costUsd: 0.25, modelCalls: 2 });
  });
});
