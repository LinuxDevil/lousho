/**
 * `slugAgentId`/`uniqueAgentId`/`copyAgentId` - the id helpers
 * `POST /agents` uses to turn display names into filesystem-safe,
 * collision-free agent ids (storage/agentIds.ts).
 */
import { describe, it, expect,  } from 'vitest';
import { isValidAgentId } from '../../../shared/agentId';
import { slugAgentId } from '../agentIds';

describe('slugAgentId', () => {

  it('always produces an id that passes isValidAgentId', () => {
    const inputs = ['My Agent!!', '', 'a..b', '.hidden', '_under', '---', 'x'.repeat(200), 'café agent', '  lead'];
    for (const input of inputs) {
      expect(isValidAgentId(slugAgentId(input)), input).toBe(true);
    }
  });
});
