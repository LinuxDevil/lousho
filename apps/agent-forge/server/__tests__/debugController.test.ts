import { describe, it, expect } from 'vitest';
import { DebugSession, llmBreakpointKey } from '../debugController';

describe('DebugSession', () => {

  it('step() arms a one-shot pause at the next hook boundary regardless of breakpoints', async () => {
    const session = new DebugSession([], () => {});
    session.step();
    const hookPromise = session.agentHooks()[0].preGenerate?.({ messages: [], request: { model: 'x', messages: [] } });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.snapshot().paused).toBe(true);
    session.continue();
    await hookPromise;

    // Step is one-shot: the next hook call does NOT pause again.
    const secondPromise = session.agentHooks()[0].postGenerate?.({ messages: [], request: { model: 'x', messages: [] } }, {} as any);
    await secondPromise;
    expect(session.snapshot().paused).toBe(false);
  });

  it('auto-resumes (and flags autoResumed) if nobody continues/steps before pauseTimeoutMs elapses', async () => {
    const states: Array<{ paused: boolean; autoResumed?: boolean }> = [];
    // A tiny pauseTimeoutMs stands in for an abandoned pause (e.g. the only
    // WS client disconnected) - this is the safety net that stops a run
    // staying paused forever with no way to resume it.
    const session = new DebugSession([llmBreakpointKey('before')], (s) => states.push({ paused: s.paused, autoResumed: s.autoResumed }), 15);

    const hookPromise = session.agentHooks()[0].preGenerate?.({ messages: [], request: { model: 'x', messages: [] } });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.snapshot().paused).toBe(true);

    // Nobody calls continue()/step() - just wait past the timeout.
    await hookPromise;
    expect(session.snapshot().paused).toBe(false);
    expect(states.at(-1)).toEqual({ paused: false, autoResumed: true });
  });
});
