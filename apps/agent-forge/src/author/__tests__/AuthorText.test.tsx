import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthorText } from '../AuthorText';

describe('AuthorText', () => {
  it('renders **bold** and `code` without an HTML path', () => {
    const html = renderToStaticMarkup(<AuthorText text={'Press **Save agent** then `run` <b>x</b>'} />);
    expect(html).toContain('<strong>Save agent</strong>');
    expect(html).toContain('<code>run</code>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('leaves an unpaired ** as text', () => {
    expect(renderToStaticMarkup(<AuthorText text={'2 ** 3 is 8'} />)).toContain('2 ** 3 is 8');
  });
});
