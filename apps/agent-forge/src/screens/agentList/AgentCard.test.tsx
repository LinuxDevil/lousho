import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentCard, type AgentCardAgent } from './AgentCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render(agent: Partial<AgentCardAgent>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const full = {
    id: 'ops',
    name: 'Ops',
    description: '',
    model: 'mock/mock-1',
    enabled: true,
    labels: [],
    updatedAt: new Date(0).toISOString(),
    publishedVersion: null,
    ...agent,
  } as AgentCardAgent;
  act(() => root!.render(<ul><AgentCard agent={full} onOpen={() => {}} onToggleEnabled={() => {}} /></ul>));
}

const chips = () => [...container.querySelectorAll('.agent-card-caps li')].map((li) => li.textContent);

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe('AgentCard capability chips', () => {
  it('shows a chip per reachable account next to the MCP server count', () => {
    render({ accounts: ['github', 'jira'], counts: { tools: 0, mcpServers: 1, subagents: 0 } });
    expect(chips()).toEqual(['github', 'jira', '1 MCP server']);
  });

  it('shows account chips even when the list payload has no counts', () => {
    render({ accounts: ['github'] });
    expect(chips()).toEqual(['github']);
  });

  it('shows no chip row for an agent that reaches nothing', () => {
    render({ accounts: [], counts: { tools: 0, mcpServers: 0, subagents: 0 } });
    expect(container.querySelector('.agent-card-caps')).toBeNull();
  });
});
