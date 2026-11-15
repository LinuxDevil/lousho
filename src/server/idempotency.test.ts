/**
 * `POST /chat` with an `Idempotency-Key`: a client that resends a turn
 * (a retry after a dropped connection, a double submit, a restart) gets that
 * turn's outcome instead of a second turn with the same side effects.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { createRouteHandler } from './routeHandler';

const post = (body: unknown, key?: string) =>
  new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key !== undefined && { 'idempotency-key': key }) },
    body: JSON.stringify(body),
  });

async function events(response: Response): Promise<Array<Record<string, unknown> & { type: string }>> {
  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

const doneText = async (response: Response) => (await events(response)).find((event) => event.type === 'run.done')?.text;

function desk(script: readonly MockTurn[], store: AgentStore = memoryStore(), crashOnce = false) {
  const refunds: string[] = [];
  let runs = 0;
  const refund = defineTool({
    name: 'issue_refund',
    description: 'Refunds an order',
    input: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => {
      runs += 1;
      if (crashOnce && runs === 1) throw new PropagatingToolError('process died while refunding');
      refunds.push(orderId);
      return 'refunded';
    },
  });
  const model = mockModel(script);
  const agent = createAgent({ provider: model, tools: [refund], store });
  return { agent, model, refunds, store, ...createRouteHandler(agent, { basePath: '/api' }) };
}

const refundTurn: MockTurn[] = [{ toolCalls: [{ name: 'issue_refund', args: { orderId: 'B-1' } }] }, 'Refund issued.'];

const userMessages = async (store: AgentStore, id: string) => ((await store.sessions!.load(id)) ?? []).filter((message) => message.role === 'user');

describe('POST /chat with an Idempotency-Key', () => {

  it('is a 409 while the same key is still running its turn', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { handler, model } = desk([
      async () => {
        await slow;
        return 'Done.';
      },
    ]);
    const first = await handler(post({ sessionId: 'k-3', input: 'hi' }, 'dup'));
    const firstEvents = events(first);

    const double = await handler(post({ sessionId: 'k-3', input: 'hi' }, 'dup'));
    expect(double.status).toBe(409);
    expect(await double.json()).toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });

    release();
    expect((await firstEvents).find((event) => event.type === 'run.done')?.text).toBe('Done.');
    expect(model.calls).toHaveLength(1);
    // Once it finished, the same key replays.
    expect(await doneText(await handler(post({ sessionId: 'k-3', input: 'hi' }, 'dup')))).toBe('Done.');
  });

  it('resumes a turn a crash interrupted, without appending the message again or re-running finished steps', async () => {
    const store = memoryStore();
    const crashed = desk(refundTurn, store, true);
    const failed = await events(await crashed.handler(post({ sessionId: 'k-5', input: 'Refund B-1' }, 'req-5')));
    expect(failed.some((event) => event.type === 'error')).toBe(true);
    expect(await crashed.agent.session({ id: 'k-5' }).pending()).toMatchObject({ status: 'in-progress', idempotencyKey: 'req-5' });

    const restarted = desk(['Refund issued.'], store);
    const resumed = await events(await restarted.handler(post({ sessionId: 'k-5', input: 'Refund B-1' }, 'req-5')));
    expect(resumed.find((event) => event.type === 'run.done')).toMatchObject({ text: 'Refund issued.', finishReason: 'stop' });
    expect(restarted.refunds).toEqual(['B-1']);
    expect(restarted.model.calls).toHaveLength(1);
    expect(await userMessages(store, 'k-5')).toHaveLength(1);
    expect(await restarted.agent.session({ id: 'k-5' }).pending()).toBeNull();
  });
});
