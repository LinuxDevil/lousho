import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket } from 'ws';
import { createUpgradeRouter } from '../upgradeRouter';

/**
 * The single `upgrade` listener every WS endpoint registers on
 * (server/ws/upgradeRouter.ts): exact-path and RegExp routing in
 * registration order, duplicate registrations rejected, unmatched paths
 * destroyed, and the shared Host/Origin gate run before any handler.
 */
describe('createUpgradeRouter', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    // Open upgrade sockets keep `server.close` waiting - drop them first.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Opens a WS upgrade attempt and reports how it ended: 'open', 'error' (socket destroyed), or the HTTP status written back. */
  function attempt(path: string): Promise<'open' | 'error' | number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve('error'));
    });
  }

  /** A handler that records the matched pathname, then drops the socket. */
  function recording(seen: string[]) {
    return (_req: IncomingMessage, socket: Socket, _head: Buffer, url: URL) => {
      seen.push(url.pathname);
      socket.destroy();
    };
  }

  it('routes a RegExp pattern and passes the parsed URL through', async () => {
    const router = createUpgradeRouter(server);
    const seen: string[] = [];
    let seenUrl: URL | undefined;
    router.register(/^\/agents\/([^/]+)\/stream$/, (_req, socket, _head, url) => {
      seen.push(url.pathname);
      seenUrl = url;
      socket.destroy();
    });
    expect(await attempt('/agents/a1/stream?token=x')).toBe('error');
    expect(seen).toEqual(['/agents/a1/stream']);
    expect(seenUrl?.searchParams.get('token')).toBe('x');
    expect(await attempt('/agents/stream')).toBe('error');
    expect(seen).toEqual(['/agents/a1/stream']);
  });

  it('throws on a duplicate route (same string or same RegExp)', () => {
    const router = createUpgradeRouter(server);
    router.register('/events', () => {});
    router.register(/^\/agents\/x\/stream$/, () => {});
    expect(() => router.register('/events', () => {})).toThrow(/duplicate/i);
    expect(() => router.register(/^\/agents\/x\/stream$/, () => {})).toThrow(/duplicate/i);
    // A string and a RegExp spelling the same path are different routes.
    expect(() => router.register(/^\/events$/, () => {})).not.toThrow();
  });

  it('rejects a foreign Origin with 403 before any handler runs', async () => {
    const router = createUpgradeRouter(server, {});
    const seen: string[] = [];
    router.register(/^\//, recording(seen));
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, {
        headers: { Origin: 'https://example.com' },
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(403);
    expect(seen).toEqual([]);
  });
});
