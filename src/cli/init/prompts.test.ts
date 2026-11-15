import { describe, it, expect,  } from 'vitest';
import prompts from 'prompts';
import { askMissing } from './prompts';

const defaults = { dir: 'my-agent', provider: 'openai', template: 'minimal' };

describe('askMissing', () => {
  it('asks every question when nothing is known (injected, non-interactive answers)', async () => {
    prompts.inject(['demo', 'anthropic', 'tools']);
    expect(await askMissing({ known: {}, defaults })).toEqual({
      dir: 'demo',
      provider: 'anthropic',
      template: 'tools',
    });
  });
});
