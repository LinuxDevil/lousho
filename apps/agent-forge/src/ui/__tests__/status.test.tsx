import { describe, expect, it } from 'vitest';

import { render as mount } from './render';

import { STATUS_CONFIG, statusKey, statusToneClass, type StatusKey } from '../status';
import { StatusBadge, StatusDot } from '../StatusBadge';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

describe('statusKey', () => {
  const vocabulary: [string | null | undefined, StatusKey][] = [
    ['queued', 'queued'],
    ['running', 'running'],
    ['paused', 'waiting'],
    ['awaiting_approval', 'waiting'],
    ['waiting', 'waiting'],
    ['blocked', 'waiting'],
    ['done', 'done'],
    ['ok', 'done'],
    ['completed', 'done'],
    ['pass', 'done'],
    ['success', 'done'],
    ['error', 'error'],
    ['failed', 'error'],
    ['fail', 'error'],
    ['stopped', 'stopped'],
    ['aborted', 'stopped'],
    ['cancelled', 'stopped'],
    ['interrupted', 'stopped'],
    ['timed_out', 'timed_out'],
    ['timeout', 'timed_out'],
    ['expired', 'timed_out'],
    ['enabled', 'enabled'],
    ['disabled', 'disabled'],
    ['draft', 'draft'],
    ['published', 'published'],
    ['idle', 'unknown'],
    ['constructor', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ];
  it('maps every status in the vocabulary to its key', () => {
    for (const [raw, key] of vocabulary) expect(statusKey(raw), String(raw)).toBe(key);
  });
});

describe('STATUS_CONFIG', () => {

  it('gives a badge and a dot for the same key the same tone class', () => {
    for (const key of Object.keys(STATUS_CONFIG) as StatusKey[]) {
      render(
        <>
          <StatusBadge status={key} />
          <StatusDot status={key} />
        </>,
      );
      const tone = statusToneClass(key);
      expect(container.querySelector('.status-badge')?.classList.contains(tone)).toBe(true);
      expect(container.querySelector('.status-dot')?.classList.contains(tone)).toBe(true);
    }
  });
});
