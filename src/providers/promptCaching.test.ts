/**
 * Anthropic prompt-cache breakpoints, as the AI SDK's
 * `providerOptions` (AnthropicProvider) and as an OpenRouter body rewrite.
 */

import { describe, expect, it } from 'vitest';
import { cachesPrompt, isAnthropicModel, withBodyBreakpoints } from './promptCaching';

const ephemeral = { type: 'ephemeral' };

describe('which models get breakpoints', () => {
  it('Claude models, directly or through OpenRouter, unless promptCaching is false', () => {
    expect(isAnthropicModel('claude-haiku-4-5')).toBe(true);
    expect(isAnthropicModel('anthropic/claude-haiku-4.5')).toBe(true);
    expect(isAnthropicModel('openai/gpt-4o-mini')).toBe(false);
    expect(cachesPrompt('anthropic/claude-haiku-4.5', undefined)).toBe(true);
    expect(cachesPrompt('anthropic/claude-haiku-4.5', 'auto')).toBe(true);
    expect(cachesPrompt('anthropic/claude-haiku-4.5', false)).toBe(false);
    expect(cachesPrompt('gpt-4o-mini', 'auto')).toBe(false);
  });
});

describe('withBodyBreakpoints (OpenRouter body)', () => {
  it('marks the system prompt, the last function tool and the last user turn', () => {
    const body = withBodyBreakpoints({
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] },
      ],
      tools: [
        { type: 'function', function: { name: 'a' } },
        { type: 'function', function: { name: 'b' } },
        { type: 'openrouter:web_search' },
      ],
    });
    expect(body.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'rules', cache_control: ephemeral }] },
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: ephemeral }, { type: 'image_url', image_url: { url: 'x' } }] },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'a' } },
      { type: 'function', function: { name: 'b' }, cache_control: ephemeral },
      { type: 'openrouter:web_search' },
    ]);
  });

  it('marks no empty text, and no trailing tool or assistant turn', () => {
    const messages = [
      { role: 'system', content: '' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', content: 'r', tool_call_id: '1' },
    ];
    expect(withBodyBreakpoints({ messages }).messages).toEqual(messages);
  });
});
