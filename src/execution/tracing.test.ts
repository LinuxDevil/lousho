import { describe, it, expect, vi } from 'vitest';
import { withSpan, recordSpanError, Span, TraceExporter } from './tracing';

describe('recordSpanError redaction', () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
  const fresh = (): Span => ({ id: 's', name: 'x', attributes: {}, startTime: 0 });

  it('scrubs attrs.error and status.message by default, keeping error.type', () => {
    const span = fresh();
    recordSpanError(span, new TypeError(`denied for ${token}`));
    expect(span.attributes.error).toBe('denied for [redacted]');
    expect(span.status).toEqual({ code: 'error', message: 'denied for [redacted]' });
    expect(span.attributes['error.type']).toBe('TypeError');
  });

  it('keeps the text with an identity redactor and applies a custom one', () => {
    const kept = fresh();
    recordSpanError(kept, new Error(`x ${token}`), (text) => text);
    expect(kept.status?.message).toBe(`x ${token}`);
    const custom = fresh();
    recordSpanError(custom, new Error('Paris'), (text) => text.toUpperCase());
    expect(custom.attributes.error).toBe('PARIS');
    expect(custom.status?.message).toBe('PARIS');
  });

  it('scrubs a thrown string and leaves a non-string error value as it was', () => {
    const text = fresh();
    recordSpanError(text, `bad ${token}`);
    expect(text.attributes.error).toBe('bad [redacted]');
    const obj = fresh();
    const value = { code: 7 };
    recordSpanError(obj, value);
    expect(obj.attributes.error).toBe(value);
  });

  it('a throwing redactor never replaces the run error', () => {
    const span = fresh();
    recordSpanError(span, new Error('real failure'), () => {
      throw new Error('redactor bug');
    });
    expect(span.attributes.error).toBe('[redacted]');
    expect(span.status).toEqual({ code: 'error', message: '[redacted]' });
  });

  it('withSpan passes its redactor to the failure it records', async () => {
    const ends: Span[] = [];
    const exporter: TraceExporter = { onSpanStart: () => undefined, onSpanEnd: (span) => ends.push({ ...span }) };
    await expect(
      withSpan(exporter, 's', {}, async () => { throw new Error(`oops ${token}`); }, undefined, undefined, (text) => text.replace(token, '<t>'))
    ).rejects.toThrow('oops');
    expect(ends[0].status?.message).toBe('oops <t>');
  });
});

describe('withSpan with a throwing exporter', () => {
  it('runs fn and returns its result when onSpanStart/onSpanEnd throw, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exporter: TraceExporter = {
      onSpanStart: () => { throw new Error('exporter broke'); },
      onSpanEnd: () => { throw new Error('exporter broke'); },
    };
    try {
      await expect(withSpan(exporter, 'a', {}, async () => 1)).resolves.toBe(1);
      await expect(withSpan(exporter, 'b', {}, async () => 2)).resolves.toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('exporter broke');
    } finally {
      warn.mockRestore();
    }
  });

  it('catches a rejection from an async exporter, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const exporter: TraceExporter = {
      onSpanStart: async () => { throw new Error('backend down'); },
      onSpanEnd: () => Promise.reject(new Error('backend down')) as unknown as void,
    };
    try {
      await expect(withSpan(exporter, 'a', {}, async () => 1)).resolves.toBe(1);
      await expect(withSpan(exporter, 'b', {}, async () => 2)).resolves.toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('backend down');
    } finally {
      process.off('unhandledRejection', unhandled);
      warn.mockRestore();
    }
  });
});
