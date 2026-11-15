import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { Message } from '../providers';

const weather = z.object({ city: z.string(), tempC: z.number() });
const callTask = (prompt: string) => ({ name: 'task', args: { agent: 'reporter', prompt, description: 'weather' } });
const toolContent = (messages: readonly Message[]): unknown => JSON.parse(messages.find((m) => m.role === 'tool')?.content as string);

describe('structured output of sessions and sub-agents', () => {

  it('turns an invalid child object into a structured tool error', async () => {
    const reporter = createAgent({ provider: mockModel(['nope', 'still nope']), description: 'Reports weather', output: weather });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [callTask('Oslo')] }, 'sorry']), subagents: { reporter } });
    const result = await lead.send('Weather?');
    expect(toolContent(result.messages)).toMatchObject({ toolName: 'task', kind: 'execution' });
    expect(JSON.stringify(toolContent(result.messages))).toContain('did not return a valid object');
  });
});
