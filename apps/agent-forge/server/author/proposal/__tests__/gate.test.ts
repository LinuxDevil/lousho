import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolFailure,
  AuthorToolPart,
  AuthorUserMessage,
  ProposalOutput,
} from '../../../../shared/authorWire';
import type { AuthorTurn } from '../../turnRunner';
import { identityKey, proposalTurnState, type ProposalIdentity } from '../turnState';
import {
  identityOfProposal,
  openProposalCards,
  resolveStoredProposal,
  saveBlockingError,
} from '../gate';

/**
 * The AA10a save-gate table (one `it` per row): T is the stored transcript
 * (ending at the previous turn), S is this turn's ProposalTurnState. The
 * fixture builders mirror the ticket's `user`/`assistant`/`okPart` set
 * plus `propose`/`proposeUpdate`/`saveEvent` conveniences.
 */

const AT = '2026-01-01T00:00:00.000Z';
const CREATE: ProposalIdentity = { kind: 'create' };

let seq = 0;

function update(agentId: string): ProposalIdentity {
  return { kind: 'update', agentId };
}

function user(text: string): AuthorUserMessage {
  seq += 1;
  return { id: `m-${seq}`, role: 'user', text, at: AT };
}

function assistant(...parts: AuthorAssistantMessage['parts']): AuthorAssistantMessage {
  seq += 1;
  return { id: `m-${seq}`, role: 'assistant', parts, at: AT };
}

function okPart(
  name: string,
  toolCallId: string,
  input: unknown = {},
  output: unknown = { ok: true }
): AuthorToolPart {
  return { type: 'tool', toolCallId, name, input, output, state: 'done' };
}

function spec(name: string): AgentSpecV2 {
  return {
    version: 2,
    name,
    description: 'does a thing',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'do a thing',
  };
}

function card(proposalId: string, over: Partial<ProposalOutput> = {}): ProposalOutput {
  return {
    ok: true,
    proposalId,
    kind: 'create',
    spec: spec(`Agent ${proposalId}`),
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: null,
    enabled: false,
    ...over,
  };
}

/** A successful `proposeAgent` tool part: the card for a new agent. */
function propose(toolCallId: string): AuthorToolPart {
  return okPart('proposeAgent', toolCallId, { draft: { name: `Agent ${toolCallId}` } }, card(toolCallId));
}

/** A successful `proposeAgentUpdate` tool part: the card editing `agentId`. */
function proposeUpdate(toolCallId: string, agentId: string): AuthorToolPart {
  return okPart(
    'proposeAgentUpdate',
    toolCallId,
    { agentId, patch: {} },
    card(toolCallId, { kind: 'update', agentId, spec: spec(`Agent ${agentId}`) })
  );
}

function turn(transcript: AuthorMessage[]): AuthorTurn {
  return {
    sessionId: 'sess-1',
    requestId: 'req-1',
    focus: { mode: 'create' },
    storedTranscript: transcript,
    userMessage: user('hi'),
    signal: new AbortController().signal,
    stepsRemaining: () => 12,
    state: new Map(),
  };
}

function codeOf(result: AuthorToolFailure | null): string {
  expect(result).not.toBeNull();
  return result!.code;
}

describe('saveBlockingError', () => {

  it('2. card proposed this turn -> UNANSWERED', () => {
    const t = turn([]);
    proposalTurnState(t).proposed.set(identityKey(CREATE), card('p2'));
    expect(codeOf(saveBlockingError(t, CREATE))).toBe('UNANSWERED');
  });

  it('4. card saved by a saveAgent tool call -> ALREADY_SAVED', () => {
    const t = [assistant(propose('p1'), okPart('saveAgent', 's1'))];
    expect(codeOf(saveBlockingError(turn(t), CREATE))).toBe('ALREADY_SAVED');
  });

  it('7. card discarded in the stored transcript -> NO_PROPOSAL', () => {
    const t = [assistant(propose('p1'), okPart('discardPendingChanges', 'd1', {}))];
    expect(codeOf(saveBlockingError(turn(t), CREATE))).toBe('NO_PROPOSAL');
  });

  it('10. an update card for agent A never authorises a save for agent B -> NO_PROPOSAL', () => {
    const t = [assistant(proposeUpdate('u1', 'agent-a'))];
    expect(codeOf(saveBlockingError(turn(t), update('agent-b')))).toBe('NO_PROPOSAL');
  });
});

describe('resolveStoredProposal', () => {

  it('17. a card for agent A resolved under agent B is WRONG_AGENT', () => {
    const t = [assistant(proposeUpdate('u1', 'agent-a'))];
    expect(codeOf(resolveStoredProposal(t, update('agent-b'), 'u1') as AuthorToolFailure)).toBe('WRONG_AGENT');
  });

  it('18. a toolCallId on more than one tool part is AMBIGUOUS_PROPOSAL', () => {
    const t = [assistant(propose('p1'), okPart('getCurrentSpec', 'p1', { agentId: 'agent-a' }))];
    expect(codeOf(resolveStoredProposal(t, CREATE, 'p1') as AuthorToolFailure)).toBe('AMBIGUOUS_PROPOSAL');
  });
});

describe('openProposalCards', () => {

  it('23. a saved create card drops out; a later update card stays', () => {
    const t = [
      assistant(propose('p1'), okPart('saveAgent', 's1')),
      assistant(proposeUpdate('u1', 'new-agent')),
    ];
    expect(openProposalCards(t)).toEqual([
      { proposalId: 'u1', kind: 'update', agentId: 'new-agent', name: 'Agent new-agent' },
    ]);
  });
});

describe('identityOfProposal', () => {
  const t = [assistant(propose('p1'), proposeUpdate('u1', 'agent-a'))];

  it('24. maps a proposalId to its identity, or null', () => {
    expect(identityOfProposal(t, 'p1')).toEqual({ kind: 'create' });
    expect(identityOfProposal(t, 'u1')).toEqual({ kind: 'update', agentId: 'agent-a' });
    expect(identityOfProposal(t, 'x')).toBeNull();
  });
});
