import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadMcpTools } from './McpToolLoader';

/** A fake MCP client exposing one tool whose call returns `callResult`. */
function fakeClient(callResult: unknown, inputSchema: unknown = { type: 'object' }) {
  return {
    listTools: async () => ({ tools: [{ name: 'do_it', description: 'Do it', inputSchema }] }),
    callTool: vi.fn(async () => callResult),
  } as unknown as Client;
}

async function run(callResult: unknown) {
  const tools = await loadMcpTools(fakeClient(callResult), 'srv');
  return tools['srv__do_it'].tool.execute!({}, {} as never);
}

describe('MCP result handling', () => {

  it('preserves image, audio and resource parts in a JSON-serializable form', async () => {
    const result = await run({
      content: [
        { type: 'text', text: 'here' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'audio', data: 'YXVk', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hi' } },
        { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAE=' } },
        { type: 'resource_link', uri: 'file:///c', name: 'c', description: 'link' },
        { type: 'hologram', depth: 3 },
      ],
    });
    // The JSON (what the model gets) carries a placeholder for base64 data; the parts keep it.
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      text: 'here',
      content: [
        { type: 'text', text: 'here' },
        { type: 'image', data: '[image: image/png, 4 base64 characters, not sent to the model]', mimeType: 'image/png' },
        { type: 'audio', data: '[audio: audio/wav, 4 base64 characters, not sent to the model]', mimeType: 'audio/wav' },
        { type: 'resource', uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hi' },
        { type: 'resource', uri: 'file:///b.bin', blob: '[resource: 4 base64 characters, not sent to the model]' },
        { type: 'resource_link', uri: 'file:///c', name: 'c', description: 'link' },
        { type: 'unknown', raw: { type: 'hologram', depth: 3 } },
      ],
    });
  });

  it('a tool description over 2,000 characters is cut', async () => {
    const description = 'd'.repeat(680_000);
    const client = { listTools: async () => ({ tools: [{ name: 'huge', description, inputSchema: { type: 'object' } }] }) } as unknown as Client;
    const tools = await loadMcpTools(client, 's');
    expect((tools.s__huge.tool as { description: string }).description.length).toBeLessThan(2_100);
    expect((tools.s__huge.tool as { description: string }).description).toContain('[description truncated from 680000 characters]');
  });

  it('returns a legacy result without a content array unchanged', async () => {
    expect(await run({ toolResult: 42 })).toEqual({ toolResult: 42 });
  });
});
