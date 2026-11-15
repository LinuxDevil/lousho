import { describe, it, expect } from 'vitest';
import { issueMessage, issuePath } from '../../utils/zodCompat';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'lead', model: 'anthropic/claude-sonnet-5-5', instructions: 'Lead.' };

/** A minimal valid inline sub-agent spec (an AgentSpecV2 without version/triggers/flow/evals, with a description). */
const research = { name: 'research', description: 'Finds sources', model: 'openai/gpt-4o-mini', instructions: 'Research.' };

function parse(subagents: unknown) {
  return agentSpecV2Schema.safeParse({ ...base, subagents });
}

describe('agentSpecV2Schema subagents', () => {

  it('requires exactly one of ref, inline, remote', () => {
    for (const subagents of [
      { x: { ref: 'a.yaml', inline: research } },
      { x: {} },
      { x: { ref: 'a.yaml', remote: { url: 'https://a.example.com', description: 'A' } } },
    ]) {
      const result = parse(subagents);
      expect(result.success).toBe(false);
      if (result.success) continue;
      const issue = result.error.issues.find((entry) => issuePath(entry) === 'subagents.x');
      expect(issue).toBeDefined();
      expect(issueMessage(issue ?? { message: '' })).toContain('exactly one of ref, inline, remote');
    }
  });
});
