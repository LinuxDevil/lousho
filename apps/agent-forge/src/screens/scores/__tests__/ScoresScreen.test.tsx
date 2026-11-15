import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

import type { ObserveScorePassRate, ObserveScoreRow } from '../../../observe/types';
import { render } from '../../../ui/__tests__/render';
import { ScoresScreen } from '../ScoresScreen';
import { groupEvalScores, scoreStats, summarizeRates,  } from '../scoresData';

const NOW = Date.UTC(2026, 9, 25, 12, 30);
const DAY = 86_400_000;

let seq = 0;
function score(over: Partial<ObserveScoreRow> & { name: string }): ObserveScoreRow {
  seq += 1;
  return {
    score_id: `s${seq}`,
    trace_id: `t${seq}`,
    obs_id: null,
    value: 1,
    source: 'eval',
    comment: null,
    agent_id: 'a1',
    created_at: NOW - DAY,
    ...over,
  };
}

const RATES: ObserveScorePassRate[] = [
  { name: 'support', count: 6, passed: 4, pass_rate: 4 / 6, avg_value: 0.67, last_ts: NOW - 1000 },
  { name: 'billing', count: 2, passed: 2, pass_rate: 1, avg_value: 1, last_ts: NOW - DAY },
];

const SUPPORT_ROWS: ObserveScoreRow[] = [
  score({ name: 'support', value: 1, created_at: NOW - 3 * DAY }),
  score({ name: 'support/tone', value: 1, created_at: NOW - 3 * DAY }),
  score({ name: 'support/refund', value: 1, created_at: NOW - 3 * DAY }),
  score({ name: 'support', value: 0, comment: 'refund', created_at: NOW - 1000, trace_id: 'trace-fail', obs_id: 'obs-9' }),
  score({ name: 'support/tone', value: 1, created_at: NOW - 1000 }),
  score({ name: 'support/refund', value: 0, comment: 'expected a refund link', created_at: NOW - 1000, trace_id: 'trace-fail' }),
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stand-in daemon behind `/observe`; `down` fails every request like a refused connection. */
function daemon() {
  const state: { down: boolean; hold?: Promise<void> } = { down: false };
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    if (state.down) throw new TypeError('fetch failed');
    const url = String(input);
    const q = new URL(url, 'http://x').searchParams;
    if (url.startsWith('/observe/health')) return json(200, { service: 'lousho-observe', ok: true });
    if (url.startsWith('/observe/__target')) return json(200, { url: 'http://127.0.0.1:7777' });
    if (url.startsWith('/observe/api/v1/agents')) return json(200, { agents: [{ agent_id: 'a1', name: 'Support bot' }] });
    if (url.startsWith('/observe/api/v1/scores') && q.get('aggregate') === 'eval') return json(200, { evals: RATES });
    if (url.startsWith('/observe/api/v1/scores') && state.hold) await state.hold;
    if (url.startsWith('/observe/api/v1/scores')) return json(200, { scores: q.get('eval') === 'support' ? SUPPORT_ROWS : [] });
    return json(404, { error: `unexpected ${url}` });
  });
  vi.stubGlobal('fetch', fetchFn);
  const calls = (match: string) => fetchFn.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(match));
  return { state, calls };
}

