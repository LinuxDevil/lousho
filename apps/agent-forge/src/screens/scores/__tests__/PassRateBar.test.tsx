import { describe, expect, it } from 'vitest';

import { render } from '../../../ui/__tests__/render';
import { PassRateBar } from '../EvalDetail';

describe('PassRateBar', () => {

  it('shows an empty bar and a faint em dash (not "-") with no rate', () => {
    const c = render(<PassRateBar rate={null} />);
    expect(c.querySelector('.score-rate-bar')!.getAttribute('data-empty')).toBe('true');
    expect(c.querySelector('.score-rate-value .value-missing')!.textContent).toBe('—');
  });
});
