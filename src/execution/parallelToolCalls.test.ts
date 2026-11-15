/**
 * The tool calls of one model turn run concurrently (up to
 * `toolConcurrency`), while the transcript, approvals, failures, aborts and
 * checkpoints stay deterministic.
 */

import { describe, it, expect } from 'vitest';
import { AgentExecutor, ExecuteOptions } from './AgentExecutor';
import { createAgent } from '../createAgent';
import { DefinedTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { AgentConfig } from '../types';

function agentFor(tools: DefinedTool[]): AgentConfig {
  const config: AgentConfig['tools'] = {};
  for (const t of tools) config[t.name] = { tool: t.name };
  return { id: 'agent-1', name: 'Agent', prompt: 'p', tools: config };
}

describe('parallel tool calls', () => {

  describe('toolConcurrency validation', () => {
    it.each([ -1,])('rejects %s with a clear error', async (value) => {
      const options = {
        agent: agentFor([]),
        input: 'go',
        provider: mockModel(['hi']),
        toolConcurrency: value as ExecuteOptions['toolConcurrency'],
      };
      await expect(AgentExecutor.execute(options)).rejects.toThrow(
        /'toolConcurrency' must be a positive integer or 'unbounded'/
      );
      expect(() =>
        createAgent({ prompt: 'p', provider: mockModel([]), toolConcurrency: options.toolConcurrency })
      ).toThrow(/createAgent: 'toolConcurrency'/);
    });
  });
});
