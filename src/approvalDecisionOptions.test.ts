/**
 * `ApprovalDecision.remember` ("don't ask again") and `args`
 * ("approve with edits"), and `once()` remembering only a human's approval.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { once } from './tools/approvalPolicies';
import { mockModel, type MockTurn } from './testing';
import type { ApprovalOutcome } from './types';

const email = (to: string, id: string): MockTurn => ({ toolCalls: [{ name: 'send_email', args: { to }, id }] });

function emailTool(needsApproval: boolean | ((args: unknown, ctx: never) => ApprovalOutcome) = true) {
  const sent: string[] = [];
  const tool = defineTool({
    name: 'send_email',
    description: 'Sends an email',
    input: z.object({ to: z.string().email() }),
    needsApproval: needsApproval as never,
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  });
  return { tool, sent };
}

describe('once() and a non-human approve callback', () => {
  it("asks the callback again for each call: its yes is not remembered", async () => {
    const { tool, sent } = emailTool(once());
    const approve = vi.fn(() => true);
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), email('b@x.io', 'c2'), 'done']), tools: [tool], approve });
    const result = await agent.session({ id: 's' }).send('go');
    expect(result.text).toBe('done');
    expect(sent).toEqual(['a@x.io', 'b@x.io']);
    expect(approve).toHaveBeenCalledTimes(2);
  });
});

describe("ApprovalDecision.remember: 'session'", () => {
  it('approves later identical calls in the session without asking; other arguments still ask', async () => {
    const { tool, sent } = emailTool(true);
    const model = mockModel([email('a@x.io', 'c1'), 'first', email('a@x.io', 'c2'), 'second', email('b@x.io', 'c3'), 'third']);
    const agent = createAgent({ provider: model, tools: [tool] });
    const session = agent.session({ id: 's' });

    const paused = await session.send('mail a');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true, remember: 'session' })).text).toBe('first');

    const again = await session.send('mail a again');
    expect(again.finishReason).toBe('stop');
    expect(again.text).toBe('second');
    expect(sent).toEqual(['a@x.io', 'a@x.io']);

    const other = await session.send('mail b');
    expect(other.finishReason).toBe('awaiting-approval');
    expect(sent).toEqual(['a@x.io', 'a@x.io']);
  });
});

describe('ApprovalDecision.args: approve with edits', () => {

  it('refuses arguments the schema rejects and leaves the approval pending', async () => {
    const { tool, sent } = emailTool(true);
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), 'done']), tools: [tool] });
    const paused = await agent.send('mail');
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true, args: { to: 'not-an-email' } })).rejects.toMatchObject({
      code: 'LOUSHO_TOOL_ARGS_INVALID',
    });
    expect(sent).toEqual([]);
    expect((await agent.approvals.list()).map((entry) => entry.id)).toEqual([paused.approvalId]);
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true, args: { to: 'ok@x.io' } });
    expect(result.text).toBe('done');
    expect(sent).toEqual(['ok@x.io']);
  });
});