async function waitFor(check: () => boolean, turns = 50) {
  for (let i = 0; !check(); i++) {
    if (i > turns) throw new Error('waitFor gave up');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const evalRow = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('.data-table tbody tr, table tbody tr')].find((tr) =>
    tr.querySelector('.scores-toggle')?.textContent?.includes(name),
  ) as HTMLElement | undefined;
const detail = (c: HTMLElement) => c.querySelector('[data-eval]') as HTMLElement | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  window.history.replaceState(null, '', '/#/evals/scores');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('scoresData', () => {

  it('eval and judge pass without a failure comment; human and online pass only on a value of 1', () => {
    const rows = (source: string) => [
      score({ name: 'x', source, value: 1 }),
      score({ name: 'x', source, value: 0 }),
      score({ name: 'x', source, value: 0.9 }),
      score({ name: 'x', source, value: null }),
      score({ name: 'x', source, value: 0, comment: 'check failed' }),
    ];
    for (const source of ['human', 'online']) expect(scoreStats(rows(source)).passRate).toBeCloseTo(1 / 5);
    // eval and judge write a comment only on failure: no comment passes, whatever the value.
    for (const source of ['eval', 'judge']) expect(scoreStats(rows(source)).passRate).toBeCloseTo(4 / 5);
    expect(groupEvalScores('x', rows('online')).failures.map((r) => r.value)).toEqual([0, 0.9, null, 0]);
    expect(groupEvalScores('x', rows('judge')).failures.map((r) => r.comment)).toEqual(['check failed']);
  });

  it('summarizes the per-eval aggregate for the metric cards (count-weighted mean)', () => {
    expect(summarizeRates(RATES)).toEqual({ evals: 2, scores: 8, passRate: 6 / 8, mean: (0.67 * 6 + 1 * 2) / 8 });
    expect(summarizeRates([{ ...RATES[0]!, avg_value: null }])).toMatchObject({ evals: 1, mean: null });
    expect(summarizeRates([])).toEqual({ evals: 0, scores: 0, passRate: null, mean: null });
  });
});

describe('ScoresScreen', () => {

  it('shows the loading state, not the previous eval, while a newly opened eval loads', async () => {
    window.history.replaceState(null, '', '/#/evals/scores?open=support');
    const { state } = daemon();
    const c = render(<ScoresScreen />);
    await waitFor(() => detail(c)?.querySelector('[data-eval-runs]') != null);
    let release = () => {};
    state.hold = new Promise((r) => (release = r));
    act(() => (evalRow(c, 'billing')!.querySelector('.scores-toggle') as HTMLButtonElement).click());
    await waitFor(() => detail(c)?.getAttribute('data-eval') === 'billing', 5);
    expect(detail(c)!.textContent).toContain('Loading billing...');
    expect(detail(c)!.querySelector('[data-eval-runs]')).toBeNull();
    state.hold = undefined;
    release();
    await waitFor(() => detail(c)?.querySelector('[data-eval-runs]') != null);
    expect(detail(c)!.textContent).toContain('0 runs');
  });

  it('round-trips the filters through the URL and queries with them', async () => {
    window.history.replaceState(null, '', '/#/evals/scores?eval=billing&agent=a1&source=human&range=7d');
    const { calls } = daemon();
    const c = render(<ScoresScreen />);
    await waitFor(() => evalRow(c, 'billing') !== undefined);
    expect(evalRow(c, 'support')).toBeUndefined();
    const call = calls('aggregate=eval').at(-1)!;
    expect(call).toContain('agent_id=a1');
    expect(call).toContain('source=human');
    expect(call).toContain(`since=${NOW - 7 * DAY}`);
    expect(c.querySelector('.time-range [aria-pressed="true"]')?.textContent).toBe('7d');

    const preset = (label: string) =>
      [...c.querySelectorAll('.time-range button')].find((b) => b.textContent === label) as HTMLButtonElement;
    act(() => preset('30d').click());
    expect(window.location.hash).toBe('#/evals/scores?eval=billing&agent=a1&source=human');
    act(() => preset('24h').click());
    expect(window.location.hash).toBe('#/evals/scores?eval=billing&agent=a1&source=human&range=24h');
    await waitFor(() => calls(`since=${NOW - DAY}`).length > 0);
  });

  it('shows the daemon-down state with the URL kept and recovers in place', async () => {
    window.history.replaceState(null, '', '/#/evals/scores?range=7d&open=support');
    const { state } = daemon();
    state.down = true;
    const c = render(<ScoresScreen />);
    await waitFor(() => c.textContent!.includes('lousho observe start'));
    expect(window.location.hash).toBe('#/evals/scores?range=7d&open=support');

    state.down = false;
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await waitFor(() => detail(c)?.querySelector('[data-eval-runs]') != null);
    expect(c.textContent).not.toContain('lousho observe start');
    expect(window.location.hash).toBe('#/evals/scores?range=7d&open=support');
  });
});
