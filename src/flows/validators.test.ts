import { describe, it, expect } from 'vitest';
import { validateFlow, validateAgentDefinition } from './validators';

describe('Flow Validators', () => {
  describe('validateFlow', () => {

    it('should detect duplicate agent names', () => {
      const result = validateFlow({
        code: 'test',
        name: 'Test',
        agents: [
          { name: 'agent1', model: 'gpt-4', system: 'Agent 1', tools: [] },
          { name: 'agent1', model: 'gpt-4', system: 'Agent 1 duplicate', tools: [] },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate agent name: agent1');
    });
  });

  describe('validateAgentDefinition', () => {

    it('should detect missing name', () => {
      const result = validateAgentDefinition({
        model: 'gpt-4',
        system: 'Test',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent name is required');
    });
  });
});
