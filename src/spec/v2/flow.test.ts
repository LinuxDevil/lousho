import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { flowProblems } from './flow';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function problems(flow: unknown, agentNames: readonly string[] = ['billing']) {
  return flowProblems(flow, { agentNames });
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

/** The ticket's valid example: sequence of agent('self'), approval, end. */
const VALID_FLOW = {
  code: 'f',
  name: 'F',
  flow: {
    type: 'sequence',
    id: 's',
    steps: [
      { type: 'agent', id: 'a', agent: 'self' },
      { type: 'approval', id: 'ok', message: 'Ship?' },
      { type: 'end', id: 'e' },
    ],
  },
};

describe('flowProblems', () => {

  it('reuses validateFlow for a missing code and name, at the flow key', () => {
    expect(problems({ flow: { type: 'end', id: 'e' } })).toEqual([
      { path: ['flow'], message: 'Flow code is required', unsupported: false },
      { path: ['flow'], message: 'Flow name is required', unsupported: false },
    ]);
  });

  it('reports a oneOf without options and an option without a step', () => {
    expect(problems({ ...VALID_FLOW, flow: { type: 'oneOf', id: 'o' } })).toEqual([
      { path: ['flow', 'flow', 'options'], message: 'needs at least one option', unsupported: false },
    ]);
    const step = { type: 'oneOf', id: 'o', options: [{ condition: 'x' }] };
    expect(problems({ ...VALID_FLOW, flow: step })).toEqual([
      { path: ['flow', 'flow', 'options', 0, 'step'], message: 'required', unsupported: false },
    ]);
  });

  it.each([
    ['evaluator', 'expression'],
  ])("reports a %s without '%s'", (type, field) => {
    expect(problems({ ...VALID_FLOW, flow: { type, id: 'x' } })).toEqual([
      { path: ['flow', 'flow', field], message: 'required', unsupported: false },
    ]);
  });

  it('recurses through oneOf options and forEach steps', () => {
    const flow = {
      code: 'f',
      name: 'F',
      flow: {
        type: 'oneOf',
        id: 'o',
        options: [{ step: { type: 'forEach', id: 'f', items: '$list', step: { type: 'end' } } }],
      },
    };
    expect(problems(flow)).toEqual([
      {
        path: ['flow', 'flow', 'options', 0, 'step', 'step', 'id'],
        message: 'every flow step needs an id',
        unsupported: false,
      },
    ]);
  });
});

describe('spec flow key', () => {
  it('validates the spec-level example', () => {
    expect(parseAgentSpecV2({ ...base, flow: VALID_FLOW }).flow).toEqual(VALID_FLOW);
  });

  it('throws LOUSHO_SPEC_UNSUPPORTED for an editor-only step, naming its absolute path', () => {
    const spec = {
      ...base,
      flow: {
        code: 'f',
        name: 'F',
        flow: {
          type: 'sequence',
          id: 's',
          steps: [{ type: 'condition', id: 'c', condition: 'x', trueFlow: { type: 'end', id: 't' }, falseFlow: { type: 'end', id: 'f' } }],
        },
      },
    };
    const error = thrown(spec);
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.message).toContain('flow.flow.steps.0');
  });

  it('accepts an agent step naming a subagent key and rejects an unknown name', () => {
    const flow = { code: 'f', name: 'F', flow: { type: 'agent', id: 'a', agent: 'billing' } };
    const withSubagent = { ...base, subagents: { billing: { ref: 'agents/billing.yaml' } }, flow };
    expect(parseAgentSpecV2(withSubagent).flow).toEqual(flow);
    const error = thrown({ ...base, flow });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('flow.flow.agent');
  });
});
