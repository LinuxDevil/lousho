import { describe, it, expect } from 'vitest';
import { AGENT_OWNED, PAGE_OWNED, parseAgentRef } from './agentRefs';

describe('parseAgentRef', () => {
  it('the three ref forms parse; a bare name is an error', () => {
    expect(parseAgentRef('workspace:script-writer')).toEqual({ ok: true, ref: { kind: 'workspace', name: 'script-writer' } });
    expect(parseAgentRef('local:hook-writer')).toEqual({ ok: true, ref: { kind: 'local', name: 'hook-writer' } });
    expect(parseAgentRef('global:copy-editor@^1.2.0')).toEqual({ ok: true, ref: { kind: 'global', name: 'copy-editor', range: '^1.2.0' } });
    const bare = parseAgentRef('script-writer');
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain('workspace:');
    expect(parseAgentRef('').ok).toBe(false);
    expect(parseAgentRef('other:script-writer').ok).toBe(false);
    expect(parseAgentRef('workspace:Script_Writer').ok).toBe(false);
    expect(parseAgentRef('workspace:a/b').ok).toBe(false);
    expect(parseAgentRef('workspace:a@1.0.0').ok).toBe(false);
    expect(parseAgentRef('local:a@1.0.0').ok).toBe(false);
  });

  it('the global ref requires a semver range', () => {
    for (const ref of ['global:copy-editor', 'global:copy-editor@', 'global:copy-editor@latest', 'global:copy-editor@1.2', 'global:copy-editor@>=1.0.0']) {
      const result = parseAgentRef(ref);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('range');
    }
    expect(parseAgentRef('global:copy-editor@1.2.3').ok).toBe(true);
    expect(parseAgentRef('global:copy-editor@~1.2.3').ok).toBe(true);
    expect(parseAgentRef('global:fact-checker@^1')).toEqual({ ok: true, ref: { kind: 'global', name: 'fact-checker', range: '^1' } });
    expect(parseAgentRef('global:fact-checker@~1.2').ok).toBe(true);
  });
});

describe('AGENT_OWNED and PAGE_OWNED', () => {

  it('list the documented fields', () => {
    expect([...AGENT_OWNED]).toEqual(['instructions', 'skills', 'tools', 'memory', 'default model']);
    expect([...PAGE_OWNED]).toEqual(['as', 'role', 'model', 'limits', 'tools.only', 'harness']);
  });
});
