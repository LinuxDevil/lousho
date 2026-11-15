/**
 * approvalDeadline.ts's deadline table: the earliest bound that is set
 * (the SDK pause's `expiresAt`, the run's own end at
 * `runStartedAt + maxDurationMs`), DEFAULT_DEADLINE_MS when neither is,
 * and never sooner than `now + MIN_DEADLINE_MS` even when a bound is
 * already past.
 */
import { describe, it, expect } from 'vitest';
import { approvalDeadline,  } from '../approvalDeadline';

const NOW = 1_760_000_000_000;
const runStartedAt = NOW - 5_000;

describe('approvalDeadline', () => {
  it.each([
    {
      name: 'run limit earlier than the TTL: the run limit wins',
      input: {
        now: NOW,
        expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
        runStartedAt,
        maxDurationMs: 65_000,
      },
      expectedMs: runStartedAt + 65_000,
    },
  ])('$name', ({ input, expectedMs }) => {
    expect(approvalDeadline(input)).toBe(new Date(expectedMs).toISOString());
  });

  it('minDeadlineMs overrides the floor (RunManager injects it in tests)', () => {
    expect(
      approvalDeadline({ now: NOW, expiresAt: new Date(NOW + 10).toISOString(), runStartedAt, minDeadlineMs: 50 })
    ).toBe(new Date(NOW + 50).toISOString());
  });
});
