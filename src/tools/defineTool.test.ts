import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { defineTool } from './defineTool';
import { ToolRegistry } from './ToolRegistry';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { AgentBuilder } from '../core/AgentBuilder';

const input = z.object({ to: z.string(), subject: z.string() });

function makeEmail(name = 'send_email') {
  return defineTool({
    name,
    description: 'Send an email',
    input,
    needsApproval: ({ to }) => !to.endsWith('@mycompany.com'),
    async execute({ to, subject }) {
      return { messageId: `${to}:${subject}` };
    },
  });
}

describe('defineTool', () => {

  describe('validation', () => {
    const base = { name: 'ok', description: 'd', input, execute: () => 1 };

    it.each([
      ['zod 3', z.object({ when: z.date(), n: z.bigint(), items: z.array(z.object({ due: z.date().optional() })) }), ["'items[].due'", "'n'", "'when'"]],
    ])('rejects %s z.date() / z.bigint() fields and points to z.coerce', (_label, schema, paths) => {
      let error: unknown;
      try {
        defineTool({ ...base, input: schema } as never);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
      const message = (error as Error).message;
      for (const path of paths) expect(message).toContain(path);
      expect(message).toContain('z.coerce.date()');
      expect(message).toContain('z.coerce.bigint()');
    });

    it('rejects an unknown option with no plausible match, listing the allowed ones', () => {
      expect(() => defineTool({ ...base, frobnicate: 1 } as never)).toThrow(/'frobnicate' is not a known option\. Allowed options: name, description, input, /);
    });

    it('accepts z.coerce.date(), z.coerce.bigint(), refined objects and object unions', () => {
      expect(() => defineTool({ ...base, input: z.object({ when: z.coerce.date(), n: z.coerce.bigint() }) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z4.object({ when: z4.coerce.date(), n: z4.coerce.bigint() }) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z.object({ a: z.string() }).refine(() => true) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z4.object({ a: z4.string() }).refine(() => true) })).not.toThrow();
      expect(() => defineTool({ ...base, input: z.object({ when: z.preprocess((v) => new Date(String(v)), z.date()) }) })).not.toThrow();
    });
  });
});

describe('ToolRegistry.register(tool)', () => {

  it('rejects non-defined tools and a missing descriptor', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({ displayName: 'x', tool: {} } as never)).toThrow(/defineTool/);
    // register() is overloaded; the cast narrows to the (name, descriptor) signature missing its second arg.
    expect(() => (registry.register as unknown as (n: string) => void)('x')).toThrow(/descriptor is required/);
  });
});

describe('entry points', () => {

  it('AgentBuilder.addTool(tool) keys the config by tool name', () => {
    const agent = AgentBuilder.create()
      .setName('a')
      .setPrompt('p')
      .addTool(makeEmail())
      .addTool('legacy', { tool: 'legacy' })
      .build();
    expect(agent.tools!.send_email).toEqual({ tool: 'send_email', description: 'Send an email' });
    expect(agent.tools!.legacy).toEqual({ tool: 'legacy' });
    // addTool() is overloaded; the cast narrows to the (key, config) signature missing its second arg.
    expect(() => (AgentBuilder.create().addTool as unknown as (k: string) => void)('x')).toThrow(
      /configuration is required/
    );
  });
});

describe('defineTool timeoutMs', () => {
  const hang = (onAbort: (reason: unknown) => void) =>
    defineTool({
      name: 'hang',
      description: 'never finishes on its own',
      input: z.object({}),
      timeoutMs: 50,
      execute: (_args, { abortSignal }) =>
        new Promise<string>(() => {
          abortSignal?.addEventListener('abort', () => onAbort(abortSignal.reason));
        }),
    });

  it('a call still running after timeoutMs fails with a tool error the model sees, and its abortSignal is aborted', async () => {
    let aborted: unknown;
    const model = mockModel([{ toolCalls: [{ name: 'hang' }] }, 'gave up']);
    const result = await createAgent({ provider: model, tools: [hang((reason) => (aborted = reason))], instructions: 'x' }).send('go');

    expect(result.text).toBe('gave up');
    expect(model.calls[1].messages.at(-1)).toMatchObject({ role: 'tool', isError: true, content: expect.stringContaining("timed out after 50 ms") });
    expect(aborted).toMatchObject({ code: 'LOUSHO_OPERATION_TIMEOUT' });
  });

  it('an aborted run stops waiting for a timed tool that ignores its signal', async () => {
    const slow = defineTool({ name: 'slow', description: 'ignores the signal', input: z.object({}), timeoutMs: 10_000, execute: () => new Promise(() => undefined) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow' }] }, 'never']), tools: [slow], instructions: 'x' }).send('go', {
      signal: controller.signal,
    });

    expect(result.finishReason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
