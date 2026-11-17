import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { IngestEvent } from './envelope';
import { observeExporter } from './reporter';

it('a second close() waits for the deregister the first one started', async () => {
  const sent: IngestEvent[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    sent.push(...(JSON.parse(init.body) as { batch: IngestEvent[] }).batch);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const reporter = observeExporter({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-observe-')),
    fetchFn,
    heartbeatIntervalMs: 0,
    flushIntervalMs: 0,
    registerExitHooks: false,
  });

  void reporter.close();
  await reporter.close();

  expect(sent.map((event) => event.type)).toContain('agent.deregister');
});

it('on SIGTERM it flushes but leaves the exit to a host that has its own handler', async () => {
  const sent: IngestEvent[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    sent.push(...(JSON.parse(init.body) as { batch: IngestEvent[] }).batch);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const host = vi.fn();
  process.on('SIGTERM', host);
  try {
    const reporter = observeExporter({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-observe-')),
      fetchFn,
      heartbeatIntervalMs: 0,
      flushIntervalMs: 0,
    });
    process.emit('SIGTERM');
    await reporter.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.map((event) => event.type)).toContain('agent.deregister');
    expect(host).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  } finally {
    process.off('SIGTERM', host);
    exit.mockRestore();
  }
});
