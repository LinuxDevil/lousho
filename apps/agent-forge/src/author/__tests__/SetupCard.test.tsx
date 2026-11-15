import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';

const mocks = vi.hoisted(() => ({ chat: null as unknown as import('../AuthorChatContext').AuthorChat }));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => mocks.chat }));
import { SetupCard } from '../SetupCard';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import { render } from '../../ui/__tests__/render';

beforeEach(() => {
  installMemoryStorage();
  window.location.hash = '#/';
});

describe('SetupCard', () => {

  it('names OpenAI and OpenRouter keys', () => {
    let c = render(<SetupCard model="openai/gpt-5" missingKeyFor="openai" onRecheck={vi.fn()} />);
    expect(c.querySelector('.setup-card-hint')?.textContent).toContain('Add an OpenAI key in Settings');
    c = render(<SetupCard model="openrouter/anthropic/claude-sonnet-5-5" missingKeyFor="openrouter" onRecheck={vi.fn()} />);
    expect(c.querySelector('.setup-card-hint')?.textContent).toContain('Add an OpenRouter key in Settings');
  });

  it('Open Settings navigates to /settings and Check again calls onRecheck', () => {
    const onRecheck = vi.fn();
    const c = render(<SetupCard model="anthropic/claude-sonnet-5-5" onRecheck={onRecheck} />);
    const buttons = [...c.querySelectorAll<HTMLButtonElement>('.setup-card-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Open Settings', 'Check again']);
    act(() => buttons[0]!.click());
    expect(window.location.hash).toBe('#/settings');
    act(() => buttons[1]!.click());
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
