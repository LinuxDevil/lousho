import type { Express } from 'express';
import { isValidAgentId } from '../../shared/agentId';
import { WORKSPACE_ID_RE } from '../../shared/workspace';
import {
  DEFAULT_NOTIFICATIONS,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationSettings,
} from '../../shared/profileWire';
import type { AgentRunStatusPayload, RunStatus } from '../../shared/wireTypes';
import { asyncRoute, sendError } from '../http/routeUtils';
import type { SecretsStore } from '../secretsStore';
import type { WorkspaceContext } from '../workspace/context';
import { readJson, writeJson } from './profileFiles';

const CHANNELS: readonly NotificationChannel[] = ['off', 'slack', 'email', 'both'];
const SEND_TIMEOUT_MS = 10_000;
const EXCERPT = 400;

export type SendResult = { slack?: string; email?: string };

function excerpt(text: string | undefined): string {
  if (!text) return '';
  const flat = text.trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat;
}

export function parseNotificationSettings(body: unknown): NotificationSettings | string {
  const b = (body ?? {}) as Partial<NotificationSettings>;
  if (!CHANNELS.includes(b.channel as NotificationChannel)) return `channel must be one of ${CHANNELS.join(', ')}.`;
  const events = {} as Record<NotificationEvent, boolean>;
  for (const event of NOTIFICATION_EVENTS) {
    const value = b.events?.[event];
    if (typeof value !== 'boolean') return `events.${event} must be true or false.`;
    events[event] = value;
  }
  if (b.slackChannel !== undefined && (typeof b.slackChannel !== 'string' || b.slackChannel.length > 80)) return 'slackChannel is too long.';
  if (b.emailTo !== undefined && (typeof b.emailTo !== 'string' || b.emailTo.length > 500)) return 'emailTo is too long.';
  const overrides: Record<string, NotificationChannel> = {};
  for (const [key, value] of Object.entries(b.overrides ?? {})) {
    const [workspaceId, agentId, extra] = key.split('/');
    const validKey = extra === undefined && WORKSPACE_ID_RE.test(workspaceId ?? '') && isValidAgentId(agentId ?? '');
    if (!validKey || !CHANNELS.includes(value)) return `Override '${key}' is not valid.`;
    overrides[key] = value;
  }
  return {
    channel: b.channel as NotificationChannel,
    events,
    ...(b.slackChannel?.trim() && { slackChannel: b.slackChannel.trim() }),
    ...(b.emailTo?.trim() && { emailTo: b.emailTo.trim() }),
    overrides,
  };
}

export function eventFor(prev: RunStatus | undefined, next: RunStatus): NotificationEvent | undefined {
  if (prev === next) return undefined;
  if (next === 'running' && prev !== 'paused') return 'started';
  if (next === 'done') return 'completed';
  if (next === 'error') return 'failed';
  return undefined;
}

export class NotificationService {
  private readonly last = new Map<string, RunStatus>();

  constructor(
    private readonly file: string,
    private readonly secrets: SecretsStore,
  ) {}

  get(): NotificationSettings {
    return { ...DEFAULT_NOTIFICATIONS, ...readJson<Partial<NotificationSettings>>(this.file, {}) };
  }

  set(settings: NotificationSettings): NotificationSettings {
    writeJson(this.file, settings);
    return settings;
  }

  attach(ctx: WorkspaceContext): () => void {
    const onStatus = (payload: AgentRunStatusPayload) => void this.onStatus(ctx, payload);
    ctx.runs.on('status', onStatus);
    return () => ctx.runs.off('status', onStatus);
  }

  private async onStatus(ctx: WorkspaceContext, payload: AgentRunStatusPayload): Promise<void> {
    const key = `${ctx.ref.id}/${payload.agentId}`;
    const event = eventFor(this.last.get(key), payload.status);
    this.last.set(key, payload.status);
    if (event === undefined) return;
    const settings = this.get();
    const channel = settings.overrides[key] ?? settings.channel;
    if (channel === 'off' || !settings.events[event]) return;
    const name = (await ctx.repo.readSpec(payload.agentId).catch(() => undefined))?.name ?? payload.agentId;
    const who = `*${name}* (${ctx.ref.name})`;
    const text =
      event === 'started'
        ? `▶️ ${who} started${payload.source === 'trigger' && payload.triggerId ? ` by ${payload.triggerId}` : ''}.`
        : event === 'completed'
          ? `✅ ${who} finished.${payload.resultText ? `\n${excerpt(payload.resultText)}` : ''}`
          : `❌ ${who} failed.${payload.error ? `\n${excerpt(payload.error)}` : ''}`;
    const result = await this.send(text, channel, settings);
    for (const [via, outcome] of Object.entries(result)) {
      if (outcome !== 'sent') console.warn(`[lousho studio] ${via} notification for ${key} failed: ${outcome}`);
    }
  }

  async send(text: string, channel: NotificationChannel, settings: NotificationSettings = this.get()): Promise<SendResult> {
    const result: SendResult = {};
    if (channel === 'slack' || channel === 'both') result.slack = await this.sendSlack(text, settings).catch((e: unknown) => String(e instanceof Error ? e.message : e));
    if (channel === 'email' || channel === 'both') result.email = await this.sendEmail(text, settings).catch((e: unknown) => String(e instanceof Error ? e.message : e));
    return result;
  }

  private async sendSlack(text: string, settings: NotificationSettings): Promise<string> {
    const bot = this.secrets.getSecret('SLACK_BOT_TOKEN');
    if (bot !== undefined && settings.slackChannel !== undefined) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bot}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: settings.slackChannel, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      return body.ok ? 'sent' : `Slack said ${body.error ?? res.status}`;
    }
    const webhook = this.secrets.getSecret('SLACK_WEBHOOK_URL');
    if (webhook === undefined) return 'Connect Slack (a bot token and a channel, or a webhook URL) first';
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return res.ok ? 'sent' : `Slack answered ${res.status}`;
  }

  private async sendEmail(text: string, settings: NotificationSettings): Promise<string> {
    const apiKey = this.secrets.getSecret('RESEND_API_KEY');
    if (apiKey === undefined) return 'Connect Email (Resend) first';
    if (settings.emailTo === undefined) return 'Add an address to send to';
    const plain = text.replace(/\*/g, '');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.secrets.getSecret('EMAIL_FROM') ?? 'Lousho <onboarding@resend.dev>',
        to: settings.emailTo.split(',').map((s) => s.trim()).filter(Boolean),
        subject: plain.split('\n')[0].slice(0, 150),
        text: plain,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return 'sent';
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return `Resend said ${body.message ?? res.status}`;
  }
}

export function registerNotificationRoutes(app: Express, service: NotificationService): void {
  app.get('/settings/notifications', (_req, res) => {
    res.json(service.get());
  });

  app.put('/settings/notifications', (req, res) => {
    const parsed = parseNotificationSettings(req.body);
    if (typeof parsed === 'string') {
      sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
      return;
    }
    res.json(service.set(parsed));
  });

  app.post(
    '/settings/notifications/test',
    asyncRoute(async (_req, res) => {
      const settings = service.get();
      const channel = settings.channel === 'off' ? 'both' : settings.channel;
      res.json(await service.send('🔔 Test notification from Lousho Studio.', channel, settings));
    }),
  );
}
