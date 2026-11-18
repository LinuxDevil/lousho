import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';
import { defineTool, type DefinedTool } from '../defineTool';
import { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { assertOk } from './assertOk';
import { toolFailure } from './toolFailure';

/** Credentials for the Slack Web API tools. */
export interface SlackApiConfig {
  /** Slack bot token (xoxb-…). */
  botToken: string;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [key: string]: unknown;
}

interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
}

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  tz?: string;
  profile?: { email?: string; display_name?: string; real_name?: string; title?: string };
}

const SLACK_API = 'https://slack.com/api';

type Params = Record<string, unknown>;

function toMessage(message: SlackMessage) {
  return {
    ts: message.ts,
    user: message.user ?? message.bot_id,
    text: message.text,
    threadTs: message.thread_ts,
    replyCount: message.reply_count,
  };
}

function toChannel(channel: SlackChannel) {
  return {
    id: channel.id,
    name: channel.name,
    isPrivate: channel.is_private,
    isArchived: channel.is_archived,
    isMember: channel.is_member,
    numMembers: channel.num_members,
    topic: channel.topic?.value,
    purpose: channel.purpose?.value,
  };
}

/** Slack Web API tools (channels, messages, users, files, reactions). */
export class SlackApiTools extends ToolRegistry {
  private authHeader: string;

  constructor(config: SlackApiConfig) {
    super();
    this.authHeader = `Bearer ${config.botToken}`;
    this.registerAllTools();
  }

  public register(tool: DefinedTool): void;
  public register(name: string, descriptor: ToolDescriptor): void;
  public register(...args: [DefinedTool] | [string, ToolDescriptor]): void {
    routeFetchThroughSandbox(args.length === 1 ? args[0] : args[1]);
    if (args.length === 1) {
      super.register(args[0]);
      return;
    }
    super.register(args[0], args[1]);
  }

  private registerAllTools() {
    this.registerListConversations();
    this.registerResolveChannel();
    this.registerReadMessages();
    this.registerReadThread();
    this.registerLookupUser();
    this.registerPostMessage();
    this.registerUploadFile();
    this.registerAddReaction();
  }

