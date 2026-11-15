/**
 * An abort ends the run 'aborted' even when the provider or a
 * tool ignores the signal, mockModel honours the signal, and the result says
 * why it was aborted (`abortReason`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';

describe('abort with a provider that ignores the signal', () => {

  it('a tool that never settles does not hold an aborted run open', async () => {
    const controller = new AbortController();
    let release!: (value: string) => void;
    const wedged = defineTool({
      name: 'wedged',
      description: 'wedged',
      input: z.object({}),
      execute: () => {
        controller.abort();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });
    const model = mockModel([{ toolCalls: [{ name: 'wedged' }] }, 'done']);
    const started = Date.now();
    const result = await createAgent({ provider: model, tools: [wedged] }).send('go', { signal: controller.signal });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.finishReason).toBe('aborted');
    expect(result.abortReason?.name).toBe('AbortError');
    expect(model.calls).toHaveLength(1);
    // The transcript stays well-formed: the unanswered call has a cancelled result.
    const toolMessages = result.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(JSON.parse(String(toolMessages[0].content))).toMatchObject({ kind: 'not-run' });

    // A wedged tool that settles after the run ended is not recorded on top of it.
    release('too late');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('a wedged approved tool does not hold a resume open on abort', async () => {
    const controller = new AbortController();
    const wedged = defineTool({
      name: 'wedged',
      description: 'wedged',
      input: z.object({}),
      needsApproval: true,
      execute: () => {
        controller.abort();
        return new Promise<string>(() => {});
      },
    });
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'wedged' }] }, 'done']), tools: [wedged] });
    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');

    const started = Date.now();
    const resumed = await agent.approvals.resolve({ id: paused.approvalId!, approved: true }, { signal: controller.signal });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(resumed.finishReason).toBe('aborted');
    expect(resumed.abortReason?.name).toBe('AbortError');
    // The decided call still has a result, so the transcript stays well-formed.
    expect(resumed.messages.some((m) => m.role === 'tool')).toBe(true);
  });
});

describe('abortReason', () => {
  it('tells a timeout from a cancel and keeps a string reason', async () => {
    const agent = createAgent({ provider: mockModel([{ text: 'x', delayMs: 500 }], { onExhausted: 'repeat-last' }) });

    const cancelled = new AbortController();
    setTimeout(() => cancelled.abort('user left'), 20);
    expect((await agent.send('go', { signal: cancelled.signal })).abortReason).toEqual({ name: 'AbortError', message: 'user left' });

    const plain = new AbortController();
    setTimeout(() => plain.abort(), 20);
    expect((await agent.send('go', { signal: plain.signal })).abortReason?.name).toBe('AbortError');

    expect((await agent.send('go', { signal: AbortSignal.timeout(20) })).abortReason?.name).toBe('TimeoutError');
  });
});
