import { describe, it, expect } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { render } from '../../ui/__tests__/render';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../AgentNode';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { GraphNode } from '../../graph/v2/types';

const graph = specToGraph({
  version: 2,
  name: 'support-bot',
  model: 'openai/gpt-4o-mini',
  instructions: 'p',
  tools: [{ builtin: 'http' }],
  skills: [{ dir: 'skills/review' }],
  guardrails: [{ id: 'g1', name: 'max-length', on: 'input' }],
  abortListeners: [{ id: 'a1', triggerId: 't1', when: 'event.x', match: 'run.y', scope: 'both' }],
} as unknown as Parameters<typeof specToGraph>[0]);
const nodeOf = (kind: GraphNode['kind']) => graph.nodes.find((n) => n.kind === kind)!;

/** A `flow` node built by hand — specToGraph does not emit flow nodes yet (C15), and `flow` is the one kind still on the generic view. */
const flowNode: GraphNode = {
  id: 'flow:e1',
  kind: 'flow',
  owner: 'agent',
  position: { x: 0, y: 0 },
  data: { step: { type: 'end', id: 'e1' }, children: { shape: 'none' } },
};

/** The `agent` node of a spec built just for this test (fields as given). */
function agentOf(over: Record<string, unknown>): GraphNode {
  return specToGraph({
    version: 2,
    name: 'a',
    model: 'mock/mock-1',
    instructions: 'x',
    ...over,
  } as Parameters<typeof specToGraph>[0]).nodes[0];
}

function renderCard(graphNode: GraphNode, extra: Partial<CanvasNodeData> = {}): HTMLElement {
  const Card = NODE_TYPES[flowNodeType(graphNode.kind)];
  const data: CanvasNodeData = { graphNode, ...extra };
  const props = { id: graphNode.id, type: flowNodeType(graphNode.kind), data, selected: false } as unknown as NodeProps;
  const container = render(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>
  );
  return container.querySelector('.rf-node') as HTMLElement;
}

describe('tool card (KindView)', () => {
  const toolNodeOf = (item: unknown) =>
    specToGraph({
      version: 2,
      name: 'a',
      model: 'mock/mock-1',
      instructions: 'x',
      tools: [item],
    } as Parameters<typeof specToGraph>[0]).nodes.find((n) => n.kind === 'tool')!;

  const rowText = (card: HTMLElement, key: string) =>
    [...card.querySelectorAll('.node-row')].find((r) => r.firstElementChild?.textContent === key)
      ?.querySelector('code')?.textContent;

  it('shows the approval and on-demand rows', () => {
    const card = renderCard(toolNodeOf({ builtin: 'web_fetch', approval: 'always', deferLoading: true }));
    expect(rowText(card, 'approval')).toBe('always ask');
    expect(rowText(card, 'loading')).toBe('on demand');
  });

  it('shows the registry version and the OpenAPI host rows', () => {
    const registry = renderCard(toolNodeOf({ registry: 'github-issues', version: '1.2.0' }));
    expect(registry.querySelector('.node-chip')?.textContent).toBe('registry');
    expect(rowText(registry, 'version')).toBe('1.2.0');
    const openapi = renderCard(toolNodeOf({ openapi: { url: 'https://api.example.com/openapi.json' } }));
    expect(rowText(openapi, 'host')).toBe('api.example.com');
  });

  it.each([
    [{ hub: true }, 'hub', 'hub'],
  ])('titles and chips the card for %j', (item, title, chip) => {
    const card = renderCard(toolNodeOf(item));
    expect(card.querySelector('.rf-node-title')?.textContent).toBe(title);
    expect(card.querySelector('.node-chip')?.textContent).toBe(chip);
  });
});

describe('AgentNode card', () => {

  it('draws both ports and the neutral kind tile of the generic view', () => {
    const card = renderCard(flowNode, { status: 'done' });
    expect(card.querySelector('.rf-port-in')).not.toBeNull();
    expect(card.querySelector('.rf-port-out')).not.toBeNull();
    expect(card.querySelector('.node-kind')?.classList.contains('kind-neutral')).toBe(true);
    expect(card.querySelector('.node-kind svg')).not.toBeNull();
    expect(card.classList.contains('running')).toBe(false);
  });
});

describe('proposal overlay classes (C21)', () => {
  const proposed = (kind: GraphNode['kind'], flag: 'add' | 'remove' | 'edit'): GraphNode => ({
    ...nodeOf(kind),
    proposed: flag,
  });

  it('shows the "edited" chip only on an edited node', () => {
    const edited = renderCard(proposed('tool', 'edit'));
    const chip = edited.querySelector('.node-chip-edited');
    expect(chip?.textContent).toBe('edited');
    for (const flag of ['add', 'remove'] as const) {
      expect(renderCard(proposed('tool', flag)).querySelector('.node-chip-edited')).toBeNull();
    }
    expect(renderCard(nodeOf('tool')).querySelector('.node-chip-edited')).toBeNull();
  });
});

describe('agent card (KindView)', () => {
  const rowText = (card: HTMLElement, key: string) =>
    [...card.querySelectorAll('.node-row')].find((r) => r.firstElementChild?.textContent === key)
      ?.querySelector('code')?.textContent;

  it('falls back to "(unnamed)" without a name and hides the chip without a model', () => {
    const card = renderCard(agentOf({ name: '', model: '' }));
    expect(card.querySelector('.rf-node-title')?.textContent).toBe('(unnamed)');
    expect(card.querySelector('.node-chip')).toBeNull();
  });

  it('shows a file instruction as "file: <path>"', () => {
    const card = renderCard(agentOf({ instructions: { file: 'prompts/main.md' } }));
    expect(rowText(card, 'instructions')).toBe('file: prompts/main.md');
  });

  it('shows promptRef and a token-budget reasoning row', () => {
    const card = renderCard(agentOf({ promptRef: 'triage@prod', reasoning: { budgetTokens: 4096 } }));
    expect(rowText(card, 'prompt')).toBe('triage@prod');
    expect(rowText(card, 'reasoning')).toBe('4096 tokens');
  });
});
