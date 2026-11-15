import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../../__tests__/render';

import type { ObserveObservationRow, ObserveScoreRow } from '../../../observe/types';
import { RunInspector } from '../RunInspector';
import { RunTree } from '../RunTree';
import { Waterfall } from '../Waterfall';

const T0 = 1_700_000_000_000;

function obs(over: Partial<ObserveObservationRow> & { obs_id: string }): ObserveObservationRow {
  return {
    trace_id: 'tr1',
    session_id: null,
    agent_id: null,
    parent_obs_id: null,
    kind: 'span',
    name: over.obs_id,
    start: T0,
    end: T0 + 100,
    status: 'ok',
    input: null,
    output: null,
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...over,
  };
}

function score(over: Partial<ObserveScoreRow> & { score_id: string }): ObserveScoreRow {
  return { trace_id: 'tr1', obs_id: null, name: 'quality', value: 1, source: 'human', comment: null, agent_id: null, created_at: T0, ...over };
}

const LONG_NAME = 'a-really-long-step-name-that-must-never-be-clipped-by-the-tree-row-'.repeat(3);

const TRACE: ObserveObservationRow[] = [
  obs({ obs_id: 'root', kind: 'span', name: 'agent run', start: T0, end: T0 + 2000 }),
  obs({
    obs_id: 'gen/1',
    parent_obs_id: 'root',
    kind: 'generation',
    name: LONG_NAME,
    start: T0 + 100,
    end: T0 + 900,
    model: 'gpt-4o-mini',
    usage_input_tokens: 1200,
    usage_output_tokens: 34,
  }),
  obs({ obs_id: 'tool1', parent_obs_id: 'gen/1', kind: 'tool', name: 'get_weather', start: T0 + 950, end: T0 + 1500 }),
  obs({ obs_id: 'ev1', parent_obs_id: 'root', kind: 'event', name: 'checkpoint', start: T0 + 1600, end: T0 + 1600 }),
  obs({ obs_id: 'odd', parent_obs_id: 'root', kind: 'mystery', name: 'custom', start: T0 + 1700, end: T0 + 1800 }),
];

const row = (c: HTMLElement, id: string) => c.querySelector(`[data-obs-id="${id}"]`) as HTMLElement;

describe('RunTree', () => {

  it('virtualises above 500 observations and renders plain rows at 500', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => obs({ obs_id: `o${i}`, start: T0 + i, end: T0 + i + 1 }));
    let c = render(<RunTree observations={many(500)} onSelect={() => {}} />);
    expect(c.querySelector('.run-virtual')).toBeNull();
    expect(c.querySelectorAll('.run-tree-row')).toHaveLength(500);
    c = render(<RunTree observations={many(501)} onSelect={() => {}} />);
    expect(c.querySelector('.run-virtual')).not.toBeNull();
    const rendered = c.querySelectorAll('.run-tree-row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
    // Virtualised rows keep the full name in a tooltip.
    expect((c.querySelector('.run-row-virtual .run-name') as HTMLElement).title).toBe('o0');
  });
});

describe('Waterfall', () => {

  it('extends an open bar to now and paints an error bar red', () => {
    const rows = [
      obs({ obs_id: 'root', start: T0, end: null, status: null }),
      obs({ obs_id: 'bad', parent_obs_id: 'root', status: 'error', start: T0, end: T0 + 500 }),
    ];
    const c = render(<Waterfall observations={rows} onSelect={() => {}} now={T0 + 1000} />);
    const open = row(c, 'root').querySelector('.run-wf-bar') as HTMLElement;
    expect(open.style.width).toBe('100%');
    expect(open.classList.contains('running')).toBe(true);
    expect(row(c, 'bad').querySelector('.run-wf-bar.error')).not.toBeNull();
    expect(row(c, 'bad').classList.contains('run-row-error')).toBe(true);
  });

  it('selects a row on click', () => {
    const onSelect = vi.fn();
    const c = render(<Waterfall observations={TRACE} onSelect={onSelect} />);
    act(() => row(c, 'tool1').click());
    expect(onSelect).toHaveBeenCalledWith('tool1');
    expect(row(c, 'tool1').tagName).toBe('BUTTON');
  });

  it('virtualises above 500 observations', () => {
    const rows = Array.from({ length: 600 }, (_, i) => obs({ obs_id: `o${i}`, start: T0 + i, end: T0 + i + 1 }));
    const c = render(<Waterfall observations={rows} onSelect={() => {}} />);
    expect(c.querySelector('.run-virtual')).not.toBeNull();
    expect(c.querySelectorAll('.run-wf-row').length).toBeLessThan(100);
  });
});

describe('RunInspector', () => {

  it('reads attrs.error.message, falling back to a generic line', () => {
    let c = render(<RunInspector observation={obs({ obs_id: 'a', status: 'error', attrs: { error: { message: 'boom' } } })} scores={[]} />);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('boom');
    c = render(<RunInspector observation={obs({ obs_id: 'b', status: 'error', attrs: { error: 42 } })} scores={[]} />);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('This step failed.');
  });

  it('shows this observation’s scores, plus trace-level scores for a root', () => {
    const scores = [
      score({ score_id: 's1', obs_id: 'child', name: 'helpful', value: 0.8, source: 'llm-judge', comment: 'solid' }),
      score({ score_id: 's2', obs_id: null, name: 'thumbs', value: 1, source: 'human' }),
      score({ score_id: 's3', obs_id: 'other', name: 'nope' }),
    ];
    let c = render(<RunInspector observation={obs({ obs_id: 'child', parent_obs_id: 'root' })} scores={scores} />);
    let names = [...c.querySelectorAll('.run-score-name')].map((n) => n.textContent);
    expect(names).toEqual(['helpful']);
    expect(c.querySelector('.run-score')?.textContent).toContain('0.8');
    expect(c.querySelector('.run-score')?.textContent).toContain('llm-judge');
    expect(c.querySelector('.run-score')?.textContent).toContain('solid');
    c = render(<RunInspector observation={obs({ obs_id: 'root' })} scores={scores} />);
    names = [...c.querySelectorAll('.run-score-name')].map((n) => n.textContent);
    expect(names).toEqual(['thumbs']);
  });

  it('shows tokens, cost markers, model and the truncated note', () => {
    const gen = obs({
      obs_id: 'g',
      kind: 'generation',
      model: 'gpt-4o',
      usage_input_tokens: 10,
      usage_output_tokens: 20,
      usage_cached_tokens: 5,
      usage_reasoning_tokens: 7,
      cost_usd: 0.0021,
      cost_partial: true,
      usage_estimated: true,
      truncated: true,
    });
    const c = render(<RunInspector observation={gen} scores={[]} />);
    const usage = c.querySelector('[data-section="usage"]')!.textContent!;
    expect(usage).toContain('Input tokens10');
    expect(usage).toContain('Reasoning tokens7');
    expect(usage).toContain('$0.0021 (partial, estimated)');
    expect(usage).toContain('gpt-4o');
    expect(c.querySelector('.run-truncated-note')).not.toBeNull();
    expect(c.querySelector('.run-inspector .run-playground-link')?.getAttribute('href')).toBe('#/playground?trace=tr1&fromObs=g');
  });
});
