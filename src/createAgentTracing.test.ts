/**
 * CreateAgent({ exporter, captureContent }) traces every kind of run:
 * send(), stream(), agent.approvals.resolve() and agent.resume().
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { PropagatingToolError } from './execution/AgentExecutor';
import { observeExporterFromEnv } from './observe/reporter';
import { fileTraceExporter } from './traces/fileTraceExporter';
import type { TraceLine } from './traces/format';
import { type Span, type TraceExporter } from './execution/tracing';
import { memoryStore } from './storage/agentStore';
import { mockModel } from './testing';
import { defineTool } from './tools/defineTool';

/** An exporter that keeps the spans it was told about. */
function recording(): TraceExporter & { ended: Span[] } {
  const ended: Span[] = [];
  return { ended, onSpanStart: () => {}, onSpanEnd: (span) => ended.push({ ...span }) };
}

const op = (span: Span) => span.attributes['gen_ai.operation.name'];

describe('createAgent({ exporter })', () => {

  describe('redactContent', () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'Looks something up',
      input: z.object({ q: z.string() }),
      execute: async ({ q }) => `result for ${q}`,
    });
    const agent = (options: Omit<Parameters<typeof createAgent>[0], 'provider' | 'tools'>) =>
      createAgent({
        provider: mockModel([{ toolCalls: [{ name: 'lookup', args: { q: 'private-query' }, id: 'call_1' }] }, 'Done.']),
        tools: [lookup],
        ...options,
      });
    const attributeValues = (span: Span) => Object.values(span.attributes).map((value) => JSON.stringify(value));

    it('keeps prompt and tool IO off the spans when set on createAgent', async () => {
      const exporter = recording();
      await agent({ exporter, redactContent: true }).send('the prompt');

      const run = exporter.ended.find((span) => op(span) === 'invoke_agent')!;
      const chat = exporter.ended.filter((span) => op(span) === 'chat');
      const tool = exporter.ended.find((span) => op(span) === 'execute_tool')!;
      expect(chat).toHaveLength(2);
      for (const span of [run, ...chat, tool]) {
        expect(span.attributes).not.toHaveProperty('input');
        expect(span.attributes).not.toHaveProperty('prompt');
        expect(span.attributes).not.toHaveProperty('args');
        expect(span.attributes).not.toHaveProperty('result');
        for (const value of attributeValues(span)) {
          expect(value).not.toContain('the prompt');
          expect(value).not.toContain('private-query');
          expect(value).not.toContain('result for private-query');
        }
      }
      // Non-content fields are never redacted.
      expect(tool.attributes['gen_ai.tool.name']).toBe('lookup');
      expect(chat[0].attributes['gen_ai.response.finish_reasons']).toBeDefined();
    });

    const traceFileText = (dir: string) =>
      fs
        .readdirSync(dir)
        .flatMap((day) => fs.readdirSync(path.join(dir, day)).map((name) => fs.readFileSync(path.join(dir, day, name), 'utf8')))
        .join('');

    it('keeps prompt and tool IO out of the .lousho/traces files by default', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
      try {
        await agent({ exporter: fileTraceExporter({ dir }), instructions: 'system-secret' }).send('the prompt');

        const text = traceFileText(dir);
        expect(text.length).toBeGreaterThan(0);
        for (const secret of ['the prompt', 'system-secret', 'private-query', 'result for private-query']) {
          expect(text).not.toContain(secret);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records the deprecated content attributes only when redactContent is false', async () => {
      const exporter = recording();
      await agent({ exporter, redactContent: false }).send('the prompt');

      const run = exporter.ended.find((span) => op(span) === 'invoke_agent')!;
      const tool = exporter.ended.find((span) => op(span) === 'execute_tool')!;
      expect(JSON.stringify(run.attributes.input)).toContain('the prompt');
      expect(tool.attributes.args).toEqual({ q: 'private-query' });
      expect(tool.attributes.result).toBe('result for private-query');
    });

    it('keeps prompt and tool IO out of the .lousho/traces files', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
      try {
        await agent({ exporter: fileTraceExporter({ dir }), redactContent: true }).send('the prompt');

        const lines = fs
          .readdirSync(dir)
          .flatMap((day) => fs.readdirSync(path.join(dir, day)).map((name) => fs.readFileSync(path.join(dir, day, name), 'utf8')))
          .flatMap((text) => text.trim().split('\n').map((line) => JSON.parse(line) as TraceLine));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          const attributes = JSON.stringify(line.attributes);
          expect(attributes).not.toContain('the prompt');
          expect(attributes).not.toContain('private-query');
          expect(attributes).not.toContain('result for private-query');
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('captureContent default on a local collector', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  /** The ingest bodies the env reporter POSTed; each test gets a fresh reporter through a unique agent name. */
  let posted: string[] = [];
  let names = 0;
  const observe = (value: string) => {
    posted = [];
    vi.stubEnv('LOUSHO_OBSERVE', value);
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response('{}', { status: 200 });
    });
  };
  const daemonText = async (name: string) => {
    await observeExporterFromEnv({ agentName: name })?.flush();
    return posted.join('');
  };
  const chatInput = async (options: { captureContent?: boolean; redactContent?: boolean } = {}) => {
    const exporter = recording();
    const name = `content-default-${++names}`;
    await createAgent({ name, provider: mockModel(['Hi.']), exporter, ...options }).send('my key is sk-secret123');
    return { chat: exporter.ended.find((span) => op(span) === 'chat')!, daemon: await daemonText(name) };
  };

  it('redactContent: false records the deprecated prompt next to the loopback-captured content', async () => {
    observe('1');
    const { chat, daemon } = await chatInput({ redactContent: false });
    expect(chat.attributes.prompt).toBeDefined();
    expect(daemon).toContain('my key is');
  });

  it('redactContent: true keeps the deprecated prompt off while the daemon still gets gen_ai content', async () => {
    observe('1');
    const { chat, daemon } = await chatInput({ redactContent: true });
    expect(chat.attributes.prompt).toBeUndefined();
    expect(daemon).toContain('my key is');
  });

  it('resume() captures content for the loopback daemon by default', async () => {
    observe('1');
    const store = memoryStore();
    let crashed = false;
    const flaky = defineTool({
      name: 'flaky',
      description: 'Dies once',
      input: z.object({}),
      execute: async () => {
        if (!crashed) {
          crashed = true;
          throw new PropagatingToolError('process died');
        }
        return 'ok';
      },
    });
    const name = `content-default-${++names}`;
    const crashing = createAgent({ name, provider: mockModel([{ toolCalls: [{ name: 'flaky', id: 'c1' }] }]), tools: [flaky], store });
    await expect(crashing.send('Go', { sessionId: 'job' })).rejects.toThrow('process died');
    const exporter = recording();
    await createAgent({ name, provider: mockModel(['Done.']), tools: [flaky], store, exporter }).resume('job');
    expect(exporter.ended.find((span) => op(span) === 'chat')!.attributes['gen_ai.output.messages']).toBeUndefined();
    expect(await daemonText(name)).toContain('Done.');
  });
});

describe('createAgent({ spanAttributes })', () => {
  it('labels become attributes; unlabeled agents emit none', async () => {
    const labeled = recording();
    await createAgent({ name: 'a', provider: mockModel(['Hi.']), exporter: labeled, spanAttributes: { 'lousho.page': 'instagram', 'lousho.step.index': 2 } }).send('Hello');
    const unlabeled = recording();
    await createAgent({ name: 'a', provider: mockModel(['Hi.']), exporter: unlabeled }).send('Hello');

    const root = (spans: Span[]) => spans.find((span) => op(span) === 'invoke_agent')!.attributes;
    expect(root(labeled.ended)).toMatchObject({ 'lousho.page': 'instagram', 'lousho.step.index': 2 });
    expect(Object.keys(root(unlabeled.ended)).filter((key) => /^lousho\.(workspace|page|attachment|execution_type|step|harness\.(hash|part_hash)|agent\.ref)/.test(key))).toEqual([]);
  });
});
