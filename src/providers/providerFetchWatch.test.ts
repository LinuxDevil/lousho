/**
 * The response watching of the built-in providers' `fetch` (providerFetch):
 * in-response failures, unique tool-call ids and the idle `timeout`, on
 * hand-made responses.
 */
import { describe, expect, it } from 'vitest';
import { chatCompletionAsStream, chatCompletionFailure, chatCompletionWatch, providerFetch, uniqueToolCallIds } from './providerFetch';

const sse = (...payloads: unknown[]) => payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

/** A `send` answering with `body` (an event stream when it starts with `data:`), its chunks `gapMs` apart. */
function sendOf(body: string, { gapMs = 0, chunks = [body] }: { gapMs?: number; chunks?: string[] } = {}) {
  return () => async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const piece of chunks) {
            if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
            controller.enqueue(new TextEncoder().encode(piece));
          }
          controller.close();
        },
      }),
      { headers: { 'content-type': body.startsWith('data:') ? 'text/event-stream' : 'application/json' } }
    );
}

describe('chatCompletionFailure', () => {
  it("reads finish_reason 'error' and an error object; leaves normal chunks and Responses API events alone", () => {
    expect(chatCompletionFailure(JSON.stringify({ choices: [{ finish_reason: 'error' }] }))).toMatchObject({ status: 502 });
    const chunk = JSON.stringify({ error: { code: 429, message: 'slow down' }, choices: [] });
    expect(chatCompletionFailure(chunk)).toEqual({ status: 429, message: 'The provider reported an error mid-response: slow down', body: chunk });
    expect(chatCompletionFailure(JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content: 'the "error" word' } }] }))).toBeUndefined();
    expect(chatCompletionFailure(JSON.stringify({ type: 'error', message: 'x', error: { message: 'x' } }))).toBeUndefined();
  });
});

describe('chatCompletionAsStream', () => {

  it('leaves anything but a chat completion alone', () => {
    expect(chatCompletionAsStream(JSON.stringify({ object: 'response', output: [] }))).toBeUndefined();
    expect(chatCompletionAsStream(JSON.stringify({ error: { message: 'x' } }))).toBeUndefined();
    expect(chatCompletionAsStream(JSON.stringify({ choices: [{ delta: { content: 'x' } }] }))).toBeUndefined();
    expect(chatCompletionAsStream('not json')).toBeUndefined();
  });
});

describe('providerFetch', () => {

  it('decides streaming by the parsed top-level `stream` field: a nested `"stream":true` or a malformed body keeps its JSON reply', async () => {
    const completion = JSON.stringify({ object: 'chat.completion', choices: [{ index: 0, message: { content: 'hi' }, finish_reason: 'stop' }] });
    const fetch = providerFetch({ send: sendOf(completion), watch: chatCompletionWatch });

    // A nested flag (providerOptions passthrough, tool args) is not the request's own `stream`.
    const nested = await fetch('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ providerOptions: { gateway: { stream: true } } }) });
    expect(nested.headers.get('content-type')).toBe('application/json');
    expect(await nested.text()).toBe(completion);

    const malformed = await fetch('https://x/v1/chat/completions', { method: 'POST', body: '{"stream":true' });
    expect(malformed.headers.get('content-type')).toBe('application/json');
    expect(await malformed.text()).toBe(completion);
  });

  it('fails a 200 reply to a streaming request whose body is not valid JSON as a retryable 502, instead of an empty stream', async () => {
    const fetch = providerFetch({ send: sendOf('{"choices": [ {"oops'), watch: chatCompletionWatch });
    const response = await fetch('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ stream: true }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('malformed response') } });

    const empty = await providerFetch({ send: sendOf(''), watch: chatCompletionWatch })('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ stream: true }) });
    expect(empty.status).toBe(502);
  });

  it('fails a body that stalls longer than timeoutMs with a TimeoutError', async () => {
    const body = sse({ choices: [{ delta: { content: 'a' } }] });
    const response = await providerFetch({ send: sendOf(body, { gapMs: 200, chunks: [body, body] }), timeoutMs: 50 })('https://x');
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('uniqueToolCallIds', () => {

  it("keeps a stream call's id across deltas that repeat it without `index`; a new id at the same slot stays its own call", () => {
    const stream = uniqueToolCallIds();
    const delta = (id: string) => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id, function: { arguments: 'x' } }] } }] });
    const idOf = (text: string, at = 0) => (JSON.parse(text) as { choices: [{ delta: { tool_calls: Array<{ id: string }> } }] }).choices[0].delta.tool_calls[at].id;

    // The same call repeating its id on each delta, with `index` omitted (quirky OpenAI-compatible / Gemini-proxy servers).
    expect(stream(delta('call_1'))).toBeUndefined();
    expect(stream(delta('call_1'))).toBeUndefined();
    expect(stream(delta('call_1'))).toBeUndefined();

    // A distinct raw id is a distinct call, index or not.
    expect(stream(delta('call_2'))).toBeUndefined();

    // A repeated id inside one delta is still two calls (its array slot stands in for `index`).
    const pair = uniqueToolCallIds();
    const two = JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'x' }, { id: 'x' }] } }] });
    const rewritten = pair(two)!;
    expect([idOf(rewritten, 0), idOf(rewritten, 1)]).toEqual(['x', 'x_2']);
    // ...and a later delta's unindexed slot-0 `x` is the first of them again, not a third.
    const next = JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'x' }] } }] });
    expect(pair(next)).toBeUndefined();
  });
});
