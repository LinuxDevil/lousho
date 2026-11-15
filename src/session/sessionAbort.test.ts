/**
 * Pressing Stop while the model was answering a session turn erased the user's message from the
 * session, and the aborted model call counted 0 tokens. Now the turn keeps the user's input, plus the reply streamed
 * so far marked `metadata.interrupted`, and the aborted call's usage counts (estimated when the provider gave none).
 */
import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import type { GenerateOptions, LLMProvider, StreamChunk } from '../providers/llm';

const usage = { promptTokens: 5, completionTokens: 3, totalTokens: 8 };

/** Waits for `signal` to abort (or `ms`), rejecting with its reason as a signal-honouring provider does. */
const waitOrAbort = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      fail(signal.reason);
    });
  });

describe('Stop during a model reply keeps the turn', () => {

  it('stream(): the reply streamed so far is kept, marked interrupted, and its tokens count', async () => {
    const provider = {
      name: 'streamy',
      defaultModel: 'm',
      async generate() {
        return { text: 'unused', finishReason: 'stop', usage };
      },
      async stream(options: GenerateOptions) {
        async function* chunks(): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', textDelta: 'Contract A-7 covers ' };
          await waitOrAbort(1000, options.signal);
          yield { type: 'text-delta', textDelta: 'never' };
        }
        const never = new Promise<never>(() => undefined);
        return { fullStream: chunks(), textStream: (async function* () {})(), text: never, usage: never, finishReason: never, toolCalls: never };
      },
    } as unknown as LLMProvider;
    const session = createAgent({ provider }).session({ id: 'stop-stream' });
    const controller = new AbortController();
    const run = session.stream('Summarise contract A-7.', { signal: controller.signal });
    for await (const event of run) {
      if (event.type === 'text.delta') controller.abort();
    }
    const result = await run.result;

    expect(result.finishReason).toBe('aborted');
    const transcript = await session.load();
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(transcript[1]).toMatchObject({ content: 'Contract A-7 covers ', metadata: { interrupted: true } });
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.modelCalls).toBe(1);
  });
});
