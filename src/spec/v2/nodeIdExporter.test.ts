import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Span, TraceExporter } from '../../execution/tracing';
import { GenAiAttr, GenAiOperation, SdkAttr } from '../../execution/semconv';
import { LLMProviderRegistry } from '../../providers/llm';
import { mockModel, type MockTurn } from '../../testing';
import type { SpecHost } from './host';
import { nodeIdExporter, nodeIdIndexOf, type NodeIdIndex } from './nodeIdExporter';
import { specV2ToAgent } from './specToAgent';
import type { AgentSpecV2 } from './types';

function spec(overrides: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/m', instructions: 'You are a test agent.', ...overrides };
}

function host(overrides: Partial<SpecHost> = {}): SpecHost {
  return { baseDir: mkdtempSync(path.join(tmpdir(), 'lousho-node-id-')), ...overrides };
}

let counter = 0;
function span(name: string, attributes: Record<string, unknown>, parentId?: string): Span {
  return { id: `span-${++counter}`, name, attributes, startTime: 0, parentId };
}

function recorder() {
  const started: Span[] = [];
  const ended: Span[] = [];
  const exporter: TraceExporter = { onSpanStart: (s) => void started.push(s), onSpanEnd: (s) => void ended.push(s) };
  return { started, ended, exporter };
}

const NODE_ID = SdkAttr.NODE_ID;
const OP = GenAiAttr.OPERATION_NAME;

function index(): NodeIdIndex {
  return nodeIdIndexOf(
    spec({
      tools: [{ builtin: 'current_date' }, { builtin: 'web_fetch', id: 'fetch' }],
      mcpServers: { docs: { url: 'https://x.test/mcp' } },
      memory: [{ name: 'notes', scope: 'global', provider: { type: 'in-memory' } }],
      handoffs: [{ agent: 'billing' }],
      guardrails: [{ id: 'g1', name: 'max-length', on: 'input' }],
    }),
    [['current_date'], ['web_fetch']],
    { research: nodeIdIndexOf(spec({ tools: [{ builtin: 'web_fetch' }] }), [['web_fetch']]) }
  );
}

describe('nodeIdExporter span stamping', () => {

  it('maps execute_tool spans to tool/mcp/memory/handoff node ids', () => {
    const { started, exporter } = recorder();
    const wrapped = nodeIdExporter(exporter, index());
    const run = span('invoke_agent a', { [OP]: GenAiOperation.INVOKE_AGENT });
    wrapped.onSpanStart(run);
    const tool = (name: string) => {
      const s = span(`execute_tool ${name}`, { [OP]: GenAiOperation.EXECUTE_TOOL, [GenAiAttr.TOOL_NAME]: name }, run.id);
      wrapped.onSpanStart(s);
      return s;
    };
    expect(tool('current_date').attributes[NODE_ID]).toBe('tool:current_date');
    expect(tool('web_fetch').attributes[NODE_ID]).toBe('tool:fetch');
    expect(tool('docs__search').attributes[NODE_ID]).toBe('mcp:docs');
    expect(tool('remember_notes').attributes[NODE_ID]).toBe('memory:notes');
    expect(tool('transfer_to_billing').attributes[NODE_ID]).toBe('handoff:billing');
    expect(started).toHaveLength(6);
  });

  it('stamps guardrail spans with guard:<id> of the spec entry they are named after', () => {
    const { exporter } = recorder();
    const wrapped = nodeIdExporter(exporter, index());
    const run = span('invoke_agent a', { [OP]: GenAiOperation.INVOKE_AGENT });
    wrapped.onSpanStart(run);
    // S11 names each compiled guardrail by its spec entry id, so the trip name is the id.
    const check = span(
      'guardrail g1',
      { [SdkAttr.GUARDRAIL_NAME]: 'g1', [SdkAttr.GUARDRAIL_KIND]: 'input', [SdkAttr.GUARDRAIL_OUTCOME]: 'pass' },
      run.id
    );
    wrapped.onSpanStart(check);
    expect(check.attributes[NODE_ID]).toBe('guard:g1');
    // A name the spec never declared (a code-built or inherited guardrail) gets no node id.
    const custom = span('guardrail custom', { [SdkAttr.GUARDRAIL_NAME]: 'custom' }, run.id);
    wrapped.onSpanStart(custom);
    expect(custom.attributes[NODE_ID]).toBeUndefined();
  });

  it('does not leak a run\'s active node into another run', () => {
    const { exporter } = recorder();
    const wrapped = nodeIdExporter(exporter, index());
    const a = span('invoke_agent a', { [OP]: GenAiOperation.INVOKE_AGENT });
    wrapped.onSpanStart(a);
    wrapped.onSpanStart(span('handoff billing', { [SdkAttr.HANDOFF_TO]: 'billing' }, a.id));
    const b = span('invoke_agent a', { [OP]: GenAiOperation.INVOKE_AGENT });
    wrapped.onSpanStart(b);
    const chat = span('chat m', { [OP]: GenAiOperation.CHAT }, b.id);
    wrapped.onSpanStart(chat);
    expect(chat.attributes[NODE_ID]).toBe('agent');
  });

  it('stamps `approval.wait <tool>` with the node id execute_tool would get', () => {
    const { exporter } = recorder();
    const wrapped = nodeIdExporter(exporter, index());
    const run = span('invoke_agent a', { [OP]: GenAiOperation.INVOKE_AGENT });
    wrapped.onSpanStart(run);
    const wait = span(
      'approval.wait web_fetch',
      { [GenAiAttr.TOOL_NAME]: 'web_fetch', [GenAiAttr.TOOL_CALL_ID]: 'c1', [SdkAttr.APPROVAL_ID]: 'ap1', [SdkAttr.APPROVAL_KIND]: 'tool' },
      run.id
    );
    wrapped.onSpanStart(wait);
    expect(wait.attributes[NODE_ID]).toBe('tool:fetch');
    const handoffWait = span('approval.wait transfer_to_billing', { [GenAiAttr.TOOL_NAME]: 'transfer_to_billing' }, run.id);
    wrapped.onSpanStart(handoffWait);
    expect(handoffWait.attributes[NODE_ID]).toBe('handoff:billing');
    const unknown = span('approval.wait mystery', { [GenAiAttr.TOOL_NAME]: 'mystery' }, run.id);
    wrapped.onSpanStart(unknown);
    expect(unknown.attributes[NODE_ID]).toBeUndefined();
  });
});

