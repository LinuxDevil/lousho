import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { searchDocsTool } from '../tools/searchDocsTool';
import type { AuthorToolDeps } from '../tools/index';
import type { AuthorTurn } from '../turnRunner';

const docsDir = path.resolve(__dirname, '../../../../../docs');

function build(stepsRemaining: () => number) {
  const turn = { state: new Map<string, unknown>(), stepsRemaining } as unknown as AuthorTurn;
  const tool = searchDocsTool(turn, { docsDir } as AuthorToolDeps);
  const run = () =>
    (tool as unknown as { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }).execute(
      { query: 'github tools' },
      { toolCallId: 'c' }
    );
  return run;
}

describe('searchDocs per-turn limit', () => {
  it('answers the first 3 calls and refuses from the 4th', async () => {
    const run = build(() => 12);
    for (let call = 1; call <= 3; call += 1) {
      const result = await run();
      expect(result.limitReached).toBeUndefined();
      expect(result.ok).toBe(true);
    }
    const fourth = await run();
    expect(fourth.limitReached).toBe(true);
    expect(fourth.items).toEqual([]);
    expect(String(fourth.next)).toContain('call the propose tool');
    expect(String(fourth.next)).toContain('reply to the user with a question');
  });

  it('refuses on the first call when 2 or fewer steps remain', async () => {
    const result = await build(() => 2)();
    expect(result.limitReached).toBe(true);
  });

  it('still answers with 3 steps remaining', async () => {
    const result = await build(() => 3)();
    expect(result.limitReached).toBeUndefined();
  });
});
