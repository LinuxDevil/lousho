import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../createAgent';
import { mockModel as scriptedModel } from '../testing';
import { notMock } from '../testing/notMock';
import { CASSETTES_ENV, CONFIG_ENV, DRIFT_DIR_ENV, cassettePath, legacyCassettePath, withEvalCassettes } from './cassettes';
import type { EvalResult } from './evalResult';

/** These tests use a scripted model as the real network provider; a plain mockModel() is skipped by design. */
const mockModel: typeof scriptedModel = (script, options) => notMock(scriptedModel(script, options));

afterEach(() => {
  vi.unstubAllEnvs();
});

function evalFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cassettes-')), 'refund.eval.ts');
}

/** Runs one "case": sends a message to an agent on `provider`, returns a minimal result. */
async function runCase(file: string, provider: ReturnType<typeof mockModel>): Promise<{ result: EvalResult; reply: string }> {
  let reply = '';
  const result = await withEvalCassettes({ file, name: 'Refund flow', label: 'Order #42' }, async () => {
    reply = (await createAgent({ provider, prompt: 'You handle refunds.' }).send('Refund 42')).text;
    return { name: 'Refund flow', case: 'Order #42', tags: [], passed: true, assertions: [], durationMs: 0, steps: 1, toolCalls: [] };
  });
  return { result, reply };
}

describe('withEvalCassettes', () => {

  it('records the case, then replays it without calling the provider', async () => {
    const file = evalFile();
    vi.stubEnv(CASSETTES_ENV, 'record');
    const recorded = await runCase(file, mockModel(['recorded reply']));
    const cassette = cassettePath(file, 'Refund flow', 'Order #42');
    expect(recorded.result.cassettes).toEqual([cassette]);
    expect(fs.existsSync(cassette)).toBe(true);

    vi.stubEnv(CASSETTES_ENV, 'replay');
    const replayed = await runCase(file, mockModel([]));
    expect(replayed.reply).toBe('recorded reply');
  });

  it('skips a plain mockModel(): no cassette is needed to replay, none is written to record', async () => {
    const file = evalFile();
    vi.stubEnv(CASSETTES_ENV, 'replay');
    const replayed = await runCase(file, scriptedModel(['offline']));
    expect(replayed.reply).toBe('offline');
    expect(replayed.result.cassettes).toBeUndefined();
    vi.stubEnv(CASSETTES_ENV, 'record');
    expect((await runCase(file, scriptedModel(['again']))).result.cassettes).toBeUndefined();
    expect(fs.existsSync(path.join(path.dirname(file), '__cassettes__'))).toBe(false);
  });

  it('covers a sub-agent: each provider gets its own cassette and both replay offline', async () => {
    const file = evalFile();
    const build = (leadModel: ReturnType<typeof mockModel>, researcherModel: ReturnType<typeof mockModel>) =>
      createAgent({
        provider: leadModel,
        instructions: 'You coordinate.',
        subagents: { researcher: createAgent({ provider: researcherModel, instructions: 'You research.', description: 'Researches' }) },
      });
    const task = { name: 'task', args: { agent: 'researcher', prompt: 'capital of France?', description: 'ask' } };
    const run = async (agent: ReturnType<typeof build>) => {
      let reply = '';
      const result = await withEvalCassettes({ file, name: 'Delegation' }, async () => {
        reply = (await agent.send('Tell me about France')).text;
        return { name: 'Delegation', tags: [], passed: true, assertions: [], durationMs: 0, steps: 2, toolCalls: [] };
      });
      return { reply, result };
    };

    vi.stubEnv(CASSETTES_ENV, 'record');
    const recorded = await run(build(mockModel([{ toolCalls: [task] }, 'Paris.']), mockModel(['Paris is the capital.'])));
    expect(recorded.reply).toBe('Paris.');
    expect(recorded.result.cassettes).toEqual([cassettePath(file, 'Delegation', undefined), cassettePath(file, 'Delegation', undefined, 1, 'researcher')]);

    vi.stubEnv(CASSETTES_ENV, 'replay');
    const leadModel = mockModel([]);
    const researcherModel = mockModel([]);
    expect((await run(build(leadModel, researcherModel))).reply).toBe('Paris.');
    expect(leadModel.calls).toHaveLength(0);
    expect(researcherModel.calls).toHaveLength(0);
  });
});

describe('cassette names', () => {
  const caseResult = (label: string): EvalResult => ({ name: 'Refund flow', case: label, tags: [], passed: true, assertions: [], durationMs: 0, steps: 1, toolCalls: [] });
  const send = async (file: string, provider: ReturnType<typeof mockModel>, info: { label: string; key?: string; index?: number }) => {
    let reply = '';
    const result = await withEvalCassettes({ file, name: 'Refund flow', ...info }, async () => {
      reply = (await createAgent({ provider, prompt: 'You handle refunds.' }).send('Refund 42')).text;
      return caseResult(info.label);
    });
    return { reply, result };
  };

  it('fails the second of two cases that would record to the same cassette instead of overwriting the first', async () => {
    const file = evalFile();
    vi.stubEnv(CASSETTES_ENV, 'record');
    await send(file, mockModel(['first']), { label: 'same', index: 0 });
    await expect(send(file, mockModel(['second']), { label: 'same', index: 1 })).rejects.toThrow(
      /"Refund flow \[same\]" would record to .*which "Refund flow \[same\]" already recorded in this run\. Give each case a distinct `label`/
    );
    // Recording the same case again (a retry) is fine.
    await send(file, mockModel(['first again']), { label: 'same', index: 0 });
  });

  it('still replays (and drifts against) a cassette recorded under the old, unhashed name', async () => {
    const file = evalFile();
    vi.stubEnv(CASSETTES_ENV, 'record');
    const { result } = await send(file, mockModel(['old reply']), { label: 'Order #42' });
    const legacy = legacyCassettePath(file, 'Refund flow', 'Order #42');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.renameSync(result.cassettes![0], legacy);

    vi.stubEnv(CASSETTES_ENV, 'replay');
    const replayed = await send(file, mockModel([]), { label: 'Order #42' });
    expect(replayed.reply).toBe('old reply');
    expect(replayed.result.cassettes).toEqual([legacy]);

    vi.stubEnv(CASSETTES_ENV, 'record');
    vi.stubEnv(DRIFT_DIR_ENV, fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-drift-')));
    expect((await send(file, mockModel(['new reply']), { label: 'Order #42' })).result.cassettes).toEqual([legacy]);
  });

  it('repeats the --config of the run in the re-record hints', async () => {
    const file = evalFile();
    vi.stubEnv(CONFIG_ENV, 'vitest.eval.config.mts');
    vi.stubEnv(CASSETTES_ENV, 'replay');
    await expect(send(file, mockModel(['x']), { label: 'a' })).rejects.toThrow(/npx lousho eval --record --config vitest\.eval\.config\.mts /);

    vi.stubEnv(CASSETTES_ENV, 'record');
    await send(file, mockModel(['x']), { label: 'a' });
    vi.stubEnv(CASSETTES_ENV, 'replay');
    let caught: unknown;
    await withEvalCassettes({ file, name: 'Refund flow', label: 'a' }, async () => {
      caught = await createAgent({ provider: mockModel([]), prompt: 'Different prompt.' })
        .send('Refund 42')
        .catch((error: unknown) => error);
      return caseResult('a');
    });
    expect(String((caught as Error).message)).toContain('re-record it with: npx lousho eval --record --config vitest.eval.config.mts');
    expect(String((caught as Error).message)).not.toContain('LOUSHO_RECORD');
  });
});
