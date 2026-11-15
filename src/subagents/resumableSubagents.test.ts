/** The `task` tool continues a sub-agent by taskId (resume), branches it (fork), or starts a new one. */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import type { Message } from '../providers';

type TaskCallArgs = { agent?: string; prompt: string; taskId?: string; mode?: string; background?: boolean };
const task = ({ agent = 'researcher', ...rest }: TaskCallArgs): MockTurn => ({
  toolCalls: [{ name: 'task', args: { agent, description: 'a task', ...rest } }],
});

/** The `task` results the lead saw, in order: the text, or the error message. */
function taskResults(messages: readonly Message[]): string[] {
  return messages
    .filter((m) => m.role === 'tool' && m.toolName === 'task')
    .map((m) => {
      const parsed = JSON.parse(m.content as string) as string | { message?: string; taskId?: string };
      return typeof parsed === 'string' ? parsed : (parsed.message ?? JSON.stringify(parsed));
    });
}

/** What the child model was asked, per call, without its system prompt. */
const childTurns = (model: ReturnType<typeof mockModel>) =>
  model.calls.map((call) => call.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${String(m.content)}`));

function researcher(turns: MockTurn[]) {
  const model = mockModel(turns);
  return { model, agent: createAgent({ provider: model, instructions: 'You research.', description: 'Researches' }) };
}

describe('resumable sub-agent tasks', () => {

  it('fork starts a new task from a copy; the original is left untouched', async () => {
    const child = researcher(['A1', 'B1', 'A2']);
    const lead = createAgent({
      provider: mockModel([
        task({ prompt: 'A' }),
        task({ prompt: 'B', taskId: 'task_1', mode: 'fork' }),
        task({ prompt: 'C', taskId: 'task_1' }),
        'done',
      ]),
      subagents: { researcher: child.agent },
    });

    const result = await lead.send('go');

    const turns = childTurns(child.model);
    expect(turns[1]).toEqual(['user: A', 'assistant: A1', 'user: B']);
    expect(turns[2]).toEqual(['user: A', 'assistant: A1', 'user: C']);
    expect(taskResults(result.messages)[1]).toContain("taskId 'task_2'");
  });

  it('an unknown taskId, or one of another sub-agent, is a coded tool error', async () => {
    const child = researcher(['R1']);
    const writer = createAgent({ provider: mockModel(['unused']), description: 'Writes' });
    const lead = createAgent({
      provider: mockModel([
        task({ prompt: 'x', taskId: 'task_9' }),
        task({ prompt: 'A' }),
        task({ agent: 'writer', prompt: 'y', taskId: 'task_1' }),
        task({ prompt: 'z', mode: 'fork' }),
        'done',
      ]),
      subagents: { researcher: child.agent, writer },
    });

    const [unknown, , foreign, noId] = taskResults((await lead.send('go')).messages);

    expect(unknown).toContain("Unknown taskId 'task_9'");
    expect(unknown).toContain('LOUSHO_SUBAGENT_TASK_NOT_FOUND');
    expect(foreign).toContain("belongs to sub-agent 'researcher'");
    // A lead that reused another sub-agent's taskId for a new task is told to omit it.
    expect(foreign).toContain("To start a new task for 'writer', omit taskId");
    expect(foreign).toContain('LOUSHO_SUBAGENT_TASK_NOT_FOUND');
    expect(noId).toContain("mode 'fork' needs the taskId");
  });

  it('a background task is busy until it ends, then can be resumed by its id', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const wait = defineTool({ name: 'wait', description: 'Waits', input: z.object({}), execute: async () => (await gate, 'waited') });
    const childModel = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'first', 'second']);
    const child = createAgent({ provider: childModel, tools: [wait], description: 'Researches' });
    const lead = createAgent({
      provider: mockModel([
        task({ prompt: 'A', background: true }),
        task({ prompt: 'too early', taskId: 'task_1' }),
        () => (release(), { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] }),
        task({ prompt: 'B', taskId: 'task_1' }),
        'done',
      ]),
      subagents: { researcher: child },
    });

    const result = await lead.send('go');

    const [, busy, resumed] = taskResults(result.messages);
    expect(busy).toContain('LOUSHO_SUBAGENT_TASK_BUSY');
    expect(busy).toContain('agent_await');
    expect(resumed).toContain("second\n\n[sub-agent 'researcher'");
    expect(childTurns(childModel)[2]).toEqual(['user: A', 'assistant: ', 'tool: "waited"', 'assistant: first', 'user: B']);
  });
});

describe('taskId allocation', () => {

  it('allocates an id with a constant number of store reads however many tasks the session ran', async () => {
    const store = memoryStore();
    const sessions = store.sessions!;
    let taskReads = 0;
    const counted = {
      ...store,
      sessions: {
        load: (id: string) => {
          if (id.startsWith('subagent-task-')) taskReads++;
          return sessions.load(id);
        },
        save: sessions.save.bind(sessions),
        delete: sessions.delete.bind(sessions),
      },
    };
    const turns = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? task({ prompt: 'p' }) : 'done'));
    const child = researcher(Array.from({ length: 10 }, () => 'ok'));
    const lead = createAgent({ provider: mockModel(turns), store: counted, subagents: { researcher: child.agent } });
    const session = lead.session({ id: 'long-lived' });

    const reads: number[] = [];
    let last: readonly Message[] = [];
    for (let turn = 0; turn < 10; turn++) {
      const before = taskReads;
      last = (await session.send(`turn ${turn}`)).messages;
      reads.push(taskReads - before);
    }

    expect(taskResults(last).at(-1)).toContain("taskId 'task_10'");
    expect(reads.at(-1)).toBe(reads[1]);
  });
});
