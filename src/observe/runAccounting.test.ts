import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import type { Span } from '../execution/tracing';
import type { IngestEvent } from './envelope';
import { observeExporter } from './reporter';
import { ingestBatch, listSessions, listTraces, openDb } from './store';

const T0 = 1_700_000_000_000;

function span(id: string, name: string, attributes: Record<string, unknown>, parentId?: string): Span {
  return { id, name, attributes, startTime: T0, ...(parentId ? { parentId } : {}) };
}

it('keeps a run in one session and counts its tokens and cost once', async () => {
  const sent: IngestEvent[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    sent.push(...(JSON.parse(init.body) as { batch: IngestEvent[] }).batch);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const reporter = observeExporter({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-observe-')),
    fetchFn,
    heartbeatIntervalMs: 0,
    flushIntervalMs: 0,
    registerExitHooks: false,
    now: () => T0 + 10,
  });
  const root = span('root', 'invoke_agent a', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 'chat-1' });
  const chats = [
    span('c1', 'chat m', { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10, 'lousho.cost_usd': 0.1 }, 'root'),
    span('c2', 'chat m', { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 200, 'gen_ai.usage.output_tokens': 20, 'lousho.cost_usd': 0.2 }, 'root'),
  ];
  reporter.onSpanStart(root);
  for (const chat of chats) {
    reporter.onSpanStart(chat);
    reporter.onSpanEnd({ ...chat, endTime: T0 + 5 });
  }
  Object.assign(root.attributes, { 'gen_ai.usage.input_tokens': 300, 'gen_ai.usage.output_tokens': 30, 'lousho.cost_usd': 0.3 });
  reporter.onSpanEnd({ ...root, endTime: T0 + 10 });
  await reporter.close();

  const db = openDb(':memory:');
  try {
    ingestBatch(db, sent, T0 + 20);
    const observations = sent.filter((event) => event.type === 'observation').map((event) => event.data as { session_id?: string });
    expect(new Set(observations.map((o) => o.session_id))).toEqual(new Set(['chat-1']));
    const [trace] = listTraces(db, { limit: 10, offset: 0 }).traces;
    expect([trace?.input_tokens, trace?.output_tokens, trace?.cost_usd]).toEqual([300, 30, 0.3]);
    const { sessions } = listSessions(db, { limit: 10, offset: 0 });
    expect(sessions.map((s) => [s.session_id, s.input_tokens, s.output_tokens])).toEqual([['chat-1', 300, 30]]);
  } finally {
    db.close();
  }
});

it('previews a run by its last user message, not the raw message JSON', async () => {
  const sent: IngestEvent[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    sent.push(...(JSON.parse(init.body) as { batch: IngestEvent[] }).batch);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const reporter = observeExporter({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-observe-')),
    fetchFn,
    heartbeatIntervalMs: 0,
    flushIntervalMs: 0,
    registerExitHooks: false,
    now: () => T0 + 10,
  });
  const messages = [
    { role: 'system', parts: [{ type: 'text', content: 'You are a helper.' }] },
    { role: 'user', parts: [{ type: 'text', content: 'first question' }] },
    { role: 'assistant', parts: [{ type: 'text', content: 'answer' }] },
    { role: 'user', parts: [{ type: 'text', content: 'Design a URL shortener' }] },
  ];
  const root = span('root', 'invoke_agent a', {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.conversation.id': 'chat-2',
    'gen_ai.input.messages': JSON.stringify(messages),
  });
  reporter.onSpanStart(root);
  reporter.onSpanEnd({ ...root, endTime: T0 + 10 });
  await reporter.close();

  const db = openDb(':memory:');
  try {
    ingestBatch(db, sent, T0 + 20);
    expect(listTraces(db, { limit: 10, offset: 0 }).traces[0]?.input_preview).toBe('Design a URL shortener');
    expect(listSessions(db, { limit: 10, offset: 0 }).sessions[0]?.last_input_preview).toBe('Design a URL shortener');
  } finally {
    db.close();
  }
});
