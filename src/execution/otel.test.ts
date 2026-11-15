import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as otelApi from '@opentelemetry/api';
import type { Tracer, Span as OtelSpan, Context } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { createOtelTraceExporter } from './otel';

/** The exporter's caps on tracked spans (MAX_ENDED_SPANS / MAX_OPEN_SPANS in otel.ts). */
const MAX_ENDED_SPANS = 10_000;
const MAX_OPEN_SPANS = 100_000;
import { Span } from './tracing';

interface FakeOtelSpanState {
  name: string;
  attributes: Record<string, unknown>;
  ended: boolean;
  endTime: number | undefined;
}

/**
 * A minimal fake OTel span that just records what was done to it, so
 * assertions can check exact call shapes without needing a real
 * TracerProvider/exporter backend.
 */
function makeFakeOtelSpan(name: string) {
  const span: FakeOtelSpanState & { setAttribute(key: string, value: unknown): unknown; end(endTime?: number): void } = {
    name,
    attributes: {},
    ended: false,
    endTime: undefined,
    setAttribute(key, value) {
      this.attributes[key] = value;
      return this;
    },
    end(endTime) {
      this.ended = true;
      this.endTime = endTime;
    },
  };
  // A deliberately partial fake: only the OTel span methods the exporter calls are implemented.
  return span as unknown as OtelSpan & FakeOtelSpanState;
}

function makeFakeTracer() {
  const startedSpans: Array<{
    name: string;
    options: unknown;
    parentContext: unknown;
    span: ReturnType<typeof makeFakeOtelSpan>;
  }> = [];

  const tracer: Tracer = {
    startSpan: vi.fn((name: string, options: unknown, parentContext?: Context) => {
      const span = makeFakeOtelSpan(name);
      startedSpans.push({ name, options, parentContext, span });
      return span;
    }),
    startActiveSpan: vi.fn() as unknown as Tracer['startActiveSpan'],
  };

  return { tracer, startedSpans };
}

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    id: 'span-1',
    name: 'agent.run',
    attributes: { model: 'gpt-4' },
    startTime: 1000,
    ...overrides,
  };
}

describe('createOtelTraceExporter', () => {
  let fake: ReturnType<typeof makeFakeTracer>;

  beforeEach(() => {
    fake = makeFakeTracer();
  });

  it('never evicts an open root past the cap: more than MAX_ENDED_SPANS ended spans keep the root and its parenting', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer, metrics: false });
    exporter.onSpanStart(makeSpan({ id: 'root' }));
    exporter.onSpanStart(makeSpan({ id: 'child', parentId: 'root' }));
    for (let i = 0; i < MAX_ENDED_SPANS + 50; i++) {
      exporter.onSpanStart(makeSpan({ id: `s${i}`, parentId: 'root', attributes: {} }));
      exporter.onSpanEnd(makeSpan({ id: `s${i}`, parentId: 'root', attributes: {}, endTime: 1100 }));
    }
    // The oldest ended spans went, the open ones stayed.
    exporter.onSpanStart(makeSpan({ id: 'late-of-ended', parentId: 's0' }));
    expect(otelApi.trace.getSpan(fake.startedSpans.at(-1)!.parentContext as Context)).toBeUndefined();
    exporter.onSpanStart(makeSpan({ id: 'late-of-root', parentId: 'root' }));
    expect(otelApi.trace.getSpan(fake.startedSpans.at(-1)!.parentContext as Context)).toBe(fake.startedSpans[0].span);
    exporter.onSpanStart(makeSpan({ id: 'late-of-child', parentId: 'child' }));
    expect(otelApi.trace.getSpan(fake.startedSpans.at(-1)!.parentContext as Context)).toBe(fake.startedSpans[1].span);

    exporter.onSpanEnd(makeSpan({ id: 'child', parentId: 'root', endTime: 1800 }));
    exporter.onSpanEnd(makeSpan({ id: 'root', endTime: 1900 }));
    expect(fake.startedSpans[0].span.ended).toBe(true);
    expect(fake.startedSpans[0].span.endTime).toBe(1900);
    expect(fake.startedSpans[1].span.ended).toBe(true);
  });

  it('ends and releases the oldest open span past MAX_OPEN_SPANS (a root that never ends does not leak)', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer, metrics: false });
    exporter.onSpanStart(makeSpan({ id: 'abandoned' }));
    for (let i = 0; i < MAX_OPEN_SPANS; i++) exporter.onSpanStart(makeSpan({ id: `open${i}`, attributes: {} }));
    const abandoned = fake.startedSpans[0].span;
    expect(abandoned.ended).toBe(true);
    expect(abandoned.attributes['lousho.span.evicted']).toBe(true);
    expect(fake.startedSpans[1].span.ended).toBe(false);
    exporter.onSpanStart(makeSpan({ id: 'late-child', parentId: 'abandoned' }));
    expect(otelApi.trace.getSpan(fake.startedSpans.at(-1)!.parentContext as Context)).toBeUndefined();
  });

  it('leaves the run totals off invoke_agent spans with agentUsageTotals: false (chat spans keep theirs)', () => {
    const exporter = createOtelTraceExporter({ tracer: fake.tracer, metrics: false, agentUsageTotals: false });
    const agent = { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.usage.input_tokens': 40, 'gen_ai.usage.output_tokens': 21, 'lousho.cost_usd': 0.1 };
    const chat = { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 40, 'gen_ai.usage.output_tokens': 21 };
    exporter.onSpanStart(makeSpan({ id: 'run', attributes: {} }));
    exporter.onSpanStart(makeSpan({ id: 'chat', parentId: 'run', attributes: chat }));
    exporter.onSpanEnd(makeSpan({ id: 'chat', parentId: 'run', attributes: chat, endTime: 1500 }));
    exporter.onSpanEnd(makeSpan({ id: 'run', attributes: agent, endTime: 2000 }));
    expect(fake.startedSpans[0].span.attributes).toEqual({ 'gen_ai.operation.name': 'invoke_agent', 'lousho.cost_usd': 0.1 });
    expect(fake.startedSpans[1].span.attributes).toEqual(chat);
  });

  it('defaults to a tracer resolved via trace.getTracer when no tracer option is passed', async () => {
    const otelApi = await import('@opentelemetry/api');
    const getTracerSpy = vi.spyOn(otelApi.trace, 'getTracer');

    createOtelTraceExporter({ tracerName: 'my-agent', tracerVersion: '1.2.3' });

    expect(getTracerSpy).toHaveBeenCalledWith('my-agent', '1.2.3');
    getTracerSpy.mockRestore();
  });
});

describe('createOtelTraceExporter kind, status and array attributes', () => {

  it('sets an ERROR status on end when the SDK span failed, and none otherwise', () => {
    const fake = makeFakeTracer();
    const exporter = createOtelTraceExporter({ tracer: fake.tracer });
    const bad = vi.fn();
    const good = vi.fn();
    exporter.onSpanStart(makeSpan({ id: 'bad' }));
    exporter.onSpanStart(makeSpan({ id: 'good' }));
    (fake.startedSpans[0].span as { setStatus: unknown }).setStatus = bad;
    (fake.startedSpans[1].span as { setStatus: unknown }).setStatus = good;

    exporter.onSpanEnd(makeSpan({ id: 'bad', endTime: 5, status: { code: 'error', message: 'boom' } }));
    exporter.onSpanEnd(makeSpan({ id: 'good', endTime: 5 }));

    expect(bad).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'boom' });
    expect(good).not.toHaveBeenCalled();
  });
});
