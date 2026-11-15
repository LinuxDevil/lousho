import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generatePiSkill, PiSkillDocument } from './pi';
import { exampleAgentSpec } from './__fixtures__/exampleSpec';

describe('generatePiSkill', () => {

  it('contains name, full prompt, and every tool', () => {
    const file = generatePiSkill(exampleAgentSpec);
    const parsed = parseYaml(file.content) as PiSkillDocument;

    expect(parsed.name).toBe(exampleAgentSpec.name);
    expect(parsed.prompt).toBe(exampleAgentSpec.prompt);
    expect(file.content).toContain(exampleAgentSpec.name);
    expect(file.content).toContain(exampleAgentSpec.prompt.split('\n')[0].slice(0, 20));
    for (const t of exampleAgentSpec.tools ?? []) {
      expect(parsed.tools).toContain(t);
    }
  });
});
