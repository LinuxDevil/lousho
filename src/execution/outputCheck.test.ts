import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createOutputCheck, type OutputChecks } from './outputCheck';

function run(checks: OutputChecks, execute: () => unknown = () => ({ path: 'a.txt' })) {
  const write = defineTool({ name: 'write_file', description: 'Write', input: z.object({ path: z.string() }), execute: async () => execute() });
  const agent = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt' } }] }, 'done']),
    tools: [write],
    hooks: [createOutputCheck(checks)],
  });
  return agent.send('go').then((result) => String(result.messages.find((m) => m.role === 'tool')?.content));
}

describe('createOutputCheck', () => {

  it('reports a check that throws as a problem, without ending the run', async () => {
    const content = await run({
      write_file: () => {
        throw new Error('reader crashed');
      },
    });
    expect(content).toContain('reader crashed');
  });
});
