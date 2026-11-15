import { describe, it, expect } from 'vitest';
import { upgradeSpec } from './upgrade';

const v1 = { name: 'bot', prompt: 'Hi', provider: { type: 'anthropic', model: 'claude-sonnet-5-5' } };

describe('upgradeSpec', () => {

  it('maps every phase/point combination to the v2 hook point name', () => {
    const combos = [
      ['pre', 'toolCall', 'preToolCall'],
      ['pre', 'generate', 'preGenerate'],
      ['post', 'toolCall', 'postToolCall'],
      ['post', 'generate', 'postGenerate'],
    ] as const;
    for (const [phase, point, expected] of combos) {
      const upgraded = upgradeSpec({ ...v1, policy: { hooks: [{ id: 'h', name: 'n', phase, point, code: 'c' }] } });
      expect(upgraded.hooks).toEqual([{ id: 'h', inline: { name: 'n', point: expected, code: 'c' } }]);
    }
  });

  it('adds t1... ids to triggers and renames a cron input to prompt', () => {
    const upgraded = upgradeSpec({
      ...v1,
      triggers: [
        { type: 'cron', cron: '0 9 * * *', input: 'Go' },
        { type: 'webhook', path: '/x' },
      ],
    });
    expect(upgraded.triggers).toEqual([
      { id: 't1', type: 'cron', cron: '0 9 * * *', prompt: 'Go' },
      { id: 't2', type: 'webhook', path: '/x' },
    ]);
  });
});
