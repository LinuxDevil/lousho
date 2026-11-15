import { describe, expect, it } from 'vitest';
import { mockModel, type MockModel, type MockRequest, type MockStaticTurn, type MockTurn } from '../testing';
import { improveAgent, type Harness, type ImproveOptions, type ProbeRun } from './index';

const BASE: Harness = { instructions: 'You answer questions.', skills: {} };
const FIX = 'You answer questions. If a document is forbidden, say so and stop.';

const write = (content: string): MockStaticTurn => ({ toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content } }] });
const edit = (content: string): MockTurn[] => [write(content), '<notes>Traced to a failed run.</notes>'];
const noEdit: MockTurn[] = ['<notes>KEEP_BASE. Nothing in the runs argues for a change.</notes>'];
const run = (passed: boolean | null, tokens = 10): ProbeRun => ({ passed, transcript: `user: hi\nassistant: ${passed}`, tokens, ended: 'stop' });

const systemOf = (request: MockRequest) => String(request.messages.find((message) => message.role === 'system')?.content ?? '');

const stageOf = (request: MockRequest): string => {
  const system = systemOf(request);
  const checkpoint = /composing checkpoint (\d+) of \d+/.exec(system)?.[1];
  if (checkpoint) return `compose-${checkpoint}`;
  if (system.includes('You are the composer.')) return 'compose';
  const scope = system.includes('earliest point of divergence') ? 'invariant' : 'domain';
  const round = /This is round (\d+) of \d+/.exec(system)?.[1];
  return round ? `${scope}-${round}` : scope;
};

const editors = (script: Record<string, MockTurn[]>): MockModel => {
  const queues = Object.fromEntries(Object.entries(script).map(([stage, turns]) => [stage, [...turns]]));
  const count = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
  const next: MockTurn = (request) => {
    const turn = queues[stageOf(request)]?.shift();
    if (turn === undefined) throw new Error(`No turn left for the ${stageOf(request)} editor.`);
    return typeof turn === 'function' ? turn(request) : turn;
  };
  return mockModel(Array.from({ length: count }, () => next));
};

const gated: ImproveOptions['probe'] = async (harness, caseId) => {
  if (caseId !== 'held-out') return run(harness.instructions.includes('forbidden'));
  return run(!harness.instructions.includes('Always'));
};

const options = (over: Partial<ImproveOptions> = {}): ImproveOptions => ({
  harness: BASE,
  cases: ['stuck'],
  holdout: ['held-out'],
  probe: gated,
  editor: { provider: mockModel([]) },
  repeats: 2,
  mode: 'seq',
  proposers: 2,
  ...over,
});

describe('improveAgent in seq mode', () => {

  it('keeps the base and records each verdict when no checkpoint passes', async () => {
    const provider = editors({
      'invariant-1': noEdit,
      'domain-1': noEdit,
      'compose-1': edit(`${FIX} Always a.`),
      'invariant-2': noEdit,
      'domain-2': noEdit,
      'compose-2': edit(`${FIX} Always a.`),
    });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.outcome).toBe('keep-base');
    expect(result.harness).toBeUndefined();
    expect(result.reason).toMatch(/^The compose-1 checkpoint failed the gate: A held-out case got worse/);
    expect(result.gate).toEqual([
      { label: 'compose-1', passed: false, reason: expect.stringMatching(/held-out/) },
      { label: 'compose-2', passed: false, reason: 'Same as the compose-1 checkpoint, so it was not judged again.' },
    ]);
  });

  it('shows later rounds a rejected edit as rejected, not as its notes', async () => {
    let saw = '';
    const capture: MockTurn = (request) => {
      saw = JSON.stringify(request.messages);
      return '<notes>KEEP_BASE.</notes>';
    };
    const leaky = [write(`${FIX} Always cite the secret source.`), '<notes>PLANTED NOTE one</notes>', write(`${FIX} Always cite the secret source.`), '<notes>PLANTED NOTE two</notes>'];
    const provider = editors({
      'invariant-1': leaky,
      'domain-1': edit(FIX),
      'compose-1': edit(FIX),
      'invariant-2': [{ toolCalls: [{ name: 'read_file', args: { path: 'context/candidates/invariant-1/notes.md' } }] }, capture],
      'domain-2': noEdit,
      'compose-2': noEdit,
    });
    const probe: ImproveOptions['probe'] = async (harness, caseId, repeat) => ({ ...(await gated(harness, caseId, repeat)), failure: 'cite the secret source' });
    const result = await improveAgent(options({ probe, editor: { provider } }));
    expect(result.stages[0]).toMatchObject({ label: 'invariant-1', status: 'fell-back' });
    expect(saw).toContain('No change was kept: the edit was rejected.');
    expect(saw).not.toContain('PLANTED NOTE');
  });

  it('tells each round where it is, and lets the composer bring back an earlier round', async () => {
    const provider = editors({ 'invariant-1': noEdit, 'domain-1': noEdit, 'compose-1': noEdit, 'invariant-2': noEdit, 'domain-2': noEdit, 'compose-2': noEdit });
    await improveAgent(options({ editor: { provider } }));
    const systems = provider.calls.map(systemOf);
    expect(systems.filter((system) => system.includes('This is round 2 of 2'))).toHaveLength(2);
    const last = systems.find((system) => system.includes('composing checkpoint 2 of 2')) ?? '';
    expect(last).toContain('bring back an earlier');
    expect(last).toContain('This is the last round');
  });
});
