import { describe, expect, it, vi } from 'vitest';

import { AgentCard, lastRunLabel, type AgentCardAgent } from '../AgentCard';
import { render } from '../../../ui/__tests__/render';

const NOW = Date.parse('2026-10-29T12:00:00Z');

const agent: AgentCardAgent = {
  id: 'support-bot',
  name: 'Support bot',
  description: 'Answers billing questions.',
  model: 'anthropic/claude-sonnet-5-5',
  enabled: true,
  labels: ['billing', 'tier-1', 'eu', 'vip', 'beta'],
  updatedAt: '2026-10-29T11:00:00Z',
  publishedVersion: 3,
  lastRun: { status: 'error', at: '2026-10-29T11:57:00Z', traceId: 't1' },
  counts: { tools: 3, mcpServers: 1, subagents: 0 },
};

function setup(overrides: Partial<AgentCardAgent> = {}, props: { toggling?: boolean } = {}) {
  const onOpen = vi.fn();
  const onToggleEnabled = vi.fn();
  const host = render(
    <AgentCard
      agent={{ ...agent, ...overrides }}
      onOpen={onOpen}
      onToggleEnabled={onToggleEnabled}
      now={NOW}
      toggling={props.toggling}
    />
  );
  return { host, onOpen, onToggleEnabled };
}

describe('AgentCard', () => {

  it('renders the violet subagent chip with the right plural', () => {
    const { host } = setup({ counts: { tools: 1, mcpServers: 2, subagents: 2 } });
    const caps = [...host.querySelectorAll('.agent-card-cap')];
    expect(caps.map((c) => c.textContent)).toEqual(['1 tool', '2 MCP servers', '2 subagents']);
    expect(caps[2].classList.contains('agent-card-cap-violet')).toBe(true);
  });

  it('shows Never run, no caps and no description paragraph when those are absent', () => {
    const { host } = setup({ lastRun: undefined, counts: undefined, description: '' });
    expect(host.querySelector('.agent-card-never')!.textContent).toBe('Never run');
    expect(host.querySelector('.agent-card-caps')).toBeNull();
    expect(host.querySelector('p.agent-card-description')).toBeNull();
  });

  it('omits the time element when a timestamp does not parse', () => {
    const { host } = setup({ lastRun: { status: 'done', at: 'not-a-date' } });
    const foot = host.querySelector('.agent-card-foot')!;
    expect(foot.textContent).toContain('Last run succeeded');
    // The unparseable run time is omitted; only the valid "Updated" time remains.
    expect(foot.querySelector('time[dateTime="not-a-date"]')).toBeNull();
    expect(foot.querySelectorAll('time')).toHaveLength(1);
  });
});

describe('lastRunLabel', () => {
  it.each([
    ['idle', 'Last run'],
  ])('maps %s to "%s"', (status, label) => {
    expect(lastRunLabel(status)).toBe(label);
  });
});
