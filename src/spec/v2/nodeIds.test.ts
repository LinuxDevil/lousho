import { describe, expect, it } from 'vitest';
import { specNodeIds } from './nodeIds';
import type { AgentSpecV2 } from './types';

function spec(overrides: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/m', instructions: 'You are a test agent.', ...overrides };
}

describe('specNodeIds tools', () => {
  it('prefers the ref id, then builtin/registry/hosted/integration/file-basename/openapi/hub', () => {
    const ids = specNodeIds(
      spec({
        tools: [
          { builtin: 'web_fetch', id: 'fetch' },
          { builtin: 'current_date' },
          { registry: 'github-issues' },
          { hosted: 'web_search' },
          { integration: 'github', credentials: { token: { env: 'GH' }, owner: 'o', repo: 'r' } },
          { file: 'tools/lookup.ts' },
          { openapi: { url: 'https://x.test/openapi.json' } },
          { hub: true },
        ],
      })
    );
    expect(ids.tools).toEqual([
      'tool:fetch',
      'tool:current_date',
      'tool:github-issues',
      'tool:web_search',
      'tool:github',
      'tool:lookup',
      'tool:openapi',
      'tool:hub',
    ]);
  });
});

describe('specNodeIds remaining sections', () => {

  it('names skills by inline name, dir basename or registry', () => {
    const ids = specNodeIds(
      spec({
        skills: [
          { inline: { name: 'changelog', description: 'Write changelogs.', content: '# C' } },
          { dir: 'skills/research' },
          { registry: 'pdf' },
        ],
      })
    );
    expect(ids.skills).toEqual(['skill:changelog', 'skill:research', 'skill:pdf']);
  });
});

describe('specNodeIds flow walk', () => {
  it('collects every step id of spec.flow.flow depth-first through steps, options[].step and step', () => {
    const flow = {
      flow: {
        type: 'sequence',
        steps: [
          { type: 'llmCall', id: 'classify' },
          {
            type: 'oneOf',
            id: 'route',
            options: [
              { condition: 'x', step: { type: 'return', id: 'billing' } },
              { step: { type: 'return', id: 'other' } },
            ],
          },
          { type: 'forEach', id: 'each', step: { type: 'toolCall', id: 'work' } },
        ],
      },
    };
    const ids = specNodeIds(spec({ flow } as never));
    expect(ids.flow).toEqual({
      classify: 'flow:classify',
      route: 'flow:route',
      billing: 'flow:billing',
      other: 'flow:other',
      each: 'flow:each',
      work: 'flow:work',
    });
  });
});
