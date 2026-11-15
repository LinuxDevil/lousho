/** The built server's start-up check: no open agent on a public interface unless LOUSHO_ALLOW_PUBLIC=1. */
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { SDKError } from '../utils/sdkError';
import { checkServerExposure, createDeployedServer, type DeployedServerOptions } from './nodeServer';

/** `authenticated` of a deployed server built with `options`. */
function authenticatedWith(options: DeployedServerOptions): boolean {
  const agent = createAgent({ provider: mockModel(['ok']), instructions: 'x' });
  return createDeployedServer(agent, options).authenticated;
}

function refusal(run: () => unknown): SDKError {
  try {
    run();
  } catch (error) {
    if (error instanceof SDKError) return error;
    throw error;
  }
  throw new Error('expected checkServerExposure() to throw');
}

describe('checkServerExposure()', () => {
  it('refuses 0.0.0.0 with no auth (LOUSHO_SERVER_UNPROTECTED), naming every way out', () => {
    const error = refusal(() => checkServerExposure('0.0.0.0', authenticatedWith({ env: {} }), {}));
    expect(error.code).toBe('LOUSHO_SERVER_UNPROTECTED');
    for (const fix of ['LOUSHO_API_TOKEN', 'auth.ts', '127.0.0.1', 'LOUSHO_ALLOW_PUBLIC=1']) expect(error.message).toContain(fix);
  });

  it.each([ 'true'])('starts on 0.0.0.0 with LOUSHO_ALLOW_PUBLIC=%s, returning the open-agent warning', (value) => {
    expect(checkServerExposure('0.0.0.0', false, { LOUSHO_ALLOW_PUBLIC: value })).toBe(
      '[lousho server] warning: no LOUSHO_API_TOKEN set, so anyone who can reach 0.0.0.0 can use this agent.'
    );
  });
});
