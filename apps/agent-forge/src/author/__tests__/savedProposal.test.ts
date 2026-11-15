import { describe, it, expect } from 'vitest';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  ProposalOutput,
} from '../../../shared/authorWire';
import { findProposalOutput,  } from '../savedProposal';

let seq = 0;
function tool(over: Partial<AuthorToolPart>): AuthorToolPart {
  return { type: 'tool', toolCallId: `tc_${++seq}`, name: 'getCurrentSpec', input: {}, state: 'done', ...over };
}

function assistant(parts: AuthorAssistantMessage['parts']): AuthorAssistantMessage {
  return { id: `m_a_${++seq}`, role: 'assistant', parts, at: '2026-01-01T00:00:00.000Z' };
}

function proposal(over: Partial<ProposalOutput> = {}): ProposalOutput {
  return {
    ok: true,
    proposalId: 'tc_prop',
    kind: 'create',
    spec: { version: 2, name: 'Triage bot', model: 'anthropic/claude-sonnet-5-5', instructions: 'Triage issues.' },
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: null,
    enabled: false,
    ...over,
  };
}

describe('findProposalOutput', () => {

  it('ignores failed, busy and differently-named parts', () => {
    const messages: AuthorMessage[] = [
      assistant([
        tool({ toolCallId: 'tc_prop', name: 'proposeAgent', output: { ok: false } }),
        tool({ toolCallId: 'tc_prop2', name: 'proposeAgent', state: 'pending' }),
        tool({ toolCallId: 'tc_prop3', name: 'saveAgent', output: proposal() }),
      ]),
    ];
    expect(findProposalOutput(messages, null, 'tc_prop')).toBeNull();
    expect(findProposalOutput(messages, null, 'tc_prop2')).toBeNull();
    expect(findProposalOutput(messages, null, 'tc_prop3')).toBeNull();
    expect(findProposalOutput(messages, null, 'tc_missing')).toBeNull();
  });
});
