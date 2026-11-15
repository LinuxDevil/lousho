import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import { Span, TraceExporter } from './tracing';
import { CAPTURE_CONTENT_ENV } from './semconv';
import { FlowExecutor } from '../flows/FlowExecutor';
import { ToolRegistry, defineTool } from '../tools';
import { AgentBuilder } from '../core';
import { AgentFlow } from '../types/flow';
import { mockModel } from '../testing';

/** In-memory exporter: remembers every span, in start order, in its final state. */
function memoryExporter() {
  const spans: Span[] = [];
  const exporter: TraceExporter = {
    onSpanStart: (span) => spans.push(span),
    onSpanEnd: () => undefined,
  };
  return { exporter, spans };
}

const weather = defineTool({
  name: 'get_weather',
  description: 'Get the weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

function setup(tools: ToolRegistry = new ToolRegistry()) {
  tools.register(weather);
  const agent = {
    ...AgentBuilder.create()
      .setName('Weather Bot')
      .addTool('get_weather', { tool: 'get_weather', options: {} })
      .build(),
    id: 'agent-1',
    prompt: 'You are terse.',
    settings: { model: 'test-model' },
  };
  return { agent, toolRegistry: tools };
}

function modelWithOneToolCall() {
  return mockModel([
    {
      toolCalls: [{ id: 'call_abc', name: 'get_weather', args: { city: 'Paris' } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    { text: 'It is 21C in Paris.', usage: { inputTokens: 20, outputTokens: 7 } },
  ]);
}

async function runAgent(extra: { captureContent?: boolean; redactContent?: boolean | ((text: string) => string) } = {}) {
  const { agent, toolRegistry } = setup();
  const { exporter, spans } = memoryExporter();
  const provider = modelWithOneToolCall();
  await AgentExecutor.execute({
    agent,
    input: 'Weather in Paris?',
    provider,
    toolRegistry,
    exporter,
    sessionId: 'session-9',
    temperature: 0.2,
    maxTokens: 256,
    // The deprecated content attributes are dual-emitted only on an explicit opt-out of redaction.
    redactContent: false,
    ...extra,
  });
  return { spans, provider };
}

describe('OpenTelemetry GenAI semantic conventions', () => {
  afterEach(() => {
    delete process.env[CAPTURE_CONTENT_ENV];
  });

  it('still honors redactContent for the deprecated content attributes', async () => {
    const { spans } = await runAgent({ redactContent: true });

    expect(spans[0].attributes).not.toHaveProperty('input');
    expect(spans[1].attributes).not.toHaveProperty('prompt');
    expect(spans[2].attributes).not.toHaveProperty('args');
    expect(spans[2].attributes).not.toHaveProperty('result');
    expect(spans[1].attributes['gen_ai.usage.input_tokens']).toBe(10);
  });

  it('scrubs API-key shapes from captured content when redactContent is true', async () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    await AgentExecutor.execute({
      agent: { ...agent, prompt: `Use ${key} when asked.` },
      input: `My key is ${key}`,
      provider: mockModel([
        { toolCalls: [{ id: 'call_k', name: 'get_weather', args: { city: key } }] },
        { text: `Done with ${key}` },
      ]),
      toolRegistry,
      exporter,
      captureContent: true,
      redactContent: true,
    });

    const content = spans.flatMap((s) => Object.entries(s.attributes).filter(([k]) => k.startsWith('gen_ai.')));
    expect(JSON.stringify(content)).not.toContain(key);
    const chat = spans.find((s) => s.name.startsWith('chat'))!;
    expect(JSON.parse(chat.attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'My key is [redacted]' }] },
    ]);
    expect(JSON.parse(chat.attributes['gen_ai.system_instructions'] as string)[0].content).toBe('Use [redacted] when asked.');
    const tool = spans.find((s) => s.name.startsWith('execute_tool'))!;
    expect(JSON.parse(tool.attributes['gen_ai.tool.call.arguments'] as string)).toEqual({ city: '[redacted]' });
  });

  it('scrubs captured content when redactContent is not set', async () => {
    const key = 'ghp_0123456789abcdefABCDEF0123456789';
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    await AgentExecutor.execute({ agent, input: `token ${key}`, provider: mockModel(['ok']), toolRegistry, exporter, captureContent: true });
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)[0].parts[0].content).toBe('token [redacted]');
  });

  it('applies a custom redactor function', async () => {
    const seen: string[] = [];
    const { spans } = await runAgent({
      captureContent: true,
      redactContent: (text) => {
        seen.push(text);
        return text.replace(/Paris/g, '<city>');
      },
    });

    expect(seen).toContain('Weather in Paris?');
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)[0].parts[0].content).toBe('Weather in <city>?');
    expect(JSON.parse(spans[2].attributes['gen_ai.tool.call.arguments'] as string)).toEqual({ city: '<city>' });
    expect(JSON.parse(spans[2].attributes['gen_ai.tool.call.result'] as string)).toEqual({ city: '<city>', tempC: 21 });
    // A function counts as redaction on: the deprecated attributes stay off.
    expect(spans[1].attributes).not.toHaveProperty('prompt');
  });

  it('falls back to [redacted] when a custom redactor throws, without failing the run', async () => {
    const { spans } = await runAgent({
      captureContent: true,
      redactContent: () => {
        throw new Error('boom');
      },
    });
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)[0].parts[0].content).toBe('[redacted]');
  });

  describe('tool error text', () => {
    const secret = 'abcdefghij0123456789ABCD';
    const token = 'Bearer ' + secret;
    const failing = defineTool({
      name: 'get_weather',
      description: 'Get the weather for a city',
      input: z.object({ city: z.string() }),
      execute: async () => {
        throw new Error(`upstream rejected ${token}`);
      },
    });

    async function failedToolSpan(redactContent?: boolean | ((text: string) => string)) {
      const { agent } = setup();
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(failing);
      const { exporter, spans } = memoryExporter();
      await AgentExecutor.execute({
        agent,
        input: 'Weather?',
        provider: modelWithOneToolCall(),
        toolRegistry,
        exporter,
        ...(redactContent === undefined ? {} : { redactContent }),
      });
      return spans.find((s) => s.name.startsWith('execute_tool'))!;
    }

    it('scrubs the error message on a failed tool span by default', async () => {
      const tool = await failedToolSpan();
      expect(tool.attributes.error).toContain('Bearer [redacted]');
      expect(JSON.stringify([tool.attributes, tool.status])).not.toContain(secret);
      expect(tool.status?.message).toContain('Bearer [redacted]');
    });

    it('keeps the error message under redactContent: false', async () => {
      const tool = await failedToolSpan(false);
      expect(tool.attributes.error).toContain(token);
      expect(tool.status?.message).toContain(token);
    });

    it('applies a custom redactor to the error message', async () => {
      const tool = await failedToolSpan((text) => text.replace('upstream', 'remote'));
      expect(tool.status?.message).toContain('remote rejected');
    });

    it.each([
      [false, true],
      [undefined, false],
    ])('redactContent %s keeps (%s) the provider error text on the run span', async (redactContent, keeps) => {
      const { agent, toolRegistry } = setup();
      const { exporter, spans } = memoryExporter();
      const provider = mockModel([]);
      provider.generate = async () => {
        throw new Error(`provider said ${token}`);
      };
      await AgentExecutor.execute({ agent, input: 'hi', provider, toolRegistry, exporter, ...(redactContent === undefined ? {} : { redactContent }) }).catch(() => undefined);
      const run = spans.find((s) => s.name.startsWith('invoke_agent'))!;
      const chat = spans.find((s) => s.name.startsWith('chat'))!;
      for (const span of [run, chat]) {
        expect(JSON.stringify([span.attributes.error, span.status]).includes(secret)).toBe(keeps);
      }
    });

    it('scrubs the error recorded on the run span when the run itself fails', async () => {
      const { agent, toolRegistry } = setup();
      const { exporter, spans } = memoryExporter();
      const provider = mockModel([]);
      provider.generate = async () => {
        throw new Error(`provider said ${token}`);
      };
      await AgentExecutor.execute({ agent, input: 'hi', provider, toolRegistry, exporter }).catch(() => undefined);
      const text = JSON.stringify(spans.map((s) => [s.attributes.error, s.status]));
      expect(text).toContain('provider said');
      expect(text).not.toContain(secret);
    });
  });

  it('does not scrub captured content when redactContent is false', async () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    await AgentExecutor.execute({ agent, input: key, provider: mockModel(['ok']), toolRegistry, exporter, captureContent: true, redactContent: false });
    expect(spans[0].attributes['gen_ai.input.messages']).toContain(key);
  });

  it.each([false, true, (text: string) => text] as const)(
    'encodes tool args and results as JSON.stringify does (Date as ISO, toJSON honored) with redactContent %s',
    async (redactContent) => {
      const { recordToolOutcome } = await import('./genAiSpans');
      const at = new Date('2026-10-24T12:00:00.000Z');
      const span: Span = { id: 's', name: 'execute_tool t', attributes: {}, startTime: 0 };
      const money = { toJSON: () => '12.50' };
      recordToolOutcome(span, { args: { at }, result: { at, money }, latencyMs: 1 }, { captureContent: true, redactContent });
      expect(span.attributes['gen_ai.tool.call.arguments']).toBe('{"at":"2026-10-24T12:00:00.000Z"}');
      expect(span.attributes['gen_ai.tool.call.result']).toBe('{"at":"2026-10-24T12:00:00.000Z","money":"12.50"}');
    }
  );

  it('fails on a cyclic tool result the way JSON.stringify does, whatever redactContent is', async () => {
    const { recordToolOutcome } = await import('./genAiSpans');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const redactContent of [false, true]) {
      const span: Span = { id: 's', name: 'execute_tool t', attributes: {}, startTime: 0 };
      expect(() =>
        recordToolOutcome(span, { args: {}, result: cyclic, latencyMs: 1 }, { captureContent: true, redactContent })
      ).toThrow(TypeError);
    }
  });
});

