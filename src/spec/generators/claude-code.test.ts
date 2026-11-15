import { describe, it, expect } from 'vitest';
import { generateClaudeCodeSkill } from './claude-code';
import { exampleAgentSpec } from './__fixtures__/exampleSpec';

describe('generateClaudeCodeSkill', () => {

  it('handles a spec with no tools', () => {
    const file = generateClaudeCodeSkill({ ...exampleAgentSpec, tools: undefined });
    expect(file.content).toContain('(none)');
  });

  it('lists guardrails given as { name, ...options } objects by name', () => {
    const { content } = generateClaudeCodeSkill({
      ...exampleAgentSpec,
      policy: { requiresApproval: ['http'], guardrails: ['secret-scan', { name: 'deny-topics', topics: ['x'] }] },
    });
    expect(content).toContain('- Guardrails: secret-scan, deny-topics');
  });
});
