import { describe, it, expect } from 'vitest';
import { createAgent, type SimpleAgent } from '../../../createAgent';
import { handoffFilters } from '../../../handoffs';
import { mockModel } from '../../../testing';
import { handoffFromSpec, type HandoffHost } from './handoffs';

const billing = createAgent({ name: 'billing', description: 'Billing', provider: mockModel(['ok']), instructions: 'x' });

function hostWith(agent: SimpleAgent): HandoffHost {
  return { resolveHandoffAgent: async () => agent };
}

describe('handoffFromSpec', () => {

  it('maps toolName, description and the named inputFilter', async () => {
    const result = await handoffFromSpec(
      { agent: 'billing', inputFilter: 'lastUserMessage', toolName: 'to_billing', description: 'Billing questions' },
      hostWith(billing),
      1
    );
    expect(result.options.inputFilter).toBe(handoffFilters.lastUserMessage);
    expect(result.options.toolName).toBe('to_billing');
    expect(result.options.description).toBe('Billing questions');
  });
});
