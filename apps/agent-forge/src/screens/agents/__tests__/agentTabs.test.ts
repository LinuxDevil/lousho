import { describe, expect, it } from 'vitest';
import { agentRedirect,  } from '../agentTabs';

describe('agentRedirect', () => {
  it('sends the legacy builder URL and unbuilt or unknown tabs to canvas', () => {
    expect(agentRedirect('#/agents/x')).toBe('/agents/x/canvas');
    expect(agentRedirect('#/agents/x?y=1')).toBe('/agents/x/canvas?y=1');
    // `suggestions` is the last tab to be built (R06), so this case survives A05-A11.
    expect(agentRedirect('#/agents/x/suggestions')).toBe('/agents/x/canvas');
    expect(agentRedirect('#/agents/x/bogus')).toBe('/agents/x/canvas');
  });
});
