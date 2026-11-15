import { describe, it, expect } from 'vitest';
import { upgradeSpec, type AgentSpec, type AgentSpecV2 } from 'lousho';
import { mergeLegacySave, toLegacySpec } from '../legacySpec';

const base: AgentSpec = { name: 'bot', prompt: 'Be helpful.', provider: { type: 'mock', model: 'm1' } };

const fixtures: [string, AgentSpec][] = [
  ['minimal', base],
  [
    'tools + requiresApproval true',
    { ...base, tools: ['http', 'web-fetch'], policy: { requiresApproval: true } },
  ],
  [
    'requiresApproval list + guardrails with options',
    {
      ...base,
      policy: {
        requiresApproval: ['http_request', 'web_fetch'],
        guardrails: [{ name: 'pii' }, { name: 'max-length', on: 'input', maxChars: 500 }],
      },
    },
  ],
  [
    'hooks + flow',
    {
      ...base,
      policy: {
        hooks: [{ nodeKey: 'h1', id: 'h1', name: 'lint', phase: 'pre', point: 'toolCall', code: 'return ctx' }],
        flow: { start: 's1', steps: [{ id: 's1', kind: 'agent' }] },
      },
    },
  ],
];

describe('toLegacySpec(upgradeSpec(v1)) round trip', () => {
  it.each(fixtures)('%s deep-equals the fixture', (_name, fixture) => {
    expect(toLegacySpec(upgradeSpec(fixture))).toEqual(fixture);
  });
});

describe('mergeLegacySave', () => {

  it('keeps stored non-builtin tool refs, then the upgraded tools, when tools change', () => {
    const stored = {
      version: 2,
      name: 'bot',
      model: 'mock/m1',
      instructions: 'x',
      tools: [{ builtin: 'web_fetch' }, { registry: 'toolkit-extra' }],
    } as unknown as AgentSpecV2;
    const before = toLegacySpec(stored);
    expect(before.tools).toEqual(['web-fetch', 'toolkit-extra']);
    const merged = mergeLegacySave(stored, { ...before, tools: ['http'] });
    expect((merged as { tools?: unknown }).tools).toEqual([
      { registry: 'toolkit-extra' },
      { builtin: 'http_request' },
    ]);
  });

  it('drops a v2 key the v1 save cleared', () => {
    const stored = {
      version: 2,
      name: 'bot',
      model: 'mock/m1',
      instructions: 'x',
      permissions: [{ id: 'p1', tool: '*', action: 'ask' }],
    } as unknown as AgentSpecV2;
    const before = toLegacySpec(stored);
    expect(before.policy?.requiresApproval).toBe(true);
    const legacy = { ...before, policy: { ...before.policy, requiresApproval: undefined } };
    const merged = mergeLegacySave(stored, legacy);
    expect(merged.permissions).toBeUndefined();
  });
});
