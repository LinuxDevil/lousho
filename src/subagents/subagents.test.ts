import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import type { Message } from '../providers';
import type { SubagentCatalog } from './types';

const task = (agent: string, prompt: string, id?: string) => ({
  name: 'task',
  args: { agent, prompt, description: `${agent} task` },
  ...(id ? { id } : {}),
});

function toolMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => m.role === 'tool');
}

describe('subagents option and the task tool', () => {

  it('lists a dynamic catalog at the start of every run and resolves names on demand', async () => {
    const researcher = createAgent({ provider: mockModel(['found it'], { onExhausted: 'repeat-last' }) });
    const catalog: SubagentCatalog = {
      list: vi.fn(async () => [{ name: 'researcher', description: 'Looks things up' }]),
      resolve: vi.fn(async (name: string) => (name === 'researcher' ? researcher : undefined)),
    };
    const leadModel = mockModel([{ toolCalls: [task('researcher', 'look')] }, 'done', 'hi again']);
    const lead = createAgent({ provider: leadModel, subagents: catalog });

    const result = await lead.send('go');
    await lead.send('again');

    expect(catalog.list).toHaveBeenCalledTimes(2);
    expect(catalog.resolve).toHaveBeenCalledWith('researcher');
    expect(leadModel.calls[0].messages[0].content).toContain('- researcher: Looks things up');
    expect(toolMessages(result.messages)[0].content).toContain('found it');
  });

  it('gives the lead a structured error listing the valid names for an unknown sub-agent', async () => {
    const researcher = createAgent({ provider: mockModel(['x']), description: 'Researches' });
    const leadModel = mockModel([{ toolCalls: [task('nope', 'do it')] }, 'ok']);
    const lead = createAgent({ provider: leadModel, subagents: { researcher } });

    const result = await lead.send('go');

    const [toolResult] = toolMessages(result.messages);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain('researcher');
    expect(toolResult.content).toContain('nope');
  });

  it('gives the lead an error result saying why when a sub-agent runs out of steps', async () => {
    const looping = defineTool({ name: 'again', description: 'loops', input: z.object({}), execute: () => 'more' });
    const researcher = createAgent({
      provider: mockModel([{ text: 'still working', toolCalls: [{ name: 'again' }] }], { onExhausted: 'repeat-last' }),
      tools: [looping],
      maxSteps: 2,
      description: 'Researches',
    });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task('researcher', 'go')] }, 'ok']), subagents: { researcher } });

    const [toolResult] = toolMessages((await lead.send('go')).messages);

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("Sub-agent 'researcher' used all 2 of its steps");
    expect(toolResult.content).toContain('still working');
  });

  it('returns the valid object of a sub-agent that ran out of steps and answered in its forced final call', async () => {
    const looping = defineTool({ name: 'again', description: 'loops', input: z.object({}), execute: () => 'more' });
    const researcher = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'again' }] }, { toolCalls: [{ name: 'again' }] }, '{"n":42}']),
      tools: [looping],
      maxSteps: 2,
      output: z.object({ n: z.number() }),
      description: 'Researches',
    });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task('researcher', 'go')] }, 'ok']), subagents: { researcher } });

    const [toolResult] = toolMessages((await lead.send('go')).messages);
    const text = JSON.parse(toolResult.content as string) as string;

    expect(toolResult.isError).toBeFalsy();
    expect(text).toMatch(/^\{"n":42\}\n\n\[sub-agent 'researcher': \d+ step\(s\), finish reason 'max-steps'/);
    expect(text).toContain('ran out of steps');
    expect(text).not.toContain('without giving a final answer');
  });

  it("holds parallel sub-agents to the lead's maxCostUsd, shared, and keeps their results when it trips", async () => {
    // gpt-4o-mini: (1000 * 0.15 + 500 * 0.6) / 1e6 = $0.00045 a call.
    const usage = { inputTokens: 1000, outputTokens: 500 };
    const looping = defineTool({ name: 'again', description: 'loops', input: z.object({}), execute: () => 'more' });
    const researcher = createAgent({
      provider: mockModel([{ text: 'still working', toolCalls: [{ name: 'again' }], usage }], { defaultModel: 'gpt-4o-mini', onExhausted: 'repeat-last' }),
      tools: [looping],
      description: 'Researches',
    });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [task('researcher', 'a'), task('researcher', 'b')], usage }, '{"n":1}'], { defaultModel: 'gpt-4o-mini' }),
      subagents: { researcher },
      output: z.object({ n: z.number() }),
      limits: { maxCostUsd: 0.002 },
    });

    const result = await lead.send('go');

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toMatchObject({ limit: 'maxCostUsd', scope: 'run' });
    // Without the shared budget each child ran its 10 steps: 21 calls, $0.00945. Now at most one call per child over.
    expect(result.usage.costUsd).toBeLessThan(0.002 + 3 * 0.00045);
    // The children's results stay in the transcript: each says the lead's limit stopped it.
    const results = toolMessages(result.messages);
    expect(results).toHaveLength(2);
    for (const message of results) expect(message.content).toContain("stopped at the maxCostUsd limit (0.002)");
  });

  it('tells the lead when a sub-agent answer was cut off at the output token limit', async () => {
    const researcher = createAgent({
      provider: mockModel([{ text: 'The three causes are: first, the', finishReason: 'length' }]),
      description: 'Researches',
    });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task('researcher', 'go')] }, 'ok']), subagents: { researcher } });

    const [toolResult] = toolMessages((await lead.send('go')).messages);
    const text = JSON.parse(toolResult.content as string) as string;

    expect(toolResult.isError).toBeFalsy();
    expect(text).toContain('The three causes are: first, the');
    expect(text).toContain("finish reason 'length'");
    expect(text).toMatch(/cut off at the output token limit.*incomplete/);
  });

  it('subagentOptions.background: false offers only the task tool, without a background argument', async () => {
    const researcher = createAgent({ provider: mockModel(['found']), description: 'Researches' });
    const leadModel = mockModel([{ toolCalls: [task('researcher', 'go')] }, 'ok']);
    const lead = createAgent({ provider: leadModel, subagents: { researcher }, subagentOptions: { background: false } });

    const result = await lead.send('go');

    const request = leadModel.calls[0];
    expect(request.tools?.map((t) => t.function.name)).toEqual(['task']);
    expect(Object.keys((request.tools?.[0].function.parameters as unknown as { shape: object }).shape)).not.toContain('background');
    expect(request.messages[0].content).not.toContain('agent_await');
    expect(result.text).toBe('ok');
  });

  it('subagentOptions.continuation: false leaves taskId and mode out of the task tool and the prompt', async () => {
    const researcherModel = mockModel(['first', 'second']);
    const researcher = createAgent({ provider: researcherModel, description: 'Researches' });
    const leadModel = mockModel([{ toolCalls: [task('researcher', 'go')] }, { toolCalls: [task('researcher', 'again')] }, 'ok']);
    const lead = createAgent({ provider: leadModel, subagents: { researcher }, subagentOptions: { continuation: false } });

    const result = await lead.send('go');

    const request = leadModel.calls[0];
    const taskTool = request.tools?.find((t) => t.function.name === 'task');
    const args = Object.keys((taskTool?.function.parameters as unknown as { shape: object }).shape);
    expect(args).toEqual(expect.arrayContaining(['agent', 'prompt', 'background']));
    expect(args).not.toContain('taskId');
    expect(args).not.toContain('mode');
    expect(taskTool?.function.description).not.toContain('taskId');
    expect(request.messages[0].content).toContain('Available sub-agents');
    expect(request.messages[0].content).not.toContain('taskId');
    // Each call is a new task: the second child run does not see the first.
    expect(researcherModel.calls[1].messages.map((m) => m.content)).not.toContain('go');
    expect(toolMessages(result.messages).map((m) => m.content)).toEqual([expect.stringContaining("taskId 'task_1'"), expect.stringContaining("taskId 'task_2'")]);
  });

  it("resolves a dynamic sub-agent's config with the caller's metadata, principal and sessionId", async () => {
    const seen: unknown[] = [];
    const researcher = createAgent({
      description: 'Researches',
      provider: mockModel(['done'], { onExhausted: 'repeat-last' }),
      instructions: (ctx) => {
        seen.push({ metadata: ctx.metadata, principal: ctx.principal?.id, sessionId: ctx.sessionId, input: ctx.input });
        return `You serve ${ctx.principal?.id ?? '??'} on plan ${String(ctx.metadata?.plan ?? '??')}.`;
      },
    });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task('researcher', 'look into X')] }, 'final']), subagents: { researcher }, store: memoryStore() });

    await lead.send('go', {
      sessionId: 'lead-session',
      metadata: { plan: 'pro' },
      principal: { id: 'acme', type: 'user', authenticator: 'test' },
    });

    expect(seen).toEqual([{ metadata: { plan: 'pro' }, principal: 'acme', sessionId: 'lead-session', input: 'look into X' }]);
  });

  describe('configuration errors', () => {

    it('rejects a catalog that lists a name twice', async () => {
      const lead = createAgent({
        provider: mockModel(['x']),
        subagents: { list: () => [{ name: 'a', description: 'A' }, { name: 'a', description: 'A' }], resolve: () => undefined },
      });
      await expect(lead.send('go')).rejects.toThrow(/the name 'a' twice/);
    });
  });
});
