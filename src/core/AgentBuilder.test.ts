import { describe, it, expect } from 'vitest';
import { AgentBuilder } from './AgentBuilder';

describe('AgentBuilder', () => {

  it('rejects a tool entry without a `tool` property (LOUSHO_VALIDATION_FAILED)', () => {
    expect(() => {
      new AgentBuilder()
        .setName('Test Agent')
        .setTools({ calendar: {} as never })
        .build();
    }).toThrow(expect.objectContaining({ code: 'LOUSHO_VALIDATION_FAILED' }));
    expect(() => {
      new AgentBuilder()
        .setName('Test Agent')
        .setTools({ calendar: {} as never })
        .build();
    }).toThrow("Tool configuration for 'calendar' is missing 'tool' property");
  });

  it('should load from existing config', () => {
    const existingConfig = {
      id: 'existing-id',
      name: 'Existing Agent',
      locale: 'en',
      prompt: 'Existing prompt',
      tools: {},
      flows: [],
      events: [],
      settings: {},
      metadata: {}
    };

    const agent = AgentBuilder.from(existingConfig).build();

    expect(agent.id).toBe('existing-id');
    expect(agent.name).toBe('Existing Agent');
    expect(agent.prompt).toBe('Existing prompt');
  });
});
