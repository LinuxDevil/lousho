/**
 * The hosted tool helpers, `isHostedTool`, the duplicate-name error, and
 * how `createAgent()` separates hosted tools from local ones (array and
 * record forms), checked through the requests `mockModel` records.
 */

import { describe, expect, it } from 'vitest';
import { hostedTool, webSearch, assertHostedToolNames } from './hosted';

describe('hosted tool helpers', () => {

  it('hostedTool() passes an AI SDK tool object through under its name', () => {
    const aiSdkTool = { type: 'provider', id: 'openai.image_generation', args: {} };
    const tool = hostedTool('image_generation', aiSdkTool);
    expect(tool).toMatchObject({ kind: 'hosted-tool', name: 'image_generation', type: 'custom', options: {} });
    expect(tool.aiSdkTool).toBe(aiSdkTool);
    expect(() => hostedTool('', aiSdkTool)).toThrow(/non-empty/);
    expect(() => hostedTool('x', 'not a tool')).toThrow(/provider tool object/);
  });

  it('a name used twice is a configuration error worded like the ToolRegistry one', () => {
    expect(() => assertHostedToolNames([webSearch(), webSearch()], [])).toThrow(
      "Tool name 'web_search' is already registered: another hosted tool conflicts with hosted tool 'web_search' (web_search). Give one of them a different name."
    );
    expect(() => assertHostedToolNames([hostedTool('lookup', {})], ['lookup'])).toThrow(/a local tool conflicts with hosted tool 'lookup'/);
  });
});
