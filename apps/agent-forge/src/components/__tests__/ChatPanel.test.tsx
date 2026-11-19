import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_INPUT } from '../../../shared/runInput';
import type { ChatMessage, LogEntry } from '../../../shared/wireTypes';
import { Bubble, RunSetupLine } from '../ChatPanel';

const user = (content: string, source?: ChatMessage['source']): ChatMessage => ({
  id: 'm1',
  role: 'user',
  content,
  timestamp: '2026-01-01T00:00:00Z',
  ...(source ? { source } : {}),
});

const html = (message: ChatMessage) => renderToStaticMarkup(<Bubble message={message} toolResults={new Map()} />);

describe('Bubble', () => {
  it('shows a Run started marker, not the default run input, for the Run button turn', () => {
    const out = html(user(DEFAULT_RUN_INPUT, 'run'));
    expect(out).toContain('Run started');
    expect(out).not.toContain(DEFAULT_RUN_INPUT);
    expect(out).not.toContain('chat-bubble');
  });

  it('still shows typed run input', () => {
    const out = html(user('Summarise the inbox', 'run'));
    expect(out).toContain('Run input');
    expect(out).toContain('Summarise the inbox');
  });

  it('shows an ordinary user message as a bubble', () => {
    const out = html(user('hello'));
    expect(out).toContain('hello');
    expect(out).not.toContain('Run started');
  });
});

describe('RunSetupLine', () => {
  const row = (message: string, detail?: string): LogEntry => ({ id: 'l', agentId: 'a', timestamp: '2026-01-01T00:00:00Z', level: 'info', phase: 'trigger', message, detail });

  it('shows the latest setup row with its detail', () => {
    const out = renderToStaticMarkup(
      <RunSetupLine
        logs={[
          row('Setup · No connected accounts. Connect one in Profile → Connectors. · 0 tools'),
          row('Run started'),
          row('Setup · 1 connected account (github) · 3 tools', 'github: github_list_my_repositories (ask for approval: github_create_repository)\nAtlassian is missing its API token.'),
        ]}
      />
    );
    expect(out).toContain('<summary>Setup · 1 connected account (github) · 3 tools</summary>');
    expect(out).toContain('github_create_repository');
    expect(out).toContain('Atlassian is missing its API token.');
    expect(out).not.toContain('No connected accounts');
  });

  it('renders nothing without a setup row', () => {
    expect(renderToStaticMarkup(<RunSetupLine logs={[row('Run started')]} />)).toBe('');
  });
});
