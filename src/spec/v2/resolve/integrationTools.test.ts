import { describe, expect, it } from 'vitest';
import { resolveIntegrationRef } from './integrationTools';

const host = { resolveSecret: (name: string) => `value-of-${name}` };
const secret = (name: string) => ({ secret: name });

describe('resolveIntegrationRef', () => {
  it('builds the Slack Web API tools from a bot token alone, and adds slack_alert with a webhook', async () => {
    const bot = await resolveIntegrationRef({ integration: 'slack', credentials: { botToken: secret('SLACK_BOT_TOKEN') } }, host, 'tools.0');
    expect(Object.keys(bot)).toContain('slack_post_message');
    expect(bot['slack_alert']).toBeUndefined();

    const both = await resolveIntegrationRef(
      { integration: 'slack', credentials: { botToken: secret('SLACK_BOT_TOKEN'), webhookUrl: secret('SLACK_WEBHOOK_URL') } },
      host,
      'tools.0',
    );
    expect(Object.keys(both)).toEqual(expect.arrayContaining(['slack_alert', 'slack_read_thread']));
  });

  it('builds the Google, Jenkins, Figma and Confluence tool sets', async () => {
    const google = await resolveIntegrationRef(
      { integration: 'google', credentials: { clientId: 'id', clientSecret: secret('S'), refreshToken: secret('R') } },
      host,
      'tools.0',
    );
    expect(Object.keys(google)).toEqual(expect.arrayContaining(['gmail_send_email', 'drive_search_files', 'sheets_read_range', 'calendar_list_events']));
    const jenkins = await resolveIntegrationRef({ integration: 'jenkins', credentials: { baseUrl: 'https://ci', username: 'u', apiToken: secret('T') } }, host, 'tools.0');
    expect(Object.keys(jenkins)).toContain('jenkins_trigger_job');
    const figma = await resolveIntegrationRef({ integration: 'figma', credentials: { token: secret('F') } }, host, 'tools.0');
    expect(Object.keys(figma)).toContain('figma_get_node');
    const confluence = await resolveIntegrationRef(
      { integration: 'confluence', credentials: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: secret('T') } },
      host,
      'tools.0',
    );
    expect(Object.keys(confluence)).toContain('confluence_search');
  });
});
