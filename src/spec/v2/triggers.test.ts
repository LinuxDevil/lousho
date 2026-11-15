import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';
import { CHANNEL_SECRET_KEYS } from './triggers';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(triggers: unknown) {
  return { ...base, triggers };
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

/** The five trigger types as the builder writes them. */
const EXAMPLES = {
  chat: { id: 'chat', type: 'chat' },
  cron: {
    id: 'daily',
    type: 'cron',
    cron: '0 9 * * MON-FRI',
    timezone: 'Europe/Paris',
    prompt: 'Write the morning report.',
    sharedSession: true,
  },
  webhook: {
    id: 'hook',
    type: 'webhook',
    path: '/deploy',
    secret: { env: 'HOOK_SECRET' },
    promptTemplate: 'Deploy {{body.ref}}.',
    filter: "body.action == 'push'",
  },
  channel: {
    id: 'tg',
    type: 'channel',
    channel: 'telegram',
    secrets: { botToken: { env: 'TG_BOT_TOKEN' }, secretToken: { secret: 'tg-webhook-secret' } },
    filter: 'update.message',
  },
  agent: {
    id: 'chain',
    type: 'agent',
    after: 'researcher',
    on: 'done',
    promptTemplate: 'Summarize {{run.resultText}}.',
  },
};

describe('spec v2 triggers', () => {

  it('rejects a cron expression that does not parse at triggers.<i>.cron', () => {
    for (const cron of ['not cron', '61 * * * *', '0 0 31 2 *', '* * *']) {
      const error = thrown(spec([{ ...EXAMPLES.cron, cron, timezone: undefined }]));
      expect(error.errors).toHaveProperty('triggers.0.cron');
    }
    const error = thrown(spec([{ ...EXAMPLES.cron, cron: 'not cron' }]));
    expect(error.message).toContain('Invalid cron expression');
  });

  it('rejects a channel trigger missing a required secret at triggers.<i>.secrets.<key>', () => {
    for (const [channel, keys] of Object.entries(CHANNEL_SECRET_KEYS)) {
      if (keys.length === 0) continue;
      const trigger = {
        id: 'c',
        type: 'channel',
        channel,
        secrets: Object.fromEntries(keys.slice(1).map((key) => [key, { env: 'X' }])),
      };
      const error = thrown(spec([trigger]));
      expect(error.errors).toHaveProperty(`triggers.0.secrets.${keys[0]}`);
      expect(error.message).toContain(`'${channel}' needs secrets.${keys[0]}`);
    }
  });
});
