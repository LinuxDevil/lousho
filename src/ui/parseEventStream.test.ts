/**
 * ParseEventStream() reads SSE and NDJSON framed event streams.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent } from '../execution/agentEvents';
import { parseEventStream } from './parseEventStream';

const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
const sample: AgentEvent[] = [
  { ...base, seq: 0, type: 'run.start', agentName: 'a' },
  { ...base, seq: 1, type: 'text.delta', text: 'héllo\nworld' },
  { ...base, seq: 2, type: 'run.done', finishReason: 'stop', text: 'héllo\nworld' },
];

/** A Response whose body arrives in `chunkSize`-byte pieces, so lines and UTF-8 characters are split across reads. */
function chunked(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body);
}

async function collect(response: { body: ReadableStream<Uint8Array> | null }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of parseEventStream(response)) out.push(event);
  return out;
}

describe('parseEventStream', () => {

  it('skips lines that are not agent events and handles an empty body', async () => {
    const text = `not json\n{"broken":\n${JSON.stringify({ type: 'unknown.event', v: 1, seq: 0 })}\n${JSON.stringify(sample[0])}\n`;
    expect(await collect(chunked(text))).toEqual([sample[0]]);
    expect(await collect({ body: null })).toEqual([]);
  });
});
