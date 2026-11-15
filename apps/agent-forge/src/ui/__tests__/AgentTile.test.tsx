import { describe, expect, it } from 'vitest';
import { agentTone, hashAgentId } from '../AgentTile';

describe('AgentTile', () => {

  it.each([
    ['e2e-agent', 98482544, 'accent'],
  ] as const)('hashAgentId("%s") is %i and its tone is "%s"', (id, hash, tone) => {
    expect(hashAgentId(id)).toBe(hash);
    expect(agentTone(id)).toBe(tone);
  });
});
