import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageView } from '../MessageView';

describe('MessageView', () => {
  it('renders the text of OpenTelemetry GenAI parts messages', () => {
    const value = JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'Design a URL shortener' }] }]);
    expect(renderToStaticMarkup(<MessageView value={value} />)).toContain('Design a URL shortener');
  });
});
