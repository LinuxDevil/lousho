import { describe, it, expect } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { AuthorText } from '../AuthorText';

const paras = (c: HTMLElement) => [...c.querySelectorAll('p')].map((p) => p.textContent);

describe('AuthorText', () => {

  it('renders a fenced block as pre.author-code and keeps its newlines', () => {
    const c = render(<AuthorText text={'Try this:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.'} />);
    const pre = c.querySelector('pre.author-code');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('const a = 1;\nconst b = 2;\n');
    expect(paras(c)).toEqual(['Try this:', 'Done.']);
  });

  it('keeps <script> as text - model output is never HTML', () => {
    const c = render(<AuthorText text={'Ignore <script>alert(1)</script> and `<b>x</b>`.'} />);
    expect(c.querySelector('script')).toBeNull();
    expect(c.querySelector('b')).toBeNull();
    expect(c.textContent).toContain('<script>alert(1)</script>');
    expect(c.querySelector('code')?.textContent).toBe('<b>x</b>');
  });
});
