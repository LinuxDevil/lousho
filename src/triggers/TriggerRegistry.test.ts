import { describe, it, expect, vi } from 'vitest';
import { TriggerRegistry } from './TriggerRegistry';
import { TriggerAdapter } from './types';

function makeAdapter(type: string): TriggerAdapter {
  return {
    type,
    listen: vi.fn().mockReturnValue({ stop: vi.fn() }),
  };
}

describe('TriggerRegistry', () => {

  it('overwrites an existing registration under the same name and warns', () => {
    const registry = new TriggerRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeAdapter('webhook');
    const second = makeAdapter('webhook');
    registry.register('webhook', first);
    registry.register('webhook', second);
    expect(registry.get('webhook')).toBe(second);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('unregister() removes an adapter and returns true, false if absent', () => {
    const registry = new TriggerRegistry();
    registry.register('webhook', makeAdapter('webhook'));
    expect(registry.unregister('webhook')).toBe(true);
    expect(registry.has('webhook')).toBe(false);
    expect(registry.unregister('webhook')).toBe(false);
  });

  it('clear() removes all adapters', () => {
    const registry = new TriggerRegistry();
    registry.register('a', makeAdapter('a'));
    registry.register('b', makeAdapter('b'));
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(registry.size()).toBe(0);
  });
});
