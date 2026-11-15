/**
 * Input, output and tool guardrails that stop a run with
 * `finishReason: 'guardrail'` or rewrite its text.
 */

import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';
import {
  GuardrailError,
  llmJudgeGuardrail,
  regexGuardrail,
  type IoGuardrail,
  type IoGuardrailContext,
} from './ioGuardrails';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz';

/** A guardrail that blocks texts containing `word`, recording what it was asked. */
function blockWord(word: string, name = `no-${word}`) {
  const seen: IoGuardrailContext[] = [];
  const guardrail: IoGuardrail = {
    name,
    check: (ctx) => {
      seen.push(ctx);
      return ctx.text.includes(word) ? { ok: false, reason: `mentions ${word}` } : { ok: true };
    },
  };
  return { guardrail, seen };
}

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('input guardrails', () => {

  it('a rewrite keeps the image parts of a multimodal message', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({
      provider: model,
      guardrails: { input: [regexGuardrail({ name: 'secrets', action: 'rewrite' })] },
    });
    const image = { type: 'image' as const, image: 'https://example.com/cat.png' };

    await agent.send([{ type: 'text', text: `key ${KEY}` }, image]);

    expect(model.calls[0].messages.at(-1)?.content).toEqual([{ type: 'text', text: 'key [redacted]' }, image]);
  });
});

describe("onTripped: 'throw'", () => {
  it('rejects with GuardrailError; a stream ends with error then run.done', async () => {
    const { guardrail } = blockWord('bomb');
    const agent = createAgent({ provider: mockModel(['x']), guardrails: { input: [guardrail], onTripped: 'throw' } });

    const error = await agent.send('bomb').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardrailError);
    expect(error).toMatchObject({ code: 'LOUSHO_GUARDRAIL_TRIPPED', guardrail: { name: 'no-bomb', kind: 'input' } });

    const run = agent.stream('bomb', { throwOnError: false });
    const types = (await collect(run)).map((e) => e.type);
    expect(types.slice(-3)).toEqual(['guardrail.tripped', 'error', 'run.done']);
    await expect(run.result).rejects.toBeInstanceOf(GuardrailError);
  });
});

describe('built-in guardrails', () => {
  const ctx = (text: string): IoGuardrailContext => ({ kind: 'output', text, messages: [] });

  it('regexGuardrail blocks by default and redacts every match with rewrite', async () => {
    const ssn = regexGuardrail({ name: 'ssn', pattern: /\d{3}-\d{2}-\d{4}/ });
    expect(await ssn.check(ctx('ok'))).toEqual({ ok: true });
    expect(await ssn.check(ctx('123-45-6789'))).toMatchObject({ ok: false, action: 'block' });

    const secrets = regexGuardrail({ name: 'secrets', action: 'rewrite', replacement: '***' });
    expect(await secrets.check(ctx(`${KEY} and AKIAABCDEFGHIJKLMNOP and ${KEY}`))).toMatchObject({
      ok: false,
      action: 'rewrite',
      replacement: '*** and *** and ***',
    });
  });

  it('llmJudgeGuardrail makes one call and passes on PASS', async () => {
    const judge = mockModel(['PASS', 'FAIL: it is off-topic']);
    const guardrail = llmJudgeGuardrail({ model: judge, instruction: 'Only cooking topics.' });

    expect(await guardrail.check(ctx('a recipe'))).toEqual({ ok: true });
    expect(await guardrail.check(ctx('stocks'))).toEqual({ ok: false, reason: 'it is off-topic' });
    expect(judge.calls).toHaveLength(2);
    expect(judge.calls[1].messages[0].content).toContain('Only cooking topics.');
    expect(judge.calls[1].messages[1].content).toBe('stocks');
  });
});
