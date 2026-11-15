/**
 * An `output` agent's stream carries `object.delta` events with
 * the reply parsed so far.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';

const reply = { title: 'Hello world', tags: ['a', 'b'] };

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of run) seen.push(event);
  return seen;
}

describe('object.delta', () => {
  it('streams the partial object as the JSON reply arrives, each one different, ending at the validated object', async () => {
    const agent = createAgent({
      provider: mockModel([JSON.stringify(reply, null, 1)]),
      output: z.object({ title: z.string(), tags: z.array(z.string()) }),
    });
    const run = agent.stream('go');
    const seen = await collect(run);

    const objects = seen.flatMap((event) => (event.type === 'object.delta' ? [event.object] : []));
    expect(objects.length).toBeGreaterThan(2);
    expect(objects[0]).toEqual({});
    expect(objects).toContainEqual({ title: 'Hello ' });
    expect(objects.at(-1)).toEqual(reply);
    expect(new Set(objects.map((object) => JSON.stringify(object))).size).toBe(objects.length);

    // Each object.delta follows the text.delta that produced it.
    const firstObject = seen.findIndex((event) => event.type === 'object.delta');
    expect(seen[firstObject - 1].type).toBe('text.delta');
    expect((await run.result).object).toEqual(reply);
  });
});
