import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { SDKError } from '../execution/errors';
import { serveFetch } from './fetchRoutes';
import { runRemoteTurn, type SessionClientOptions } from './sessionClient';

const TOKEN = 'secret-token-123';
type Fetch = typeof fetch;

const echo = defineTool({
  name: 'echo',
  description: 'Echo',
  input: z.object({ v: z.string() }),
  execute: ({ v }) => v,
});
const gated = defineTool({
  name: 'deploy',
  description: 'Deploys',
  input: z.object({}),
  needsApproval: true,
  execute: () => 'ok',
});

/** The "deployment": the real fetch routes in front of a mockModel agent, no socket. */
function deployed(script: MockTurn[], token = TOKEN, requests: Request[] = []): Fetch {
  const agent = createAgent({
    provider: mockModel(script),
    instructions: 'remote',
    tools: [echo, gated],
  });
  return async (input, init) => {
    const request = new Request(input as string, init);
    requests.push(request.clone());
    return serveFetch(request, { name: 'remote', agent: () => agent, exposeErrors: true }, token);
  };
}

const turn = (extra: Partial<Parameters<typeof runRemoteTurn>[1]> = {}) => ({
  sessionId: 's1',
  input: 'hi',
  label: 'The remote',
  ...extra,
});
const client = (fetchImpl: Fetch, extra: Partial<SessionClientOptions> = {}): SessionClientOptions => ({
  url: 'https://agent.test/',
  auth: TOKEN,
  fetch: fetchImpl,
  ...extra,
});
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e as SDKError
  );

describe('runRemoteTurn', () => {

  it('throws LOUSHO_REMOTE_UNAUTHORIZED on 401', async () => {
    const error = await failure(runRemoteTurn(client(deployed(['x'], 'other-token')), turn()));
    expect(error).toBeInstanceOf(SDKError);
    expect(error?.code).toBe('LOUSHO_REMOTE_UNAUTHORIZED');
    expect(error?.message).toContain('The remote');
    expect(error?.message).toContain('401');
  });

  it('throws on a truncated or foreign stream, and when the stream breaks', async () => {
    const start = 'data: {"type":"run.start","runId":"r","seq":0,"v":1,"timestamp":"t","agentName":"a"}\n\n';
    for (const body of [start, 'hello']) {
      const error = await failure(
        runRemoteTurn(
          client(async () => new Response(body)),
          turn()
        )
      );
      expect(error?.code).toBe('LOUSHO_REMOTE_REQUEST_FAILED');
      expect(error?.message).toContain('without a run.done');
    }
    const broken = new ReadableStream<Uint8Array>({
      start: (c) => c.error(new Error('socket hang up')),
    });
    const error = await failure(
      runRemoteTurn(
        client(async () => new Response(broken)),
        turn()
      )
    );
    expect(error?.code).toBe('LOUSHO_REMOTE_REQUEST_FAILED');
    expect(error?.message).toContain('stream failed: socket hang up');
  });
});
