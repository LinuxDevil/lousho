/**
 * The observe daemon's /api/* request guard (I3): loopback `Host` when bound
 * to loopback (DNS rebinding), no cross-site browser writes (`Origin`,
 * `Sec-Fetch-Site`), and `application/json` bodies only (no "simple" form or
 * text/plain POSTs).
 */
import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { guardApiRequest } from './requestGuard';

const JSON_POST: IncomingHttpHeaders = { host: '127.0.0.1:7777', 'content-type': 'application/json', 'content-length': '2' };

const check = (method: string, headers: IncomingHttpHeaders, boundHost = '127.0.0.1') => guardApiRequest(method, headers, boundHost);
const statusOf = (method: string, headers: IncomingHttpHeaders, boundHost?: string) => check(method, headers, boundHost)?.status;

describe('guardApiRequest: Origin on writes', () => {

  it.each(['PUT', 'DELETE', 'PATCH'])('%s with a foreign Origin is rejected', (method) => {
    expect(statusOf(method, { host: 'localhost:7777', origin: 'http://evil.com' })).toBe(403);
  });

  it('answers 403 with LOUSHO_REQUEST_INVALID and a message naming the cross-origin rule', () => {
    expect(check('POST', { ...JSON_POST, origin: 'http://evil.com' })).toEqual({
      status: 403,
      error: expect.stringMatching(/cross-origin/i),
      code: 'LOUSHO_REQUEST_INVALID',
    });
  });
});

describe('guardApiRequest: Host when bound to loopback', () => {

  it('answers 403 with a message saying the daemon only answers loopback Host names', () => {
    expect(check('GET', { host: 'evil.com' })).toEqual({
      status: 403,
      error: expect.stringMatching(/loopback Host/i),
      code: 'LOUSHO_REQUEST_INVALID',
    });
  });
});

describe('guardApiRequest: JSON content type on writes', () => {
  const withType = (type: string | undefined, extra: IncomingHttpHeaders = { 'content-length': '2' }): IncomingHttpHeaders => ({
    host: '127.0.0.1:7777',
    ...extra,
    ...(type === undefined ? {} : { 'content-type': type }),
  });

  it('rejects a body with no Content-Type (content-length or transfer-encoding)', () => {
    expect(statusOf('POST', withType(undefined))).toBe(415);
    expect(statusOf('PUT', withType(undefined, { 'transfer-encoding': 'chunked' }))).toBe(415);
  });
});
