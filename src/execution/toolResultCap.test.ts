/**
 * A tool result longer than `maxToolResultChars` (default 50_000)
 * reaches the model as its head and tail with a truncation marker.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { DEFAULT_MAX_TOOL_RESULT_CHARS, toolResultContent } from './toolResult';

const dump = (result: unknown, needsApproval = false) =>
  defineTool({ name: 'dump', description: 'Returns a lot', input: z.object({}), needsApproval, execute: async () => result });

const sentToolContent = (model: ReturnType<typeof mockModel>, call = 1): string => {
  const message = model.calls[call]?.messages.find((m) => m.role === 'tool');
  return message?.content as string;
};

describe('toolResultContent cap', () => {

  it('cuts a long object result as its JSON text, and stays valid JSON', () => {
    const content = toolResultContent({ rows: Array.from({ length: 5_000 }, (_, i) => ({ i })) }, 500);
    const decoded = JSON.parse(content) as string;
    expect(typeof decoded).toBe('string');
    expect(decoded.startsWith('{"rows":[{"i":0}')).toBe(true);
    expect(decoded).toContain('characters truncated');
  });
});

describe('createAgent({ maxToolResultChars })', () => {
  it('caps a 3 MB defineTool result at the default ~50k characters', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'dump', args: {} }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [dump('x'.repeat(3_000_000))] });
    const result = await agent.send('go');
    const content = sentToolContent(model);
    expect(content.length).toBeLessThan(DEFAULT_MAX_TOOL_RESULT_CHARS + 300);
    expect(content).toContain('2950000 characters truncated');
    // The transcript keeps the capped content too.
    expect((result.messages.find((m) => m.role === 'tool')?.content as string).length).toBe(content.length);
  });

  it('refuses a cap that is not a positive integer (LOUSHO_CONFIG_INVALID)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createAgent({ provider: mockModel(['x']), maxToolResultChars: bad })).toThrow(
        expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' })
      );
    }
  });
});
