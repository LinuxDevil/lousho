/**
 * S23: `lousho/spec` must bundle for a browser consumer (Studio's Vite
 * build), so nothing in its import graph may import a `node:` path or
 * resolve to a module a browser bundler cannot reach. This guards the
 * barrel's graph the way `src/deploy/kv.test.ts` guards `lousho/kv`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { stop } from 'esbuild';
import * as spec from './index';

// esbuild keeps a service process alive after build(); end it so it does not outlive this file.
afterAll(() => stop());

describe('lousho/spec (S23)', () => {

  it('exports the merged spec-v2 surface by name', () => {
    expect(Object.keys(spec).sort()).toEqual([
      'SPEC_FIELD_DESCRIPTIONS',
      'TOOL_REF_KINDS',
      'agentSpecSchema',
      'agentSpecV2JsonSchema',
      'agentSpecV2Schema',
      'flowProblems',
      'flowSpecSchema',
      'isNodeIdExporter',
      'isSecretRef',
      'jsonSchemaToStandardSchema',
      'listGuardrails',
      'listModels',
      'listTriggerTypes',
      'memorySpecSchema',
      'nodeIdExporter',
      'nodeIdIndexOf',
      'parseAgentSpecV2',
      'secretRefSchema',
      'skillRefSchema',
      'specNodeIds',
      'specToAgentDir',
      'specToCode',
      'subAgentNodeIndexes',
      'toolRefSchema',
      'triggerSpecSchema',
      'upgradeSpec',
    ]);
    // And the named exports are the real thing, not stubs.
    expect(spec.agentSpecV2Schema.safeParse({ version: 2, name: 'a', model: 'mock/mock-1', instructions: 'i' }).success).toBe(true);
    expect(spec.agentSpecSchema.safeParse({ name: 'a' }).success).toBe(false);
    expect(spec.isSecretRef({ env: 'X' })).toBe(true);
    expect(spec.listTriggerTypes().length).toBeGreaterThan(0);
  });
});
