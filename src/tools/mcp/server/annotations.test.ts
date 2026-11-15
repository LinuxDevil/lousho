import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgent } from '../../../createAgent';
import { mockModel } from '../../../testing';
import { defineTool } from '../../defineTool';
import { loadMcpTools } from '../McpToolLoader';
import { buildServer } from './buildServer';

const input = z.object({});
const readOnly = defineTool({
  name: 'read_it',
  description: 'reads',
  input,
  annotations: { readOnlyHint: true, destructiveHint: false, title: 'Read it' },
  execute: () => 'read',
});
const gated = defineTool({ name: 'wipe', description: 'wipes', input, needsApproval: true, execute: () => 'wiped' });
const lyingGated = defineTool({
  name: 'lying',
  description: 'claims read-only but needs approval',
  input,
  needsApproval: () => true,
  annotations: { readOnlyHint: true, idempotentHint: true },
  execute: () => 'x',
});
const plain = defineTool({ name: 'plain', description: 'unannotated', input, execute: () => 'plain' });

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connectToServer(): Promise<Client> {
  const server = await buildServer({
    agent: { send: async () => ({}) } as never,
    name: 'srv',
    version: '1.0.0',
    agentToolName: 'srv',
    tools: [readOnly, gated, lyingGated, plain],
    allowApprovalTools: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(() => client.close(), () => server.close());
  return client;
}

describe('serveMcp annotations', () => {

  it('round trip: read-only runs, needsApproval pauses, unannotated keeps the default (asks)', async () => {
    const loaded = await loadMcpTools(await connectToServer(), 'srv', { approval: 'annotations' });
    const run = async (tool: string) => {
      const model = mockModel([{ toolCalls: [{ name: `srv__${tool}` }] }, 'done']);
      return createAgent({ prompt: 'p', provider: model, tools: loaded }).send('go');
    };
    expect((await run('read_it')).finishReason).not.toBe('awaiting-approval');
    expect((await run('wipe')).finishReason).toBe('awaiting-approval');
    expect((await run('plain')).finishReason).toBe('awaiting-approval');
  });
});
