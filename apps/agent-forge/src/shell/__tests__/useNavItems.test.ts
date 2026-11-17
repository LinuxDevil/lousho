import { describe, expect, it } from 'vitest';
import { hasWorkspaceService } from '../useNavItems';

const reply = (status: number, type: string) => async () => new Response('{}', { status, headers: { 'content-type': type } });

describe('hasWorkspaceService', () => {
  it('is true only when the server answers with JSON', async () => {
    expect(await hasWorkspaceService(reply(200, 'application/json') as typeof fetch)).toBe(true);
    expect(await hasWorkspaceService(reply(404, 'application/json') as typeof fetch)).toBe(false);
    expect(await hasWorkspaceService(reply(200, 'text/html') as typeof fetch)).toBe(false);
    expect(await hasWorkspaceService((async () => { throw new Error('offline'); }) as typeof fetch)).toBe(false);
  });
});
