import { describe, expect, it } from 'vitest';
import { matchShortcut } from '../shortcuts';

describe('matchShortcut', () => {
  it('ignores autofill keydown events that carry no key', () => {
    const e = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '', target: null } as unknown as KeyboardEvent;
    expect(() => matchShortcut(e)).not.toThrow();
  });

  it('still matches Cmd+K', () => {
    const e = { ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: 'k', code: 'KeyK', target: null } as unknown as KeyboardEvent;
    expect(matchShortcut(e)).toBe('palette');
  });
});