  private async call<T extends SlackResponse>(method: string, params: Params, json = false): Promise<T> {
    const defined = Object.entries(params).filter(([, value]) => value !== undefined);
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
      },
      body: json
        ? JSON.stringify(Object.fromEntries(defined))
        : new URLSearchParams(defined.map(([key, value]) => [key, String(value)])).toString(),
    });
    await assertOk(response, `Slack ${method} failed`);
    const data = await response.json() as T;
    if (!data.ok) throw toolFailure(`Slack ${method} failed: ${data.error ?? 'unknown_error'}`);
    return data;
  }

  private registerListConversations() {
    this.register(
      defineTool({
        name: 'slack_list_conversations',
        displayName: 'List Slack Conversations',
        description: 'List Slack channels and conversations visible to the bot',
        input: z.object({
          types: z.string().optional().default('public_channel').describe('Comma-separated: public_channel, private_channel, mpim, im'),
          limit: z.number().optional().default(100).describe('Maximum number of conversations (max 1000)'),
          cursor: z.string().optional().describe('Pagination cursor from a previous call'),
          excludeArchived: z.boolean().optional().default(true).describe('Exclude archived channels'),
        }),
        execute: async ({ types = 'public_channel', limit = 100, cursor, excludeArchived = true }) => {
          const data = await this.call<SlackResponse & { channels: SlackChannel[] }>('conversations.list', {
            types,
            limit,
            cursor,
            exclude_archived: excludeArchived,
          });
          return JSON.stringify({
            channels: data.channels.map(toChannel),
            nextCursor: data.response_metadata?.next_cursor || undefined,
          }, null, 2);
        },
      })
    );
  }

  private registerResolveChannel() {
    this.register(
      defineTool({
        name: 'slack_resolve_channel',
        displayName: 'Resolve Slack Channel',
        description: 'Find a Slack channel id by its name (with or without #)',
        input: z.object({
          name: z.string().describe('Channel name, e.g. #general or general'),
          types: z.string().optional().default('public_channel,private_channel').describe('Conversation types to search'),
        }),
        execute: async ({ name, types = 'public_channel,private_channel' }) => {
          const wanted = name.replace(/^#/, '').toLowerCase();
          let cursor: string | undefined;
          do {
            const data = await this.call<SlackResponse & { channels: SlackChannel[] }>('conversations.list', {
              types,
              limit: 1000,
              cursor,
              exclude_archived: true,
            });
            const match = data.channels.find((channel) => channel.name?.toLowerCase() === wanted);
            if (match) return JSON.stringify(toChannel(match), null, 2);
            cursor = data.response_metadata?.next_cursor || undefined;
          } while (cursor);
          throw toolFailure(`Slack channel not found: ${name}`);
        },
      })
    );
  }

  private registerReadMessages() {
    this.register(
      defineTool({
        name: 'slack_read_messages',
        displayName: 'Read Slack Messages',
        description: 'Read recent messages from a Slack channel',
        input: z.object({
          channel: z.string().describe('Channel id'),
          limit: z.number().optional().default(20).describe('Maximum number of messages'),
          oldest: z.string().optional().describe('Only messages after this ts'),
          latest: z.string().optional().describe('Only messages before this ts'),
          cursor: z.string().optional().describe('Pagination cursor'),
        }),
        execute: async ({ channel, limit = 20, oldest, latest, cursor }) => {
          const data = await this.call<SlackResponse & { messages: SlackMessage[]; has_more?: boolean }>('conversations.history', {
            channel,
            limit,
            oldest,
            latest,
            cursor,
          });
          return JSON.stringify({
            messages: data.messages.map(toMessage),
            hasMore: data.has_more,
            nextCursor: data.response_metadata?.next_cursor || undefined,
          }, null, 2);
        },
      })
    );
  }

  private registerReadThread() {
    this.register(
      defineTool({
        name: 'slack_read_thread',
        displayName: 'Read Slack Thread',
        description: 'Read a Slack thread (the parent message and its replies)',
        input: z.object({
          channel: z.string().describe('Channel id'),
          ts: z.string().describe('ts of the thread parent message'),
          limit: z.number().optional().default(100).describe('Maximum number of messages'),
          cursor: z.string().optional().describe('Pagination cursor'),
        }),
        execute: async ({ channel, ts, limit = 100, cursor }) => {
          const data = await this.call<SlackResponse & { messages: SlackMessage[]; has_more?: boolean }>('conversations.replies', {
            channel,
            ts,
            limit,
            cursor,
          });
          return JSON.stringify({
            messages: data.messages.map(toMessage),
            hasMore: data.has_more,
            nextCursor: data.response_metadata?.next_cursor || undefined,
          }, null, 2);
        },
      })
    );
  }

  private registerLookupUser() {
    this.register(
      defineTool({
        name: 'slack_lookup_user',
        displayName: 'Look Up Slack User',
        description: 'Look up a Slack user by email or user id',
        input: z.object({
          email: z.string().optional().describe('User email'),
          userId: z.string().optional().describe('User id, e.g. U123'),
        }),
        execute: async ({ email, userId }) => {
          if (!email && !userId) throw toolFailure('Provide email or userId');
          const data = email
            ? await this.call<SlackResponse & { user: SlackUser }>('users.lookupByEmail', { email })
            : await this.call<SlackResponse & { user: SlackUser }>('users.info', { user: userId });
          const user = data.user;
          return JSON.stringify({
            id: user.id,
            name: user.name,
            realName: user.real_name ?? user.profile?.real_name,
            displayName: user.profile?.display_name,
            email: user.profile?.email,
            title: user.profile?.title,
            timezone: user.tz,
            isBot: user.is_bot,
            deleted: user.deleted,
          }, null, 2);
        },
      })
    );
  }

  private registerPostMessage() {
    this.register(
      defineTool({
        name: 'slack_post_message',
        displayName: 'Post Slack Message',
        description: 'Post a message to a Slack channel, optionally as a thread reply or with Block Kit blocks',
        input: z.object({
          channel: z.string().describe('Channel id'),
          text: z.string().describe('Message text (also the fallback when blocks are given)'),
          threadTs: z.string().optional().describe('Parent message ts to reply in a thread'),
          blocks: z.array(z.record(z.string(), z.unknown())).optional().describe('Block Kit blocks'),
        }),
        execute: async ({ channel, text, threadTs, blocks }) => {
          const data = await this.call<SlackResponse & { channel: string; ts: string }>('chat.postMessage', {
            channel,
            text,
            thread_ts: threadTs,
            blocks,
          }, true);
          return JSON.stringify({ channel: data.channel, ts: data.ts }, null, 2);
        },
      })
    );
  }

  private registerUploadFile() {
    this.register(
      defineTool({
        name: 'slack_upload_file',
        displayName: 'Upload Slack File',
        description: 'Upload a file to a Slack channel from text content or base64',
        input: z.object({
          channel: z.string().describe('Channel id'),
          filename: z.string().describe('File name, e.g. report.csv'),
          content: z.string().describe('File content (text, or base64 when encoding is base64)'),
          encoding: z.enum(['utf8', 'base64']).optional().default('utf8').describe('Encoding of content'),
          title: z.string().optional().describe('File title'),
          initialComment: z.string().optional().describe('Message posted with the file'),
          threadTs: z.string().optional().describe('Parent message ts to share into a thread'),
        }),
        execute: async ({ channel, filename, content, encoding = 'utf8', title, initialComment, threadTs }) => {
          const bytes = Buffer.from(content, encoding);
          const upload = await this.call<SlackResponse & { upload_url: string; file_id: string }>('files.getUploadURLExternal', {
            filename,
            length: bytes.length,
          });
          const uploadResponse = await fetch(upload.upload_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: new Uint8Array(bytes),
          });
          await assertOk(uploadResponse, 'Slack file upload failed');
          const data = await this.call<SlackResponse & { files: Array<{ id: string; title?: string; permalink?: string }> }>('files.completeUploadExternal', {
            files: JSON.stringify([{ id: upload.file_id, title: title ?? filename }]),
            channel_id: channel,
            initial_comment: initialComment,
            thread_ts: threadTs,
          });
          return JSON.stringify({ files: data.files.map((file) => ({ id: file.id, title: file.title, permalink: file.permalink })) }, null, 2);
        },
      })
    );
  }

  private registerAddReaction() {
    this.register(
      defineTool({
        name: 'slack_add_reaction',
        displayName: 'Add Slack Reaction',
        description: 'Add an emoji reaction to a Slack message',
        input: z.object({
          channel: z.string().describe('Channel id'),
          ts: z.string().describe('Message ts'),
          name: z.string().describe('Emoji name without colons, e.g. thumbsup'),
        }),
        execute: async ({ channel, ts, name }) => {
          await this.call('reactions.add', { channel, timestamp: ts, name: name.replace(/:/g, '') });
          return JSON.stringify({ ok: true, channel, ts, name }, null, 2);
        },
      })
    );
  }
}

/** Create the Slack Web API tool registry. */
export function createSlackApiTools(config: SlackApiConfig): SlackApiTools {
  return new SlackApiTools(config);
}
