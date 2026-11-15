import { act } from 'react';
import { type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { navigate } from '../router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  window.history.replaceState(null, '', '/?token=secret');
});
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  window.history.replaceState(null, '', '/');
});

describe('navigate', () => {
  it('takes a target that already starts with # (no ##)', async () => {
    navigate('#/traces/t1');
    await tick();
    expect(window.location.hash).toBe('#/traces/t1');
    navigate('#agents');
    await tick();
    expect(window.location.hash).toBe('#/agents');
  });
});
