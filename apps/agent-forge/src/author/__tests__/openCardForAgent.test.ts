import { describe, it, expect } from 'vitest';
import type {
  AuthorAssistantMessage,
  AuthorToolPart,
  ProposalOutput,
} from '../../../shared/authorWire';
import type { ProposalActionState } from '../proposalActionState';
import { openCardForAgent } from '../useAuthorCanvasSync';

function output(id: string, kind: 'create' | 'update', agentId?: string): ProposalOutput {
  return {
    ok: true,
    proposalId: id,
    kind,
    ...(agentId !== undefined ? { agentId } : {}),
    spec: { version: 2, name: 'bot', model: 'm', instructions: 'i' },
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: kind === 'update' ? 'hash' : null,
    enabled: kind === 'update',
  };
}

/** An ok propose tool part inside one assistant message. */
function proposeMessage(id: string, kind: 'create' | 'update', agentId?: string): AuthorAssistantMessage {
  const part: AuthorToolPart = {
    type: 'tool',
    toolCallId: id,
    name: kind === 'create' ? 'proposeAgent' : 'proposeAgentUpdate',
    input: {},
    state: 'done',
    output: output(id, kind, agentId),
  };
  return { id: `m_${id}`, role: 'assistant', parts: [part], at: '2026-01-01T00:00:00.000Z' };
}

/** The walk's answer when `id` is the one actionable card. */
function actionable(id: string | null): ProposalActionState {
  return {
    actionableProposalId: id,
    hasPendingClientRequest: false,
    visibleCreateProposalIds: new Set(),
    savedProposalIds: new Set(),
    discardedProposalIds: new Set(),
  };
}

describe('openCardForAgent', () => {

  it('finds the card in the live assistant message too', () => {
    const active = proposeMessage('p9', 'update', 'a1');
    const card = openCardForAgent(actionable('p9'), [], active, 'a1');
    expect(card?.proposalId).toBe('p9');
  });
});
