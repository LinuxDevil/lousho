/**
 * Access control for the studio's API and WebSocket.
 *
 * The studio stores provider keys, starts runs and executes hook code, so a
 * request is only served when it:
 *   1. names a loopback host in its `Host` header (blocks DNS rebinding: a
 *      page on `evil.example` that re-resolves to 127.0.0.1 still sends
 *      `Host: evil.example`);
 *   2. carries no `Origin`, or the studio's own origin - the browser sets
 *      `Origin` on every cross-origin fetch and on every WebSocket upgrade,
 *      so another site (or another local port) can't drive the API.
 *
 * A Studio bound to a non-loopback host accepts any Host, so put it behind
 * a login (a reverse proxy with basic auth, for example) before exposing it.
 *
 * There is no CORS middleware: the client is served by this same server
 * (or proxied same-origin by Vite in dev mode), so it never needs one.
 */
import type { IncomingMessage } from 'node:http';

/** Comma-separated extra origins to accept (dev mode: the Vite dev server's). */
export const STUDIO_ALLOWED_ORIGINS_ENV = 'LOUSHO_STUDIO_ALLOWED_ORIGINS';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface StudioAccessOptions {
  /**
   * Extra hostnames accepted in `Host` besides loopback - the `--host` the
   * server was bound to. `'*'` (a wildcard bind, `0.0.0.0` / `::`) accepts
   * any host.
   */
  allowedHosts?: string[];
  /** Extra exact origins accepted besides the studio's own (`http://<Host>`). */
  allowedOrigins?: string[];
}

function hostnameOf(host: string): string {
  // `[::1]:4750` -> `[::1]`, `127.0.0.1:4750` -> `127.0.0.1`, `localhost` -> `localhost`.
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0].toLowerCase();
}

/**
 * `true` when a `Host` header names a loopback host (`localhost`,
 * `127.0.0.1`, `[::1]`/`::1`, port allowed). The unsigned-webhook rule
 * (R08a) uses it: a trigger with no secret accepts only calls that could
 * have come from this machine.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOSTNAMES.has(hostnameOf(host));
}

function isAllowedHost(host: string | undefined, allowedHosts: string[]): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return LOOPBACK_HOSTNAMES.has(name) || allowedHosts.includes('*') || allowedHosts.includes(name);
}

/** `Origin` must be absent, this server's own origin (`http://<Host>`), or one of `allowedOrigins`. */
function isAllowedOrigin(origin: string | undefined, host: string | undefined, allowedOrigins: string[]): boolean {
  if (origin === undefined) return true;
  const o = origin.toLowerCase();
  if (allowedOrigins.some((allowed) => allowed.toLowerCase() === o)) return true;
  if (!host) return false;
  const h = host.toLowerCase();
  return o === `http://${h}` || o === `https://${h}`;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export type AccessDecision = { ok: true } | { ok: false; status: 403; error: string };

/** Host + Origin check, applied to every request and WebSocket upgrade. */
export function checkHostAndOrigin(req: IncomingMessage, options: StudioAccessOptions): AccessDecision {
  const host = header(req, 'host');
  if (!isAllowedHost(host, options.allowedHosts ?? [])) {
    return { ok: false, status: 403, error: 'Forbidden host' };
  }
  if (!isAllowedOrigin(header(req, 'origin'), host, options.allowedOrigins ?? [])) {
    return { ok: false, status: 403, error: 'Forbidden origin' };
  }
  return { ok: true };
}

/**
 * The Host half of {@link checkHostAndOrigin} alone (X02a): the `/serve/**`
 * surface skips the studio-origin rule - external
 * apps call it with their own bearer token and their own Origin, which
 * the serve router checks against the agent's `allowedOrigins` instead.
 */
export function checkHostOnly(req: IncomingMessage, options: StudioAccessOptions): AccessDecision {
  const host = header(req, 'host');
  if (!isAllowedHost(host, options.allowedHosts ?? [])) {
    return { ok: false, status: 403, error: 'Forbidden host' };
  }
  return { ok: true };
}

/** Hostnames to accept besides loopback for a server bound to `host`. */
export function allowedHostsFor(host: string | undefined): string[] {
  if (host === '0.0.0.0' || host === '::') return ['*'];
  if (!host || LOOPBACK_HOSTNAMES.has(host)) return [];
  return [hostnameOf(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)];
}
