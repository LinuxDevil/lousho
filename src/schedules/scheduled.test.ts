import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { mockModel } from '../testing';
import { handleWorkerScheduled } from '../deploy/runtime.worker';
import { defineSchedule } from './defineSchedule';
import { handleScheduled } from './scheduled';
import { specSchedules } from './specSchedules';

function ctx() {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (promise: Promise<unknown>) => void promises.push(promise) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('handleScheduled', () => {

  it('runs every schedule sharing the expression and isolates a failing one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ran: string[] = [];
    const agent = createAgent({ provider: mockModel(['ok']), prompt: 'x' });
    const schedules = [
      defineSchedule({ name: 'bad', cron: '0 * * * *', run: async () => Promise.reject(new SDKError('boom', 'LOUSHO_TEST')) }),
      defineSchedule({ name: 'good', cron: '0 * * * *', run: async ({ name }) => void ran.push(name) }),
    ];
    await expect(handleScheduled(agent, schedules, { cron: '0 * * * *' }, ctx())).resolves.toBeUndefined();
    expect(ran).toEqual(['good']);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toContain("'bad'");
    expect(String(error.mock.calls[0][0])).toContain('LOUSHO_TEST');
  });
});

describe('specSchedules', () => {

  it('names the trigger in the error for a missing or invalid field', () => {
    expect(() => specSchedules([{ type: 'cron', name: 'x', input: 'hi' }])).toThrow(/trigger 'x'.*'cron'/);
    expect(() => specSchedules([{ type: 'cron', name: 'y', cron: '* * * * *' }])).toThrow(/trigger 'y'.*'input'/);
    expect(() => specSchedules([{ type: 'cron', name: 'z', cron: '61 * * * *', input: 'hi' }])).toThrow(/trigger 'z'/);
  });
});

describe('handleWorkerScheduled', () => {
  const spec = {
    name: 'w',
    prompt: 'p',
    provider: { type: 'mock', model: 'mock-1' },
    triggers: [{ type: 'cron', name: 'tick', cron: '*/5 * * * *', input: 'tick' }],
  };

  it('does nothing for a cron no trigger declares', async () => {
    const context = ctx();
    await handleWorkerScheduled({ cron: '1 1 * * *' }, {}, context, spec);
    expect(context.promises).toHaveLength(1);
  });

  it('logs instead of throwing when the agent cannot be built', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      handleWorkerScheduled({ cron: '*/5 * * * *' }, {}, ctx(), { ...spec, tools: ['web-fetch'] })
    ).resolves.toBeUndefined();
    expect(String(error.mock.calls[0][0])).toContain('*/5 * * * *');
  });
});
