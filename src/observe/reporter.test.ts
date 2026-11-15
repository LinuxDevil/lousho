
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenAiAttr, GenAiOperation, LegacyAttr, SdkAttr } from '../execution/semconv';
import type { Span, TraceExporter } from '../execution/tracing';
import { blockingPost } from './blockingPost';
import type { IngestEvent } from './envelope';
import { fanOutExporters, observeExporter, type ObserveReporter } from './reporter';

interface PostedBatch {
  url: string;
  authorization?: string;
  events: IngestEvent[];
}

/** A fetch mock that records every batch and answers 202 (or `fail`, to emulate a dead daemon). */
function mockFetch(fail = false): { fetchFn: typeof fetch; posted: PostedBatch[] } {
  const posted: PostedBatch[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { batch: IngestEvent[] };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    posted.push({ url, authorization: headers.authorization, events: body.batch });
    return new Response('{}', { status: fail ? 500 : 202 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posted };
}

const reporters: ObserveReporter[] = [];
let cwd: string;

function makeSpan(over: Partial<Span> = {}): Span {
  return { id: `s${Math.random().toString(36).slice(2)}`, name: 'invoke_agent a', attributes: {}, startTime: 100, endTime: 150, ...over };
}

function reporter(over: Parameters<typeof observeExporter>[0] = {}, fail = false): { r: ObserveReporter; posted: PostedBatch[] } {
  const { fetchFn, posted } = mockFetch(fail);
  const r = observeExporter({
    cwd,
    url: 'http://127.0.0.1:1',
    project: 'testproj',
    agentName: 'agent-a',
    flushIntervalMs: 0,
    heartbeatIntervalMs: 0,
    registerExitHooks: false,
    fetchFn,
    ...over,
  });
  reporters.push(r);
  return { r, posted };
}

const allEvents = (posted: PostedBatch[]): IngestEvent[] => posted.flatMap((p) => p.events);
const observations = (posted: PostedBatch[]) =>
  allEvents(posted).filter((e): e is Extract<IngestEvent, { type: 'observation' }> => e.type === 'observation');
/** Finished-span events only: a root span's start also posts an observation, one without `end`. */
const finished = (posted: PostedBatch[]) => observations(posted).filter((o) => o.data.end !== undefined);
// The queue-mechanics tests below finish root spans through onSpanEnd alone: an
// onSpanStart would add the root's eager start event and its own flush (see 'eager root start').

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-reporter-'));
});

