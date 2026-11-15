import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../observe/alerts';
import type { IngestEvent } from '../observe/envelope';
import { ingestBatch, openDb } from '../observe/store';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { mockModel, type MockRequest } from '../testing';
import { appendAudit, readAudit } from './audit';
import { readCorpus } from './corpus';
import { readCycles } from './cycles';
import { healOnce, type HealOptions } from './heal';
import { checkApplied } from './monitor';
import { currentRevision } from './revisions';
import { loadImproveSettings, type ImproveSettings } from './settings';
import { updateState } from './state';
import { readCanary } from './trafficCanary';
import type { Harness } from './types';
import { isDefinedSchedule } from '../schedules/defineSchedule';
import { readWatchers, registerWatcher } from './watchers';
import { improveSchedule, watchAgent, watchContext, watchTick, type WatchOptions } from './watch';

vi.mock('./heal', async (original) => {
  const actual = await original<typeof import('./heal')>();
  return { ...actual, healOnce: vi.fn(actual.healOnce) };
});

vi.mock('./monitor', async (original) => {
  const actual = await original<typeof import('./monitor')>();
  return { ...actual, checkApplied: vi.fn(actual.checkApplied) };
});

const BASE = 'You answer refund questions.';
const FIX = 'You answer refund questions. If a document is forbidden, say so and stop.';
const T0 = Date.now() - 60_000;

let root: string;
let dir: string;
let db: SqlDatabase;
let traces = 0;

const systemOf = (request: MockRequest): string => String(request.messages.find((message) => message.role === 'system')?.content ?? '');

const editor = () =>
  mockModel(
    [
      (request) => {
        if (systemOf(request).includes('finished attempt to improve')) return 'NO_ENTRY';
        if (request.messages.at(-1)?.role === 'tool') return '<notes>Traced to a failed run.</notes>';
        return { toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content: FIX } }] };
      },
    ],
    { onExhausted: 'repeat-last' }
  );

const answers = (harness: Harness): string => (harness.instructions.includes('forbidden') ? 'ok, that is forbidden' : 'here is the doc');
const runCase: HealOptions['runCase'] = async (harness, input) => ({ answer: input.includes('refund window') ? 'five days' : answers(harness), transcript: `assistant: ${answers(harness)}`, tokens: 10, ended: 'stop' });
const check: HealOptions['check'] = (input, answer) => input.includes('refund window') || answer.startsWith('ok');

function root_(trace: string, input: string, start = T0): IngestEvent {
  return {
    type: 'observation',
    data: { obs_id: `r-${trace}`, trace_id: trace, agent_id: 'support', kind: 'span', name: 'invoke_agent support', start, end: start + 9, status: 'ok', input, output: 'done', attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.harness.revision': currentRevision(dir) } },
  };
}

function seedFailures(count = 3): void {
  const events = Array.from({ length: count }, (): IngestEvent[] => {
    const trace = `t${traces++}`;
    const at = Date.now() + traces;
    return [
      root_(trace, '"can I read the secret doc?"', at),
      {
        type: 'observation',
        data: { obs_id: `x-${trace}`, trace_id: trace, parent_obs_id: `r-${trace}`, agent_id: 'support', kind: 'tool', name: 'execute_tool lookup', start: at, end: at + 5, status: 'error', attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', error: 'HTTP 403 Forbidden' } },
      },
    ];
  }).flat();
  ingestBatch(db, events);
}

function settings(over: Partial<ImproveSettings> = {}): ImproveSettings {
  return { ...loadImproveSettings(dir, {}, {}), library: { enabled: false }, ...over };
}

const options = (over: Partial<WatchOptions> = {}): WatchOptions => ({ dir, db, check, runCase, editor: { provider: editor() }, settings: settings(), agent: 'support', log: () => undefined, ...over });

const tick = (over: Partial<WatchOptions> = {}, context = watchContext(options(over))) => watchTick(options(over), context);

const actions = () => readAudit(dir).map((entry) => entry.action);
const stop = () => {
  mkdirSync(path.join(dir, '.lousho'), { recursive: true });
  writeFileSync(path.join(dir, '.lousho', 'improve.stop'), 'maintenance\n');
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lousho-watch-'));
  dir = path.join(root, 'support');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'instructions.md'), `${BASE}\n`);
  db = openDb(path.join(root, 'observe.db'));
  ingestBatch(db, [root_('p1', '"what is the refund window?"')]);
});

