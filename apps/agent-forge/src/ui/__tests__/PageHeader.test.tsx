import { describe, expect, it } from 'vitest';
import { render } from './render';
import { PageHeader } from '../PageHeader';

describe('PageHeader', () => {

  it('renders breadcrumbs (last is the current page), description, status and actions', () => {
    const el = render(
      <PageHeader
        className="extra"
        title={<span>Dataset one</span>}
        description="Examples to evaluate against"
        breadcrumbs={[{ label: 'Evaluations', href: '#/evals/scores' }, { label: 'Datasets', href: '#/evals/datasets' }, { label: 'one' }]}
        status={<span id="pill">ok</span>}
        actions={<button type="button">New example</button>}
      />,
    );
    expect(el.querySelector('header')?.className).toBe('page-header extra');
    const crumbs = el.querySelector('nav[aria-label="Breadcrumb"]')!;
    expect([...crumbs.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Evaluations', 'Datasets', 'one']);
    expect([...crumbs.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#/evals/scores', '#/evals/datasets']);
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe('one');
    expect(crumbs.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
    // A non-string title gets no tooltip.
    expect(el.querySelector('h1')?.hasAttribute('title')).toBe(false);
    expect(el.querySelector('.page-header-description')?.textContent).toBe('Examples to evaluate against');
    expect(el.querySelector('.page-header-status #pill')).not.toBeNull();
    expect(el.querySelector('.page-header-actions button')?.textContent).toBe('New example');
  });
});
