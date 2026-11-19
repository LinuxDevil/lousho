import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import { applyAuthorPatch, validateSpec } from '../draft/toSpec';
import { authorPatchSchema } from '../draft/schema';

const base = validateSpec({
  version: 2,
  name: 'Support triage',
  description: 'Triages support email.',
  model: 'anthropic/claude-haiku-5-5',
  instructions: 'Triage support emails.',
  triggers: [{ id: 't1', type: 'chat' }],
});

describe('add github tools', () => {
  it('a token-only github ref appended to tools passes draft validation', () => {
    if (!base.ok) throw new Error(JSON.stringify(base.issues));
    const ref = { integration: 'github', credentials: { token: { secret: 'GITHUB_TOKEN' } } };
    const patch = authorPatchSchema.parse({ tools: [...(base.spec.tools ?? []), ref] });
    const built = applyAuthorPatch(base.spec as AgentSpecV2, patch);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    expect(built.spec.tools).toContainEqual(ref);
  });
});