afterEach(async () => {
  await Promise.all(reporters.splice(0).map((r) => r.close().catch(() => undefined)));
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('observeExporter', () => {

  it('carries usage/cost/flags verbatim from gen_ai + lousho attrs', async () => {
    const { r, posted } = reporter();
    const span = makeSpan({
      id: 'chat1',
      attributes: {
        [GenAiAttr.OPERATION_NAME]: GenAiOperation.CHAT,
        [GenAiAttr.RESPONSE_MODEL]: 'm-1',
        [GenAiAttr.USAGE_INPUT_TOKENS]: 100,
        [GenAiAttr.USAGE_OUTPUT_TOKENS]: 40,
        'gen_ai.usage.cached_input_tokens': 30,
        [SdkAttr.USAGE_REASONING_TOKENS]: 12,
        [SdkAttr.COST_USD]: 0.007,
        'lousho.cost_partial': true,
        [SdkAttr.USAGE_ESTIMATED]: true,
        [GenAiAttr.CONVERSATION_ID]: 'real-session',
      },
    });
    r.onSpanStart(span);
    r.onSpanEnd(span);
    await r.close();

    const d = finished(posted)[0].data;
    expect(d.kind).toBe('generation');
    expect(d.model).toBe('m-1');
    expect(d.usage_input_tokens).toBe(100);
    expect(d.usage_output_tokens).toBe(40);
    expect(d.usage_cached_tokens).toBe(30);
    expect(d.usage_reasoning_tokens).toBe(12);
    expect(d.cost_usd).toBe(0.007);
    expect(d.cost_partial).toBe(true);
    expect(d.usage_estimated).toBe(true);
    // a real conversation id beats the fallback session
    expect(d.session_id).toBe('real-session');
  });

  it('falls back to legacy attribute names', async () => {
    const { r, posted } = reporter();
    const span = makeSpan({ id: 'legacy', attributes: { [LegacyAttr.MODEL]: 'old-m', [LegacyAttr.PROMPT_TOKENS]: 9, input: 'hi', result: 'yo' } });
    r.onSpanStart(span);
    r.onSpanEnd(span);
    await r.close();
    const d = finished(posted)[0].data;
    expect(d.model).toBe('old-m');
    expect(d.usage_input_tokens).toBe(9);
    expect(d.input).toBe('hi');
    expect(d.output).toBe('yo');
  });

  describe('byte cap', () => { // BATCH_BUDGET_BYTES
    /** A finished span whose input is `bytes` of ASCII. */
    const bigSpan = (id: string, bytes: number): Span =>
      makeSpan({ id, attributes: { [GenAiAttr.OPERATION_NAME]: GenAiOperation.CHAT, [GenAiAttr.INPUT_MESSAGES]: 'x'.repeat(bytes) } });
    /** A fetch that records each body's size and ids, answering `status(n)` to the n-th call (1-based). */
    function sizedFetch(status: (n: number) => number = () => 202) {
      const calls: { bytes: number; ids: string[] }[] = [];
      const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = String(init?.body);
        const batch = (JSON.parse(body) as { batch: IngestEvent[] }).batch;
        calls.push({ bytes: Buffer.byteLength(body), ids: batch.flatMap((e) => (e.type === 'observation' ? [e.data.obs_id] : [])) });
        return new Response('{}', { status: status(calls.length) });
      }) as unknown as typeof fetch;
      return { fetchFn, calls };
    }

    it('drops and counts one event too large for any request, and keeps delivering', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fetchFn, calls } = sizedFetch();
      const { r } = reporter({ fetchFn, flushSize: 1000 });
      for (const span of [bigSpan('huge', 6 * 1024 * 1024), makeSpan({ id: 'after' })]) {
        r.onSpanEnd(span);
      }
      expect(r.dropped).toBe(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toMatch(/larger than the daemon's 5242880-byte request cap/);
      await r.close();
      expect(calls.flatMap((c) => c.ids)).toEqual(['after']);
      expect(r.dropped).toBe(1);
    });

    it('warns about a drop without promising a retry, and still warns about a later outage', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fetchFn } = sizedFetch((n) => (n === 1 ? 413 : 503));
      const { r } = reporter({ fetchFn, flushSize: 1000 });
      r.onSpanEnd(makeSpan({ id: 'refused' }));
      await r.flush(); // 413: dropped
      r.onSpanEnd(makeSpan({ id: 'later' }));
      await r.flush(); // 503: an outage, requeued
      expect(warn).toHaveBeenCalledTimes(2);
      const [drop, outage] = warn.mock.calls.map((call) => String(call[0]));
      expect(drop).toContain('refused a batch');
      expect(drop).not.toContain('retrying');
      expect(outage).toContain('could not reach the observe daemon');
      expect(outage).toContain('retrying with backoff');
    });
  });

  describe('open run roots through the outbox trim', () => {
    /** A child of `parent` whose input is `bytes` of ASCII. */
    const bigChild = (id: string, parent: string, bytes: number): Span => ({
      ...makeSpan({ id, attributes: { [GenAiAttr.INPUT_MESSAGES]: 'x'.repeat(bytes) } }),
      parentId: parent,
    });
    /** A fetch answering 500 while `down()`, recording each delivered observation as `<id>:start` / `<id>:end`. */
    function downFetch(down: () => boolean) {
      const delivered: string[] = [];
      let calls = 0;
      const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls++;
        if (down()) return new Response('{}', { status: 500 });
        for (const e of (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch) {
          if (e.type === 'observation') delivered.push(`${e.data.obs_id}:${e.data.end === undefined ? 'start' : 'end'}`);
        }
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;
      return { fetchFn, delivered, calls: () => calls };
    }
    /** Flush until a flush delivers nothing new. */
    async function drain(r: ObserveReporter, delivered: string[]): Promise<void> {
      for (let before = -1; before !== delivered.length; ) {
        before = delivered.length;
        await r.flush();
      }
    }
    const openRoot = (id: string): Span => makeSpan({ id, endTime: undefined });

    it('keeps an open root start behind 40MB of child events, evicting the children instead', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let down = true;
      const { fetchFn, delivered, calls } = downFetch(() => down);
      const { r } = reporter({ fetchFn, flushSize: 10_000 });
      r.onSpanStart(openRoot('run'));
      await vi.waitFor(() => expect(calls()).toBe(1)); // the eager start failed and was requeued
      // ~2MB per child (the input rides twice) x 20 = ~40MB, past the 32MB byte cap
      for (let i = 0; i < 20; i++) {
        const child = bigChild(`c${i}`, 'run', 1024 * 1024);
        r.onSpanStart(child);
        r.onSpanEnd(child);
      }
      expect(r.dropped).toBeGreaterThanOrEqual(4);
      const kept = 20 - r.dropped;
      down = false;
      await drain(r, delivered);
      expect(delivered).toEqual(['run:start', ...Array.from({ length: kept }, (_, i) => `c${20 - kept + i}:end`)]);
    });
  });

  it('close() aborts a regular flush in flight and sends its batch in the final attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const posted: PostedBatch[] = [];
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        posted.push({ url: String(input), events: (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch });
        if (posted.length > 1) return new Response('{}', { status: 202 });
        // The first POST hangs until its signal fires (a daemon that accepted the socket but never answers).
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
      }) as unknown as typeof fetch;
      const { r } = reporter({ fetchFn, flushSize: 1, requestTimeoutMs: 60_000 });
      const span = makeSpan({ id: 'hung' });
      r.onSpanEnd(span); // size flush: in flight, hanging
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      const started = Date.now();
      await r.close();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(posted).toHaveLength(2);
      expect(posted[1]!.events.map((e) => (e.type === 'observation' ? e.data.obs_id : e.type))).toEqual(['hung', 'agent.deregister']);
      expect(r.dropped).toBe(0);
      expect(warn).not.toHaveBeenCalled(); // a healthy daemon: no outage warning for the aborted flush
    } finally {
      warn.mockRestore();
    }
  });

  describe('eager root start', () => {

    describe('with fake timers', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('does not retry a down daemon early: the eager flush waits out the backoff', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const { r, posted } = reporter({ flushIntervalMs: 100 }, true);
          r.onSpanStart(makeSpan({ id: 'first', endTime: undefined }));
          await vi.advanceTimersByTimeAsync(0);
          expect(posted).toHaveLength(1); // answered 500: backing off 1s
          r.onSpanStart(makeSpan({ id: 'second', endTime: undefined }));
          await vi.advanceTimersByTimeAsync(999);
          expect(posted).toHaveLength(1); // neither the eager flush nor the interval retried inside the backoff
          await vi.advanceTimersByTimeAsync(100);
          expect(posted).toHaveLength(2); // the interval retries after it, carrying both starts
          expect(posted[1].events.map((e) => e.type === 'observation' && e.data.obs_id)).toEqual(['first', 'second']);
          expect(r.dropped).toBe(0);
        } finally {
          warn.mockRestore();
        }
      });
    });

    it('stamps one per-process instance id on heartbeats, run roots and the deregister', async () => {
      const { r, posted } = reporter({ heartbeatIntervalMs: 60_000 });
      const root = makeSpan({ id: 'root', endTime: undefined });
      const child = makeSpan({ id: 'child', parentId: 'root' });
      r.onSpanStart(root);
      r.onSpanStart(child);
      r.onSpanEnd(child);
      r.onSpanEnd({ ...root, endTime: 200 });
      await r.close();
      const events = allEvents(posted);
      const hb = events.find((e) => e.type === 'agent.heartbeat');
      const instance = hb?.type === 'agent.heartbeat' ? hb.data.instance_id : undefined;
      expect(instance).toMatch(/^[0-9a-f-]{36}$/);
      const attrOf = (id: string) => observations(posted).filter((o) => o.data.obs_id === id).map((o) => o.data.attrs?.['lousho.instance_id']);
      expect(attrOf('root')).toEqual([instance, instance]); // the start and the end event
      expect(attrOf('child')).toEqual([undefined]);
      expect(root.attributes['lousho.instance_id']).toBeUndefined(); // the span itself is not touched
      const bye = events.find((e) => e.type === 'agent.deregister');
      expect(bye?.type === 'agent.deregister' && bye.data.instance_id).toBe(instance);
      // one process, one instance: another reporter here reports the same id
      const other = reporter({ heartbeatIntervalMs: 60_000 });
      await other.r.close();
      const hb2 = allEvents(other.posted).find((e) => e.type === 'agent.heartbeat');
      expect(hb2?.type === 'agent.heartbeat' && hb2.data.instance_id).toBe(instance);
      // realm-global: a second copy of this module (dual ESM/CJS load) reads the same id
      expect((globalThis as Record<symbol, unknown>)[Symbol.for('lousho.observeInstance')]).toBe(instance);
    });
  });
});

