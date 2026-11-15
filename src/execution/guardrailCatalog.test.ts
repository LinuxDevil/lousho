import { describe, it, expect } from 'vitest';
import { SPEC_GUARDRAIL_NAMES, type SpecGuardrailName } from '../spec/guardrailOptions';
import { listGuardrails } from './guardrailCatalog';

const DESCRIPTIONS: Record<SpecGuardrailName, string> = {
  'max-length': 'Blocks text longer than a set number of characters.',
  'secret-scan': 'Finds API keys and tokens in the text; blocks or masks them.',
  regex: 'Blocks or rewrites text that matches a regular expression you give.',
  'deny-topics': 'Blocks text that mentions any of the topics you list.',
  'llm-judge': 'Asks a model whether the text is acceptable, using your instruction.',
  pii: 'Finds personal data (emails, phone numbers, card numbers, ...); blocks or masks it.',
  secrets: 'Finds secrets with the built-in patterns plus yours; masks them by default.',
  'prompt-injection': "Flags attempts to override the agent's instructions (heuristics, then a model if set).",
  moderation: 'Asks a model to flag hateful, violent, sexual or other harmful content.',
};

describe('listGuardrails', () => {
  it('lists the starter set in SPEC_GUARDRAIL_NAMES order, with descriptions', () => {
    const entries = listGuardrails();
    expect(entries.map((entry) => entry.name)).toEqual([...SPEC_GUARDRAIL_NAMES]);
    for (const entry of entries) {
      expect(entry.description).toBe(DESCRIPTIONS[entry.name]);
      expect(entry.on).toEqual(['input', 'output', 'tools']);
      expect(entry.canRunInParallel).toBe(true);
    }
  });
});
