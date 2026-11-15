import { describe, expect, it } from 'vitest';
import { mockModel, type MockModel, type MockRequest, type MockTurn } from '../testing';
import { improveAgent, type Harness, type ImproveOptions, type ProbeRun } from './index';

const BASE: Harness = { instructions: 'You answer questions.', skills: {} };
const FIX = 'You answer questions. If a document is forbidden, say so and stop.';

const write = (path: string, content: string): MockTurn => ({ toolCalls: [{ name: 'write_file', args: { path, content } }] });
const edit = (content: string): MockTurn[] => [write('harness/instructions.md', content), '<notes>Traced to a failed run.</notes>'];
const run = (passed: boolean | null, tokens = 10): ProbeRun => ({ passed, transcript: `user: hi\nassistant: ${passed}`, tokens, ended: 'stop' });

const systemOf = (request: MockRequest) => String(request.messages.find((message) => message.role === 'system')?.content ?? '');

const stageOf = (request: MockRequest): string => {
  const system = systemOf(request);
  if (system.includes('You are the composer.')) return 'compose';
  const scope = system.includes('earliest point of divergence') ? 'invariant' : 'domain';
  const index = /You are candidate (\d+) of \d+/.exec(system)?.[1];
  return index ? `${scope}-${index}` : scope;
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

const gated =
  (tokens: (harness: Harness) => number = () => 10): ImproveOptions['probe'] =>
  async (harness, caseId) => {
    if (caseId !== 'held-out') return run(harness.instructions.includes('forbidden'), tokens(harness));
    return run(!harness.instructions.includes('Always'), tokens(harness));
  };

const options = (over: Partial<ImproveOptions> = {}): ImproveOptions => ({
  harness: BASE,
  cases: ['stuck'],
  holdout: ['held-out'],
  probe: gated(),
  editor: { provider: mockModel([]) },
  repeats: 2,
  ...over,
});

describe('improveAgent with several proposers', () => {

  it('fallback considers every pool member, cheapest first', async () => {
    const tokens = (harness: Harness) => (harness.instructions.includes('Costly') ? 14 : harness.instructions.includes('Mid') ? 12 : 10);
    const heldOut: string[] = [];
    const probe: ImproveOptions['probe'] = async (harness, caseId, repeat) => {
      if (caseId === 'held-out') heldOut.push(harness.instructions);
      return gated(tokens)(harness, caseId, repeat);
    };
    const provider = editors({
      'invariant-1': edit(`${FIX} Costly.`),
      'domain-1': edit(`${FIX} Always a.`),
      'invariant-2': edit(`${FIX} Mid.`),
      'domain-2': edit(`${FIX} Always a.`),
      compose: edit(`${FIX} Always b.`),
    });
    const result = await improveAgent(options({ proposers: 2, probe, editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.harness?.instructions).toBe(`${FIX} Mid.`);
    expect(result.reason).toMatch(/The invariant-2 editor's harness passed instead/);
    expect(result.gate).toEqual([
      { label: 'compose', passed: false, reason: expect.stringMatching(/held-out/) },
      { label: 'domain-1', passed: false, reason: expect.stringMatching(/held-out/) },
      { label: 'invariant-2', passed: true, reason: expect.any(String) },
      { label: 'domain-2', passed: false, reason: "Same as the domain-1 editor's harness, so it was not judged again." },
    ]);
    expect(heldOut).not.toContain(`${FIX} Costly.`);
  });
});
