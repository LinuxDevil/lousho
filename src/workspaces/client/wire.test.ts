
import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/wire.fixtures.json';
import { ROUTE_NAMES, WORKSPACE_ROUTES } from './wire';

const responses = fixtures.responses as Record<string, unknown>;

describe('workspace wire contract', () => {

  it('every WORKSPACE_ROUTES entry has a fixture response', () => {
    for (const name of ROUTE_NAMES) {
      expect(responses, name).toHaveProperty(name);
      const route = WORKSPACE_ROUTES[name];
      const sample = route.stream === true ? (responses[name] as unknown[])[0] : responses[name];
      expect(route.response.safeParse(sample).success, name).toBe(true);
    }
    expect(Object.keys(responses).sort()).toEqual([...ROUTE_NAMES].sort());
  });
});
