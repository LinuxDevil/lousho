import { describe, expect, it } from 'vitest';
import { triggersFromSpec } from './triggers';

describe('triggersFromSpec', () => {
  it('turns each cron trigger into a schedule named after the trigger id', () => {
    const { schedules, notStarted } = triggersFromSpec([
      { id: 'daily', type: 'cron', cron: '0 9 * * *', timezone: 'Europe/Paris', prompt: 'Report.', sharedSession: true },
      { id: 'hourly', type: 'cron', cron: '0 * * * *', prompt: 'Check the queue.' },
    ]);
    expect(notStarted).toEqual([]);
    expect(schedules.map((s) => [s.name, s.cron, s.prompt])).toEqual([
      ['daily', '0 9 * * *', 'Report.'],
      ['hourly', '0 * * * *', 'Check the queue.'],
    ]);
    expect(schedules[0]).toMatchObject({ timezone: 'Europe/Paris', sharedSession: true });
    expect(schedules[1].sharedSession).toBeUndefined();
  });

  it('ignores a chat trigger silently and an absent list entirely', () => {
    expect(triggersFromSpec([{ id: 'pane', type: 'chat' }])).toEqual({ schedules: [], notStarted: [] });
    expect(triggersFromSpec(undefined)).toEqual({ schedules: [], notStarted: [] });
    expect(triggersFromSpec([])).toEqual({ schedules: [], notStarted: [] });
  });
});