describe('specV2ToAgent integration', () => {
  beforeAll(() => {
    LLMProviderRegistry.register('mock', (config) =>
      config.defaultModel === 'research'
        ? mockModel([{ toolCalls: [{ name: 'web_fetch', args: { url: 'http://127.0.0.1/' } }] }, 'sub done'])
        : config.defaultModel === 'billing'
          ? mockModel(['Billed.'])
          : mockModel(leadScript)
    );
  });

  let leadScript: readonly MockTurn[] = ['done'];

  it('stamps agent, chat and tool spans of a spec run', async () => {
    leadScript = [
      {
        toolCalls: [
          { name: 'current_date', args: {} },
          { name: 'web_fetch', args: { url: 'http://127.0.0.1/' } },
        ],
      },
      'done',
    ];
    const { started, exporter } = recorder();
    const agent = await specV2ToAgent(
      spec({ tools: [{ builtin: 'current_date' }, { builtin: 'web_fetch', id: 'fetch' }] }),
      host({ exporter })
    );
    await agent.send('hi');

    const byName = (name: string) => started.filter((s) => s.name === name);
    expect(byName('invoke_agent a').map((s) => s.attributes[NODE_ID])).toEqual(['agent']);
    expect(byName('chat m').every((s) => s.attributes[NODE_ID] === 'agent')).toBe(true);
    expect(byName('execute_tool current_date').map((s) => s.attributes[NODE_ID])).toEqual(['tool:current_date']);
    expect(byName('execute_tool web_fetch').map((s) => s.attributes[NODE_ID])).toEqual(['tool:fetch']);
  });

  it('stamps a sub-agent run under sub:research with its own tools', async () => {
    leadScript = [{ toolCalls: [{ name: 'task', args: { agent: 'research', prompt: 'p', description: 'research' } }] }, 'done'];
    const { started, exporter } = recorder();
    const agent = await specV2ToAgent(
      spec({
        subagents: {
          research: {
            inline: {
              name: 'researcher',
              model: 'mock/research',
              instructions: 'Research.',
              description: 'Finds things.',
              tools: [{ builtin: 'web_fetch' }],
            },
          },
        },
      }),
      host({ exporter })
    );
    await agent.send('hi');

    const nodeIdOf = (s: Span) => s.attributes[NODE_ID];
    const subRun = started.find((s) => s.name === 'invoke_agent researcher');
    expect(subRun?.attributes[SdkAttr.SUBAGENT_NAME]).toBe('research');
    expect(nodeIdOf(subRun!)).toBe('sub:research');
    expect(started.filter((s) => s.name === 'chat research').every((s) => nodeIdOf(s) === 'sub:research')).toBe(true);
    expect(started.filter((s) => s.name === 'chat m').every((s) => nodeIdOf(s) === 'agent')).toBe(true);
    expect(started.filter((s) => s.name === 'execute_tool web_fetch').map(nodeIdOf)).toEqual(['sub:research/tool:web_fetch']);
    // `task` itself is not a spec tool: no node id.
    expect(started.find((s) => s.name === 'execute_tool task')?.attributes[NODE_ID]).toBeUndefined();
  });

  it('stamps the handoff marker handoff:billing and the run\'s later chat spans the same', async () => {
    leadScript = [{ toolCalls: [{ name: 'transfer_to_billing', args: { reason: 'charged twice' } }] }, 'done'];
    const { started, exporter } = recorder();
    const agent = await specV2ToAgent(
      spec({
        subagents: {
          billing: { inline: { name: 'billing', model: 'mock/billing', instructions: 'You bill.', description: 'Bills.' } },
        },
        handoffs: [{ agent: 'billing' }],
      }),
      host({ exporter })
    );
    await agent.send('I was charged twice');

    const marker = started.find((s) => s.name === 'handoff billing');
    expect(marker?.attributes[NODE_ID]).toBe('handoff:billing');
    // The lead's call stays 'agent'; the target's calls after the switch get 'handoff:billing'.
    const chats = started.filter((s) => s.name.startsWith('chat '));
    expect(chats.map((s) => s.attributes[NODE_ID])).toEqual(['agent', 'handoff:billing']);
  });
});