afterEach(() => {
  db.close();
  vi.mocked(healOnce).mockClear();
  vi.mocked(checkApplied).mockClear();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('watchTick', () => {

  it('LOUSHO_IMPROVE=off and enabled false pause it too', async () => {
    vi.stubEnv('LOUSHO_IMPROVE', 'off');
    expect((await tick()).state).toBe('paused');
    vi.unstubAllEnvs();
    expect((await tick({ settings: settings({ enabled: false }) })).state).toBe('paused');
    expect(actions()).toEqual(['pause']);
  });

  it('cooldown after rollback blocks cycles', async () => {
    seedFailures();
    await updateState(dir, { cooldownUntil: new Date(Date.now() + 3_600_000).toISOString() });
    const result = await tick();
    expect(result.reason).toMatch(/cooldown/);
    expect(healOnce).not.toHaveBeenCalled();
  });

  it('same signatures twice skip the second cycle', async () => {
    const context = watchContext(options());
    const manual = settings({ approval: 'manual', trigger: { minNewFailures: 3, requireRecurring: false } });
    seedFailures();
    expect((await watchTick(options({ settings: manual }), context)).cycle?.outcome).toBe('pending');
    expect((await watchTick(options({ settings: manual }), context)).state).toBe('deduped');
    expect(healOnce).toHaveBeenCalledTimes(1);
  });

  it('three outages in a row pause it with an audit entry', async () => {
    const context = watchContext(options());
    const down: HealOptions['runCase'] = async () => {
      throw new Error('provider down');
    };
    seedFailures();
    for (let i = 0; i < 3; i++) expect((await watchTick(options({ runCase: down, settings: settings({ trigger: { minNewFailures: 3, requireRecurring: true } }) }), context, 'manual')).cycle?.outcome).toBe('outage');
    expect(existsSync(path.join(dir, '.lousho', 'improve.stop'))).toBe(true);
    expect(actions()).toEqual(['pause']);
    expect((await watchTick(options({ runCase: down }), context)).state).toBe('paused');
    expect(actions()).toEqual(['pause']);
  });

  it('renews its lease while a long tick runs, so a second watcher stays out', async () => {
    seedFailures();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: HealOptions['runCase'] = async (harness, input) => {
      await gate;
      return runCase(harness, input);
    };
    const short = { intervalMs: 30 };
    const first = watchTick(options({ ...short, runCase: slow }), watchContext(options(short)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await watchTick(options(short), watchContext(options(short)))).state).toBe('leased');
    release();
    expect((await first).cycle?.outcome).toBe('applied');
  });

  it('runs the corpus guard once guard.everyHours have passed', async () => {
    const context = watchContext(options());
    seedFailures();
    const first = await watchTick(options({ protect: ['p1'] }), context);
    expect(first.cycle?.outcome).toBe('applied');
    expect(first.guard).toBeUndefined();
    const second = await watchTick(options(), context);
    expect(second.guard).toMatchObject({ passed: true });
    expect((await watchTick(options(), context)).guard).toBeUndefined();
  });

  it('adds the cases a kept edit fixed to the corpus once the monitor keeps it, once', async () => {
    const context = watchContext(options());
    seedFailures();
    const applied = await watchTick(options(), context);
    expect(applied.cycle?.outcome).toBe('applied');
    const applySeq = readAudit(dir).find((entry) => entry.action === 'apply')?.seq as number;
    await updateState(dir, { monitor: { revision: currentRevision(dir), applySeq, at: new Date().toISOString(), verdict: { state: 'kept' } } });
    vi.mocked(checkApplied).mockResolvedValueOnce({ state: 'kept' }).mockResolvedValueOnce({ state: 'kept' });
    await watchTick(options(), context);
    const fixed = readCorpus(dir).filter((item) => item.origin === 'fixed');
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed.every((item) => item.revision === currentRevision(dir))).toBe(true);
    await watchTick(options(), context);
    expect(readCorpus(dir).filter((item) => item.origin === 'fixed')).toHaveLength(fixed.length);
    vi.mocked(checkApplied).mockResolvedValueOnce({ state: 'rolled-back' });
    await updateState(dir, { monitor: undefined });
    await watchTick(options(), context);
    expect(readCorpus(dir).filter((item) => item.origin === 'fixed')).toHaveLength(fixed.length);
  });
});

describe('the score regression trigger', () => {
  const mark = (at: number, revision: string | null = currentRevision(dir)) => db.prepare('INSERT INTO score_regressions (agent_id, revision, at, details) VALUES (?, ?, ?, ?)').run('support', revision, at, '{}');

  it("ignores a marker for another revision, and the trigger respects the watcher's budgets", async () => {
    const context = watchContext(options());
    seedFailures(1);
    mark(Date.now(), 'f'.repeat(64));
    await watchTick(options(), context);
    expect(vi.mocked(healOnce).mock.calls.at(-1)?.[0].trigger).toBe('failures');
    mark(Date.now() + 1);
    expect((await watchTick(options(), context)).cycle).toMatchObject({ trigger: 'score', outcome: 'applied' });
    mark(Date.now() + 2, null);
    expect((await watchTick(options(), context)).cycle).toMatchObject({ trigger: 'score', outcome: 'budget' });
    await appendAudit(dir, { actor: 'monitor', action: 'rollback', reason: 'Regressed.' });
    mark(Date.now() + 3, null);
    expect((await watchTick(options(), context)).cycle).toMatchObject({ trigger: 'score', outcome: 'cooldown' });
  });

  it('a paused tick keeps the marker for the next tick that runs', async () => {
    const context = watchContext(options());
    seedFailures(1);
    mark(Date.now());
    stop();
    expect((await watchTick(options(), context)).state).toBe('paused');
    rmSync(path.join(dir, '.lousho', 'improve.stop'));
    expect((await watchTick(options(), context)).cycle).toMatchObject({ trigger: 'score', outcome: 'applied' });
  });

  it('keeps one entry per agent directory and drops a dead watcher', async () => {
    const registry = path.join(root, 'watchers.json');
    writeFileSync(registry, JSON.stringify({ watchers: [{ agent: 'old', dir: '/gone', owner: 'x', pid: 2 ** 22 + 12345, since: 'then' }] }));
    await registerWatcher(registry, { agent: 'support', dir, owner: 'a' });
    await registerWatcher(registry, { agent: 'support', dir, owner: 'b' });
    expect(readWatchers(registry).map((entry) => entry.owner)).toEqual(['b']);
  });
});

describe('notifications', () => {
  it('the traffic canary: a tick starts it, a later tick promotes, applies, guards and posts', async () => {
    const traffic = settings({ canary: { replayRuns: 6, traffic: { share: 0.1, sessions: 3 } } });
    const post = vi.fn();
    const context = watchContext(options({ settings: traffic, alerter: { post } }));
    seedFailures();
    const started = await watchTick(options({ settings: traffic, alerter: { post } }), context);
    expect(started.cycle?.outcome).toBe('canary-started');
    const canary = readCanary(dir);
    expect(canary).toBeDefined();
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8').trim()).toBe(BASE);
    const at = Date.now() + 1000;
    ingestBatch(db, [0, 1, 2].map((i) => ({ ...root_(`c${i}`, '"hello"', at + i), data: { ...root_(`c${i}`, '"hello"', at + i).data, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.harness.revision': canary?.revision } } }) as IngestEvent));
    const settled = await watchTick(options({ settings: traffic, alerter: { post } }), context);
    expect(settled.canary).toMatchObject({ outcome: 'applied', applied: { to: canary?.revision } });
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8').trim()).toBe(FIX);
    expect(readCanary(dir)).toBeUndefined();
    expect(actions()).toEqual(expect.arrayContaining(['canary-start', 'apply', 'canary-end']));
    expect(post.mock.calls.map(([[event]]) => event.type)).toEqual(['improve.canary', 'improve.applied']);
  });

  it('the traffic canary waits when the daily apply cap is spent, and a pause ends it', async () => {
    const traffic = settings({ canary: { replayRuns: 6, traffic: { share: 0.1, sessions: 3 } } });
    const context = watchContext(options({ settings: traffic }));
    seedFailures();
    await watchTick(options({ settings: traffic }), context);
    const canary = readCanary(dir);
    await appendAudit(dir, { actor: 'gate', action: 'apply', from: 'a'.repeat(64), to: 'b'.repeat(64), reason: 'Applied elsewhere today.' });
    const at = Date.now() + 1000;
    ingestBatch(db, [0, 1, 2].map((i) => ({ ...root_(`c${i}`, '"hello"', at + i), data: { ...root_(`c${i}`, '"hello"', at + i).data, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.harness.revision': canary?.revision } } }) as IngestEvent));
    const held = await watchTick(options({ settings: traffic }), context);
    expect(held.canary).toBeUndefined();
    expect(readCanary(dir)).toBeDefined();
    const post = vi.fn();
    stop();
    await tick({ settings: traffic, alerter: { post } });
    expect(readCanary(dir)).toBeUndefined();
    expect(post.mock.calls.map(([[event]]) => event.type)).toEqual(['improve.paused']);
    expect(actions().at(-1)).toBe('canary-end');
  });

  it('a monitor rollback posts once across ticks, with its reason as plain text', async () => {
    const post = vi.fn(async (_events: readonly AlertEvent[]) => {
      throw new Error('webhook rejected');
    });
    const context = watchContext(options({ alerter: { post } }));
    seedFailures();
    await watchTick(options(), context);
    const applySeq = readAudit(dir).find((entry) => entry.action === 'apply')?.seq as number;
    await updateState(dir, { monitor: { revision: currentRevision(dir), applySeq, at: new Date().toISOString(), verdict: { state: 'rolled-back' } } });
    const verdict = { state: 'rolled-back' as const, to: 'a'.repeat(64), reason: 'Dropped ![pixel](https://evil.example/p.png) <img src=x> to 40%.' };
    vi.mocked(checkApplied).mockResolvedValueOnce(verdict).mockResolvedValueOnce(verdict);
    post.mockClear();
    await watchTick(options(), context);
    await watchTick(options(), context);
    const events = post.mock.calls.map(([[event]]) => event);
    expect(events.map((event) => event.type)).toEqual(['improve.rolled_back']);
    expect(events[0]?.details.reason).toBe('Dropped pixel to 40%.');
  });
});

describe('improveSchedule', () => {
  it('is a schedule whose run is one watch tick', async () => {
    seedFailures();
    const schedule = improveSchedule({ ...options(), cron: '0 * * * *' });
    expect(isDefinedSchedule(schedule)).toBe(true);
    expect(schedule).toMatchObject({ cron: '0 * * * *', name: 'improve' });
    await schedule.run?.({ agent: undefined as never, firedAt: new Date(), name: 'improve' });
    expect(healOnce).toHaveBeenCalledTimes(1);
  });
});

describe('watchAgent', () => {
  it('ticks on its interval and stop() waits for the cycle in progress, then exits', async () => {
    seedFailures();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: HealOptions['runCase'] = async (harness, input) => {
      await gate;
      return runCase(harness, input);
    };
    const cycles: string[] = [];
    const watcher = watchAgent(options({ runCase: slow, intervalMs: 60_000, onCycle: (cycle) => cycles.push(cycle.outcome) }));
    await vi.waitFor(() => expect(healOnce).toHaveBeenCalledTimes(1));
    const stopping = watcher.stop();
    release();
    await stopping;
    expect(healOnce).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8').trim()).toBe(BASE);
    expect(readCycles(dir)[0]?.outcome).toBe('interrupted');
  });

  it('reports each finished tick to onTick, in order', async () => {
    seedFailures();
    stop();
    const ticks: string[] = [];
    const watcher = watchAgent(options({ intervalMs: 20, onTick: (tick) => ticks.push(tick.state) }));
    await vi.waitFor(() => expect(ticks.length).toBeGreaterThanOrEqual(2));
    await watcher.stop();
    expect(ticks.slice(0, 2)).toEqual(['paused', 'paused']);
    expect(healOnce).not.toHaveBeenCalled();
  });
});
