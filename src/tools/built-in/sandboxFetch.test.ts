import { afterEach, describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import type { SandboxAdapter } from '../../security/sandboxCore';
import type { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';

describe('routeFetchThroughSandbox', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("routes only the tool's own fetch calls, not a concurrent caller's", async () => {
    const hostFetch = vi.fn(async () => new Response('host'));
    globalThis.fetch = hostFetch as unknown as typeof fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sandbox: SandboxAdapter = {
      name: 'gated',
      writeFile: vi.fn(),
      run: vi.fn(async () => {
        await gate;
        return { stdout: JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: 'sandboxed' }), stderr: '', exitCode: 0 };
      }),
    };
    const descriptor = {
      tool: tool({
        description: 'calls fetch',
        parameters: z.object({}),
        execute: async () => (await fetch('https://api.github.com/x')).text(),
      }),
    } as ToolDescriptor;
    routeFetchThroughSandbox(descriptor);

    const toolCall = descriptor.sandboxExecute!({}, sandbox);
    const concurrent = await (await fetch('https://openrouter.ai/api/v1/chat')).text();
    release();

    expect(concurrent).toBe('host');
    expect(await toolCall).toBe('sandboxed');
    expect(sandbox.run).toHaveBeenCalledTimes(1);
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });
});
