/**
 * The `prompt` registry opt-in in createAgent(): 'name@version' (or
 * LOUSHO_PROMPT) fetches the run's instructions from the observe daemon at
 * build, embedded `instructions` are the fallback for an unreachable daemon,
 * and a landing fetch links every run to its version through a `prompt_use`
 * row (obs_id = the run's root span).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from './createAgent';
import { startObserveDaemon, type ObserveDaemon } from './observe/daemon';
import { PROMPT_RETRY_WINDOW_MS, publishPrompt } from './observe/promptClient';
import { observeExporterFromEnv } from './observe/reporter';
import { mockModel, type MockModel } from './testing';
import { textOf } from './providers/content';

const daemons: ObserveDaemon[] = [];

beforeEach(() => {
  vi.stubEnv('LOUSHO_OBSERVE_PROJECT', 'prompt-test');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (daemons.length > 0) await daemons.pop()?.close();
});

async function start(): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0 });
  daemons.push(daemon);
  return daemon;
}

const systemPrompt = (model: MockModel, call = 0): string => textOf(model.calls[call].messages[0].content);

/** Flush + release the memoized env reporter for `name` (it is the only path prompt_use events take). */
async function closeReporter(name: string, url: string): Promise<void> {
  const env = { LOUSHO_OBSERVE: url, LOUSHO_OBSERVE_PROJECT: 'prompt-test' } as NodeJS.ProcessEnv;
  await observeExporterFromEnv({ agentName: name, env })?.close();
}

describe('createAgent({ prompt }) - fallback + conflicts', () => {

  it('retries a failed resolution: the next run succeeds once the daemon is reachable', async () => {
    const first = await start();
    const port = first.port;
    await first.close();
    daemons.splice(daemons.indexOf(first), 1);
    const url = `http://127.0.0.1:${port}`;
    vi.stubEnv('LOUSHO_OBSERVE', url);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    const model = mockModel(['ok']);
    const agent = createAgent({ name: 'prompt-agent-retry', provider: model, prompt: 'mira@latest' });
    await expect(agent.send('hi')).rejects.toMatchObject({ code: 'LOUSHO_PROMPT_UNRESOLVED' });

    const daemon = await startObserveDaemon({ dbPath: ':memory:', port });
    daemons.push(daemon);
    await publishPrompt(url, { name: 'mira', text: 'Registry text after recovery.' });
    // Inside the retry window the failure stands, even though the daemon is back.
    await expect(agent.send('hi')).rejects.toMatchObject({ code: 'LOUSHO_PROMPT_UNRESOLVED' });
    vi.setSystemTime(Date.now() + PROMPT_RETRY_WINDOW_MS + 1);
    await agent.send('hi');
    expect(systemPrompt(model)).toContain('Registry text after recovery.');
    await closeReporter('prompt-agent-retry', url);
  });

  it('falls back to instructions when they exist (no collector: warning text unchanged)', async () => {
    vi.stubEnv('LOUSHO_OBSERVE', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['ok']);
    await createAgent({ name: 'prompt-agent-fb', provider: model, prompt: 'mira@1', instructions: 'You are embedded.' }).send('hi');
    expect(systemPrompt(model)).toContain('You are embedded.');
    expect(String(warn.mock.calls[0][0])).toContain('the embedded instructions are used instead.');
  });
});
