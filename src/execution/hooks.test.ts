import { describe, it, expect, vi } from 'vitest';
import { HookRegistry, AgentHook } from './hooks';

function makeHook(name: string, overrides: Partial<AgentHook> = {}): AgentHook {
  return { name, ...overrides };
}

describe('HookRegistry', () => {
  it('registers, looks up, lists, and unregisters hooks', () => {
    const registry = new HookRegistry();
    const a = makeHook('a');
    const b = makeHook('b');

    registry.register(a);
    registry.register(b);

    expect(registry.size()).toBe(2);
    expect(registry.has('a')).toBe(true);
    expect(registry.get('a')).toBe(a);
    expect(registry.list()).toEqual([a, b]);

    expect(registry.unregister('a')).toBe(true);
    expect(registry.has('a')).toBe(false);
    expect(registry.size()).toBe(1);

    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('overwrites a hook registered under an existing name and warns', () => {
    const registry = new HookRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeHook('dup');
    const second = makeHook('dup');

    registry.register(first);
    registry.register(second);

    expect(registry.size()).toBe(1);
    expect(registry.get('dup')).toBe(second);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('runs preGenerate/postGenerate hooks and allows message injection', async () => {
    const registry = new HookRegistry();
    registry.register(
      makeHook('inject-context', {
        preGenerate: (ctx) => {
          ctx.request.messages.push({ role: 'system', content: 'injected' });
        },
      })
    );

    const request = { model: 'gpt-4', messages: [{ role: 'user' as const, content: 'hi' }] };
    await registry.runPreGenerate({ messages: request.messages, request });

    expect(request.messages).toHaveLength(2);
    expect(request.messages[1]).toEqual({ role: 'system', content: 'injected' });

    const postSpy = vi.fn();
    registry.register(makeHook('observer', { postGenerate: postSpy }));
    const genResult = {
      text: 'hello',
      finishReason: 'stop' as const,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    await registry.runPostGenerate({ messages: request.messages, request }, genResult);
    expect(postSpy).toHaveBeenCalledWith({ messages: request.messages, request }, genResult);
  });
});
