import { describe, expect, it } from 'vitest';
import { CompactedLLMProviderError } from '../execution/errors';
import { mockModel, type MockModel, type MockRequest, type MockStaticTurn, type MockTurn } from '../testing';
import { improveAgent, type Harness, type ImproveOptions, type ProbeRun } from './index';
import { anonymise, selectionSeed } from './select';

const BASE: Harness = { instructions: 'You answer questions.', skills: {} };
const FIX = 'You answer questions. If a document is forbidden, say so and stop.';
const LONG = `${FIX} Explain why.`;

const write = (content: string): MockStaticTurn => ({ toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content } }] });
const edit = (content: string): MockTurn[] => [write(content), '<notes>Traced to a failed run.</notes>'];
const noEdit: MockTurn[] = ['<notes>KEEP_BASE.</notes>'];

const systemOf = (request: MockRequest) => String(request.messages.find((message) => message.role === 'system')?.content ?? '');

const stageOf = (request: MockRequest): string => {
  const system = systemOf(request);
  if (system.includes('You are choosing which of')) return 'select';
  const checkpoint = /composing checkpoint (\d+) of \d+/.exec(system)?.[1];
  if (checkpoint) return `compose-${checkpoint}`;
  if (system.includes('You are the composer.')) return 'compose';
  const scope = system.includes('earliest point of divergence') ? 'invariant' : 'domain';
  const round = /(?:This is round|You are candidate) (\d+) of \d+/.exec(system)?.[1];
  return round ? `${scope}-${round}` : scope;
};

const editors = (script: Record<string, MockTurn[]>): MockModel => {
  const queues = Object.fromEntries(Object.entries(script).map(([stage, turns]) => [stage, [...turns]]));
  const count = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
  const next: MockTurn = (request) => {
    const turn = queues[stageOf(request)]?.shift();
    if (turn === undefined) throw new Error(`No turn left for the ${stageOf(request)} session.`);
    return typeof turn === 'function' ? turn(request) : turn;
  };
  return mockModel(Array.from({ length: count }, () => next));
};

const probe: ImproveOptions['probe'] = async (harness, caseId): Promise<ProbeRun> => {
  const { instructions } = harness;
  const passed = caseId === 'held-out' ? !instructions.includes('Always') : instructions.includes('forbidden');
  const answer = caseId === 'held-out' ? 'HELD-OUT ANSWER' : instructions.includes('Always') ? 'REJECTED ANSWER' : `Answer under: ${instructions}`;
  return { passed, transcript: `user: hi\nassistant: ${answer}`, answer, tokens: instructions.includes('Explain') ? 12 : 10, ended: 'stop' };
};

const options = (over: Partial<ImproveOptions> = {}): ImproveOptions => ({
  harness: BASE,
  cases: ['stuck'],
  holdout: ['held-out'],
  probe,
  editor: { provider: mockModel([]) },
  repeats: 2,
  select: true,
  ...over,
});

const readAll: MockStaticTurn = { toolCalls: ['A', 'B', 'C'].map((id) => ({ name: 'read_file', args: { path: `context/candidates/${id}.md` } })) };
const idOf = (label: string, labels: readonly string[]) => [...anonymise(labels, selectionSeed(options()))].find(([, entry]) => entry === label)?.[0] ?? '';
const choose = (id: string, why = 'Delivery decided it.'): MockStaticTurn => `<why>${why}</why>\n\`\`\`choice\n${id}\n\`\`\``;

describe('advisory selector', () => {

  it('an invalid choice falls back to the cheapest', async () => {
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [choose('Z')] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.harness?.instructions).toBe(FIX);
    expect(result.selection).toMatchObject({ chosen: 'domain', fallback: true });
    expect(result.selection?.why).toMatch(/no valid choice/);
  });

  it('falls back on a provider outage during selection', async () => {
    const outage: MockTurn = () => {
      throw new CompactedLLMProviderError({ error: 'down', category: 'unknown', retryable: true, statusCode: 503 });
    };
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [outage] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.selection).toMatchObject({ chosen: 'domain', fallback: true });
  });

  it('stops rather than falling back when aborted during selection', async () => {
    const controller = new AbortController();
    const abort: MockTurn = () => {
      controller.abort();
      return choose('A');
    };
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [abort] });
    await expect(improveAgent(options({ signal: controller.signal, editor: { provider } }))).rejects.toThrow();
  });

  it('accepts a lower-case choice, and says so when no reason was given', async () => {
    const labels = ['compose', 'domain'];
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [`\`\`\`choice\n${idOf('compose', labels).toLowerCase()}\n\`\`\``] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.selection).toEqual({ chosen: 'compose', why: 'The selector gave no reason.', fallback: false });
  });

  it('shows the last assistant answer of a transcript, without tool calls, and leaves out unscored runs', async () => {
    let saw = '';
    const capture: MockTurn = (request) => {
      saw = JSON.stringify(request.messages);
      return choose('A');
    };
    const transcriptOnly: ImproveOptions['probe'] = async (harness, caseId, repeat) => {
      const scored = await probe(harness, caseId, repeat);
      if (caseId === 'stuck' && repeat === 1 && harness.instructions === FIX) return { ...scored, passed: null, answer: undefined, transcript: 'assistant: UNSCORED RUN' };
      return { ...scored, answer: undefined, transcript: `user: hi\nassistant: thinking\ncall load_skill {"name":"secret-skill"}\nassistant: FINAL ${harness.instructions.length}` };
    };
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [readAll, capture] });
    await improveAgent(options({ probe: transcriptOnly, repeats: 3, editor: { provider } }));
    expect(saw).toContain(`FINAL ${FIX.length}`);
    expect(saw).not.toContain('secret-skill');
    expect(saw).not.toContain('thinking');
    expect(saw).not.toContain('UNSCORED RUN');
  });
});