describe('crash flush', () => {

  it('only flushes, and stays hooked, when an uncaughtException listener keeps the process alive', async () => {
    // vitest itself listens for 'uncaughtException', so this is the survivable-throw path.
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const { r, posted } = reporter({ registerExitHooks: true });
    for (const id of ['one', 'two']) {
      const span = makeSpan({ id });
      r.onSpanStart(span);
      r.onSpanEnd(span);
      // Call the listeners directly: emitting the event for real would also reach vitest's own monitors.
      const monitor = process.listeners('uncaughtExceptionMonitor').at(-1);
      monitor?.(new Error('survived'), 'uncaughtException');
      await vi.waitFor(() => expect(observations(posted).map((e) => e.data.obs_id)).toContain(id));
    }
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    expect(allEvents(posted).map((e) => e.type)).not.toContain('agent.deregister'); // not closed
  });
});

describe('blockingPost', () => {
  it('delivers nothing to an unreachable collector', () => {
    expect(blockingPost('http://127.0.0.1:1/api/v1/ingest', {}, ['{}', '{}'], 1000)).toEqual([false, false]);
    expect(blockingPost('http://127.0.0.1:1/api/v1/ingest', {}, [], 1000)).toEqual([]);
  });
});

describe('fanOutExporters / withObserveExporter', () => {
  const counting = (): { exporter: TraceExporter; spans: string[] } => {
    const spans: string[] = [];
    return { spans, exporter: { onSpanStart: (s) => void spans.push(`start:${s.id}`), onSpanEnd: (s) => void spans.push(`end:${s.id}`) } };
  };

  it('keeps one exporter seeing spans when another throws', () => {
    const good = counting();
    const bad: TraceExporter = {
      onSpanStart: () => {
        throw new Error('boom');
      },
      onSpanEnd: () => {
        throw new Error('boom');
      },
    };
    const fan = fanOutExporters([bad, good.exporter]);
    const span = makeSpan();
    expect(() => fan?.onSpanStart(span)).toThrow('boom');
    expect(() => fan?.onSpanEnd(span)).toThrow('boom');
    expect(good.spans).toEqual([`start:${span.id}`, `end:${span.id}`]);
  });
});
