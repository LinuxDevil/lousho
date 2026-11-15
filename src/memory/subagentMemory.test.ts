import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel, type MockRequest } from '../testing';
import { defineMemory, inMemoryMemory, type MemoryProvider } from './index';

const systemOf = (call: MockRequest | undefined): string => String(call?.messages.find((m) => m.role === 'system')?.content ?? '');
const task = (agent: string, prompt: string) => ({ name: 'task', args: { agent, prompt } });

async function seeded(key: string, texts: string[]): Promise<MemoryProvider> {
  const provider = inMemoryMemory();
  for (const text of texts) await provider.add(key, { text });
  return provider;
}

describe("a sub-agent's own memory", () => {

  it("keeps the lead's memory and the sub-agent's apart, also for slots of the same name", async () => {
    const leadNotes = defineMemory({ name: 'notes', scope: 'global', provider: await seeded('notes#global', ['Lead fact.']) });
    const childNotes = defineMemory({ name: 'notes', scope: 'global', provider: await seeded('notes#global', ['Child fact.']) });
    const analystModel = mockModel(['ok']);
    const analyst = createAgent({ provider: analystModel, description: 'Analyzes', memory: [childNotes] });
    const leadModel = mockModel([{ toolCalls: [task('analyst', 'go')] }, 'Done.']);
    const lead = createAgent({ provider: leadModel, subagents: { analyst }, memory: [leadNotes] });

    await lead.send('go');

    expect(systemOf(leadModel.calls[0])).toContain('- Lead fact.');
    expect(systemOf(leadModel.calls[0])).not.toContain('Child fact.');
    expect(systemOf(analystModel.calls[0])).toContain('- Child fact.');
    expect(systemOf(analystModel.calls[0])).not.toContain('Lead fact.');
  });
});