describe('traced flows', () => {
  const flow: AgentFlow = {
    code: 'weather-flow',
    name: 'Weather Flow',
    flow: {
      type: 'sequence',
      id: 'root',
      steps: [
        { type: 'toolCall', id: 'lookup', tool: 'get_weather', arguments: { city: 'Paris' }, outputVariable: 'w' },
        { type: 'llmCall', id: 'summarize', prompt: 'Summarize {{w}}', outputVariable: 'summary' },
        { type: 'return', id: 'done', value: '$summary' },
      ],
    },
  } as AgentFlow;

  function flowContext(extra: object = {}) {
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    const provider = mockModel([{ text: 'Sunny.', usage: { inputTokens: 3, outputTokens: 1 } }]);
    return {
      spans,
      context: { agent, provider, toolRegistry, variables: {}, exporter, ...extra },
    };
  }

  it('records no content attributes unless captureContent is set', async () => {
    const off = flowContext();
    await FlowExecutor.execute(flow, off.context);
    expect(off.spans[5].attributes).not.toHaveProperty('gen_ai.input.messages');
    expect(off.spans[3].attributes).not.toHaveProperty('gen_ai.tool.call.arguments');

    const on = flowContext({ captureContent: true });
    await FlowExecutor.execute(flow, on.context);
    expect(on.spans[5].attributes).toHaveProperty('gen_ai.input.messages');
    expect(on.spans[3].attributes['gen_ai.tool.call.arguments']).toBe(JSON.stringify({ city: 'Paris' }));
  });
});
