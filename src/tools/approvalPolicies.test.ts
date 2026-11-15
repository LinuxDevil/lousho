/**
 * `needsApproval` outcomes ('approve' | 'deny' | 'ask' | { deny })
 * and the always() / never() / once() helpers.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from './defineTool';
import { always, never, once } from './approvalPolicies';
import { allow } from '../execution/permissions';
import { mockModel, type MockModel, type MockTurn } from '../testing';
import type { DefineToolOptions } from './defineTool';

type Policy = DefineToolOptions<z.ZodObject<{ value: z.ZodOptional<z.ZodString> }>, string>['needsApproval'];

/** A `deploy` tool with the given `needsApproval`, recording the values it ran with. */
function deployTool(needsApproval: Policy) {
  const ran: Array<string | undefined> = [];
  const defined = defineTool({
    name: 'deploy',
    description: 'Deploy',
    input: z.object({ value: z.string().optional() }),
    needsApproval,
    execute: async ({ value }) => {
      ran.push(value);
      return 'deployed';
    },
  });
  return { defined, ran };
}

const call = (value?: string): MockTurn => ({ toolCalls: [{ name: 'deploy', args: value === undefined ? {} : { value } }] });

/** The tool results the model saw on its `n`-th call, parsed. */
function toolResults(model: MockModel, n = 1): Array<Record<string, unknown>> {
  return model.calls[n].messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content)) as Record<string, unknown>);
}

describe('needsApproval outcomes', () => {

  it("'deny' denies without a reason, 'approve' runs, 'ask' pauses", async () => {
    const outcome = { value: 'deny' as 'deny' | 'approve' | 'ask' };
    const deploy = deployTool(() => outcome.value);
    const model = mockModel([call('a'), 'denied', call('b'), 'ran', call('c')]);
    const agent = createAgent({ provider: model, tools: [deploy.defined] });

    await agent.send('go');
    expect(toolResults(model)[0]).toMatchObject({ kind: 'denied', message: "Tool 'deploy' was denied by its needsApproval policy" });
    outcome.value = 'approve';
    expect((await agent.send('go')).text).toBe('ran');
    outcome.value = 'ask';
    expect((await agent.send('go')).finishReason).toBe('awaiting-approval');
    expect(deploy.ran).toEqual(['b']);
  });

  it('always() and never() are needsApproval true and false', async () => {
    expect(always()).toBe(true);
    expect(never()).toBe(false);
    const deploy = deployTool(never());
    const agent = createAgent({ provider: mockModel([call(), 'done']), tools: [deploy.defined] });
    expect((await agent.send('go')).text).toBe('done');
  });
});

describe('once()', () => {

  it("per: 'args' remembers approvals per arguments", async () => {
    const deploy = deployTool(once({ per: 'args' }));
    const agent = createAgent({ provider: mockModel([call('a'), call('a'), call('b')]), tools: [deploy.defined] });

    const first = await agent.send('go');
    const second = await agent.approvals.resolve({ id: first.approvalId!, approved: true });

    expect(deploy.ran).toEqual(['a', 'a']);
    expect(second.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.list())[0].args).toEqual({ value: 'b' });
  });
});

describe('precedence with permissions', () => {

  it("with no matching rule, the tool's outcome applies", async () => {
    const deploy = deployTool(() => ({ deny: 'Not today' }));
    const model = mockModel([call(), 'ok']);
    const agent = createAgent({ provider: model, tools: [deploy.defined], permissions: [allow('other_tool')] });

    await agent.send('go');

    expect(toolResults(model)[0]).toMatchObject({ kind: 'denied', reason: 'Not today' });
  });
});
