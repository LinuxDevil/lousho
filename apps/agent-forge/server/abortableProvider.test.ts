import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from 'lousho';
import { RunAbortedError, withAbortSignal } from './abortableProvider';

const request = { model: 'mock-1', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('withAbortSignal (streamed calls)', () => {

  it('throws RunAbortedError from a stream stopped while it is read', async () => {
    const controller = new AbortController();
    const provider = withAbortSignal(new MockLLMProvider({ name: 'mock' }), controller.signal);
    const streamed = await provider.stream(request);
    const read = async () => {
      for await (const _chunk of streamed.fullStream) controller.abort();
    };
    await expect(read()).rejects.toBeInstanceOf(RunAbortedError);
  });
});
