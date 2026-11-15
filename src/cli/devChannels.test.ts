/** `lousho dev` mounts an agent directory's channels and starts its schedules, and swaps both on reload. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startDevServer, type DevServerHandle } from './dev';
import { mockModel } from '../testing';

const fixtures = path.join(__dirname, '__fixtures__');
const copies: string[] = [];
let handle: DevServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const copy of copies.splice(0)) fs.rmSync(copy, { recursive: true, force: true });
});

function copyFixture(): string {
  const copy = fs.mkdtempSync(path.join(fixtures, 'tmp-dev-channels-'));
  copies.push(copy);
  fs.cpSync(path.join(fixtures, 'dev-channels'), copy, { recursive: true });
  return copy;
}

describe('lousho dev with an agent directory that has channels and schedules', () => {

  it('checks the Host of a channel without verify (DNS rebinding), not of one that verifies its requests', async () => {
    const dir = copyFixture();
    fs.writeFileSync(
      path.join(dir, 'channels', 'signed.ts'),
      `export default {
  async verify(req: { headers: Record<string, string | undefined> }) { return req.headers['x-signature'] === 'ok'; },
  async parse(req: { text: string }) { return { sessionKey: 's', input: req.text, replyTo: null }; },
  async reply({ text, respond }: { text: string; respond?: (status: number, body: unknown) => void }) { respond?.(200, { reply: text }); },
};
`
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = await startDevServer(dir, 0, '127.0.0.1', { overrides: { provider: mockModel(['a', 'b', 'c']) }, schedules: false });
    const port = (handle.server.address() as { port: number }).port;
    const post = (route: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { host, 'x-signature': 'ok' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end('hi');
      });
    expect(await post('/channels/hook', `rebound.evil.example:${port}`)).toBe(403);
    expect(await post('/channels/hook', `localhost:${port}`)).toBe(200);
    expect(await post('/channels/signed', `my-tunnel.example`)).toBe(200);
    log.mockRestore();
  });
});
