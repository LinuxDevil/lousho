import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { memoryStore } from '../storage/agentStore';
import { mockModel } from '../testing';
import { defineTool } from '../tools/defineTool';
import { defineSchedule } from './defineSchedule';
import { fireSchedule as fireScheduleFromIndex, type FireScheduleOptions } from '../index';
import { fireSchedule } from './fireSchedule';
import { startSchedules } from './startSchedules';

afterEach(() => { vi.restoreAllMocks(); });

const MINUTE = 60_000;

/** A fake clock: timers fire in order as `advance()` moves time forward; nothing sleeps. */
function fakeClock(startIso = '2026-01-01T00:00:00Z') {
  let now = Date.parse(startIso);
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    pending: () => timers.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.fn();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      now = target;
    },
  };
}

const every5 = { cron: '*/5 * * * *', timezone: 'UTC' };

describe('defineSchedule', () => {

  it('rejects an invalid cron expression with a coded error that names the field', () => {
    try {
      defineSchedule({ cron: '61 * * * *', prompt: 'hi' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SDKError);
      expect((error as SDKError).code).toBe('LOUSHO_SCHEDULE_INVALID');
      expect((error as SDKError).message).toContain('61');
    }
    expect(() => defineSchedule({ cron: '* * * *', prompt: 'hi' })).toThrow(/LOUSHO_SCHEDULE_INVALID/);
    expect(() => defineSchedule({ cron: '* * * * *', timezone: 'Mars/Olympus', prompt: 'hi' })).toThrow(/LOUSHO_SCHEDULE_INVALID/);
  });

  it('needs exactly one of prompt and run', () => {
    expect(() => defineSchedule({ cron: '@daily' } as never)).toThrow(/exactly one of 'prompt'/);
    expect(() => defineSchedule({ cron: '@daily', prompt: 'a', run: async () => undefined } as never)).toThrow(/LOUSHO_SCHEDULE_INVALID/);
    expect(() => defineSchedule({ cron: '@daily', prompt: '  ' })).toThrow(/LOUSHO_SCHEDULE_INVALID/);
  });
});

describe('startSchedules', () => {

  it('does not overlap a schedule with its own still-running previous fire', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const onError = vi.fn();
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, name: 'slow', run })], { ...clock, onError });

    await clock.advance(10 * MINUTE);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('skipped') }), { name: 'slow' });

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clock.advance(5 * MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    running.stop();
  });

  it('reports a prompt turn that pauses for approval as LOUSHO_SCHEDULE_RUN_INCOMPLETE, naming the approval', async () => {
    const tool = defineTool({ name: 'send_email', description: 'Sends', input: z.object({ to: z.string() }), needsApproval: true, execute: async () => 'sent' });
    const call = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_1' }] };
    const agent = createAgent({ provider: mockModel([call]), tools: [tool] });
    const onError = vi.fn();
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, name: 'mail', prompt: 'Email Sam.' })], { ...clock, onError });

    await clock.advance(5 * MINUTE);
    await running.stop();
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, schedule] = onError.mock.calls[0] as [SDKError, { name: string }];
    expect(schedule).toEqual({ name: 'mail' });
    expect(error).toBeInstanceOf(SDKError);
    expect(error.code).toBe('LOUSHO_SCHEDULE_RUN_INCOMPLETE');
    const [pending] = await agent.approvals.list();
    expect(error.detail).toContain('awaiting-approval');
    expect(error.detail).toContain(pending.id);
  });

  it("unrefs the default timers unless keepAlive is set", async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      const timer = real(fn, ms);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    const schedule = defineSchedule({ ...every5, run: async () => undefined });

    const detached = startSchedules(agent, [schedule]);
    const kept = startSchedules(agent, [schedule], { keepAlive: true });
    expect(timers.map((timer) => timer.hasRef())).toEqual([false, true]);
    await detached.stop();
    await kept.stop();
  });
});

describe('fireSchedule', () => {
  it('is exported and fires a schedule once, now, in the given session', async () => {
    expect(fireScheduleFromIndex).toBe(fireSchedule);
    const provider = mockModel(['done']);
    const store = memoryStore();
    const agent = createAgent({ provider, instructions: 'x', store });
    const options: FireScheduleOptions = { sessionId: 'ops-run' };
    await fireSchedule(agent, defineSchedule({ ...every5, prompt: 'Run now.' }), options);
    expect(provider.calls).toHaveLength(1);
    expect(JSON.stringify(provider.calls[0].messages)).toContain('Run now.');
    expect(JSON.stringify(await store.checkpoints?.load('ops-run'))).toContain('Run now.');

    const run = vi.fn(async () => undefined);
    const firedAt = new Date('2026-02-01T00:00:00Z');
    await fireSchedule(agent, defineSchedule({ ...every5, name: 'tick', run }), { firedAt });
    expect(run).toHaveBeenCalledWith({ agent, firedAt, name: 'tick' });
  });

  it('fires a tick once across replicas that share the store: the others skip it', async () => {
    const sent: string[] = [];
    const page = defineTool({ name: 'page', description: 'page', input: z.object({}), execute: async (_args, ctx) => (sent.push(ctx.toolCallId), 'paged') });
    const store = memoryStore();
    const replica = (name: string) =>
      createAgent({ provider: mockModel([{ toolCalls: [{ name: 'page', id: `call-${name}` }] }, 'done'], { onExhausted: 'repeat-last' }), tools: [page], store });
    const nightly = defineSchedule({ name: 'nightly', cron: '0 3 * * *', prompt: 'Page if needed.' });
    const firedAt = new Date('2026-10-10T03:00:00Z');
    const run = vi.fn(async () => undefined);
    const report = defineSchedule({ name: 'report', cron: '0 3 * * *', run });

    await Promise.all([fireSchedule(replica('A'), nightly, { firedAt }), fireSchedule(replica('B'), nightly, { firedAt })]);
    await Promise.all([fireSchedule(replica('A'), report, { firedAt }), fireSchedule(replica('B'), report, { firedAt })]);

    expect(sent).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    // The next tick fires again.
    await fireSchedule(replica('C'), nightly, { firedAt: new Date('2026-10-11T03:00:00Z') });
    expect(sent).toHaveLength(2);
    // Two schedules whose names differ only in characters an id cannot hold are claimed apart.
    const spaced = vi.fn(async () => undefined);
    const dashed = vi.fn(async () => undefined);
    await fireSchedule(replica('D'), defineSchedule({ name: 'daily report', cron: '0 3 * * *', run: spaced }), { firedAt });
    await fireSchedule(replica('D'), defineSchedule({ name: 'daily-report', cron: '0 3 * * *', run: dashed }), { firedAt });
    expect([spaced.mock.calls.length, dashed.mock.calls.length]).toEqual([1, 1]);
  });
});
