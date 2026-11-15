import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import { InspectorSection } from '../InspectorSection';

const toggle = (container: HTMLElement) => container.querySelector('button[aria-expanded]') as HTMLButtonElement;

beforeEach(() => {
  installMemoryStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('InspectorSection', () => {

  it('still toggles when storage throws', () => {
    breakStorage();
    const container = render(<InspectorSection id="hooks" title="Hooks">content</InspectorSection>);
    expect(toggle(container).getAttribute('aria-expanded')).toBe('true');
    act(() => toggle(container).click());
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false');
  });
});
