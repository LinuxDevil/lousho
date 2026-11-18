import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';
import { defineTool, type DefinedTool } from '../defineTool';
import { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { assertOk } from './assertOk';
import { toolFailure } from './toolFailure';

/** OAuth client credentials and a refresh token for a Google Workspace user. */
export interface GoogleWorkspaceConfig {
  /** Google OAuth client ID. */
  clientId: string;
  /** Google OAuth client secret. */
  clientSecret: string;
  /** Refresh token from the OAuth consent flow. */
  refreshToken: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MEET = 'https://meet.googleapis.com/v2';
const MAX_TEXT_CHARS = 200_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents';

const GOOGLE_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

type Query = Record<string, string | number | boolean | undefined>;
type RequestOptions = { method?: string; headers?: Record<string, string>; body?: string };

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

interface DocsElement {
  paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocsElement[] }> }> };
  tableOfContents?: { content?: DocsElement[] };
}

function withQuery(url: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

function jsonBody(method: string, body: unknown): RequestOptions {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || /json|xml|javascript|csv|yaml|x-sh|sql/.test(mimeType);
}

function header(part: GmailPart | undefined, name: string): string | undefined {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function flattenParts(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(flattenParts)];
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function docsText(elements: DocsElement[] | undefined): string {
  return (elements ?? [])
    .map((el) => {
      if (el.paragraph) return (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
      if (el.table) {
        return (el.table.tableRows ?? [])
          .map((row) => (row.tableCells ?? []).map((cell) => docsText(cell.content).trim()).join('\t'))
          .join('\n') + '\n';
      }
      if (el.tableOfContents) return docsText(el.tableOfContents.content);
      return '';
    })
    .join('');
}

function eventTime(value: string, timeZone?: string): Record<string, string> {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

function conferenceRecordName(id: string): string {
  return id.startsWith('conferenceRecords/') ? id : `conferenceRecords/${id}`;
}

function buildRawEmail(message: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html?: boolean;
  inReplyTo?: string;
}): string {
  const lines = [
    `To: ${message.to.join(', ')}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    ...(message.bcc?.length ? [`Bcc: ${message.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`, `References: ${message.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: ${message.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.body, 'utf8').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

const emailInput = z.object({
  to: z.array(z.string().min(1)).min(1).describe('Recipient email addresses'),
  cc: z.array(z.string()).optional().describe('Cc addresses'),
  bcc: z.array(z.string()).optional().describe('Bcc addresses'),
  subject: z.string().describe('Subject line'),
  body: z.string().describe('Message body'),
  html: z.boolean().optional().describe('Treat body as HTML instead of plain text'),
  threadId: z.string().optional().describe('Gmail thread ID to reply within'),
  inReplyTo: z.string().optional().describe('Message-ID header of the message being replied to'),
});

const eventFields = {
  summary: z.string().optional().describe('Event title'),
  description: z.string().optional().describe('Event description'),
  location: z.string().optional().describe('Event location'),
  timeZone: z.string().optional().describe('IANA time zone for start/end, e.g. Asia/Riyadh'),
  attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
  sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().describe('Who gets notified (default none)'),
};

/** Google Workspace tools (Drive, Calendar, Docs, Sheets, Gmail, Meet) over the Google REST APIs. */
export class GoogleWorkspaceTools extends ToolRegistry {
  private config: GoogleWorkspaceConfig;
  private token?: { value: string; expiresAt: number };

  constructor(config: GoogleWorkspaceConfig) {
    super();
    this.config = config;
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

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
      }).toString(),
    });
    await assertOk(response, 'Failed to refresh Google access token');
    const data = (await response.json()) as { access_token: string; expires_in?: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async request(url: string, failure: string, options: RequestOptions = {}): Promise<Response> {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${await this.accessToken()}` },
    });
    await assertOk(response, failure);
    return response;
  }

  private async json<T = Record<string, unknown>>(url: string, failure: string, options?: RequestOptions): Promise<T> {
    const response = await this.request(url, failure, options);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async multipartUpload(
    metadata: Record<string, unknown>,
    content: string,
    contentType: string,
    base64: boolean,
  ): Promise<unknown> {
    const boundary = `lousho-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${contentType}`,
      ...(base64 ? ['Content-Transfer-Encoding: base64'] : []),
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return this.json(
      withQuery(DRIVE_UPLOAD, { uploadType: 'multipart', supportsAllDrives: true, fields: FILE_FIELDS }),
      'Failed to upload Drive file',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
    );
  }

  private batchUpdate(url: string, requests: unknown[], failure: string): Promise<unknown> {
    return this.json(`${url}:batchUpdate`, failure, jsonBody('POST', { requests }));
  }

  private registerAllTools() {
    this.registerDrive();
    this.registerCalendar();
    this.registerDocs();
    this.registerSheets();
    this.registerGmail();
    this.registerMeet();
  }

  private registerDrive() {
    this.register(
      defineTool({
        name: 'drive_search_files',
        displayName: 'Search Drive Files',
        description: "Search Google Drive files with a Drive query, e.g. \"name contains 'report' and trashed = false\"",
        input: z.object({
          q: z.string().optional().describe('Drive search query (files.list q syntax)'),
          pageSize: z.number().int().min(1).max(100).optional().describe('Max results (default 25)'),
          pageToken: z.string().optional().describe('Token from a previous page'),
        }),
        execute: async ({ q, pageSize, pageToken }) => {
          const data = await this.json(
            withQuery(`${DRIVE}/files`, {
              q,
              pageSize: pageSize ?? 25,
              pageToken,
              fields: `nextPageToken,files(${FILE_FIELDS})`,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            }),
            'Failed to search Drive files',
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'drive_read_file',
        displayName: 'Read Drive File',
        description: 'Read a Drive file as text. Google Docs and Slides come back as plain text, Sheets as CSV',
        input: z.object({ fileId: z.string().describe('Drive file ID') }),
        execute: async ({ fileId }) => {
          const fileUrl = `${DRIVE}/files/${encodeURIComponent(fileId)}`;
          const meta = await this.json<{ id: string; name: string; mimeType: string }>(
            withQuery(fileUrl, { fields: FILE_FIELDS, supportsAllDrives: true }),
            'Failed to get Drive file',
          );
          const exportType = GOOGLE_EXPORTS[meta.mimeType];
          if (!exportType && meta.mimeType.startsWith('application/vnd.google-apps.')) {
            throw toolFailure(`Cannot read ${meta.mimeType} as text`);
          }
          if (!exportType && !isTextMime(meta.mimeType)) {
            throw toolFailure(`File is ${meta.mimeType}, not a text file`);
          }
          const response = exportType
            ? await this.request(withQuery(`${fileUrl}/export`, { mimeType: exportType }), 'Failed to export Drive file')
            : await this.request(withQuery(fileUrl, { alt: 'media', supportsAllDrives: true }), 'Failed to download Drive file');
          const text = await response.text();
          return JSON.stringify(
            {
              id: meta.id,
              name: meta.name,
              mimeType: meta.mimeType,
              content: text.slice(0, MAX_TEXT_CHARS),
              truncated: text.length > MAX_TEXT_CHARS,
            },
            null,
            2,
          );
        },
      }),
    );

    this.register(
      defineTool({
        name: 'drive_create_file',
        displayName: 'Create Drive File',
        description: 'Create a Drive file from text. Use mimeType application/vnd.google-apps.document to make a Google Doc',
        input: z.object({
          name: z.string().describe('File name'),
          content: z.string().describe('Text content'),
          mimeType: z.string().optional().describe('File MIME type (default text/plain)'),
          parentId: z.string().optional().describe('Parent folder ID'),
        }),
        execute: async ({ name, content, mimeType, parentId }) => {
          const type = mimeType ?? 'text/plain';
          const metadata = { name, mimeType: type, ...(parentId ? { parents: [parentId] } : {}) };
          const media = type.startsWith('application/vnd.google-apps.') ? 'text/plain' : type;
          return JSON.stringify(await this.multipartUpload(metadata, content, `${media}; charset=UTF-8`, false), null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'drive_create_folder',
        displayName: 'Create Drive Folder',
        description: 'Create a folder in Google Drive',
        input: z.object({
          name: z.string().describe('Folder name'),
          parentId: z.string().optional().describe('Parent folder ID'),
        }),
        execute: async ({ name, parentId }) => {
          const data = await this.json(
            withQuery(`${DRIVE}/files`, { supportsAllDrives: true, fields: FILE_FIELDS }),
            'Failed to create Drive folder',
            jsonBody('POST', {
              name,
              mimeType: 'application/vnd.google-apps.folder',
              ...(parentId ? { parents: [parentId] } : {}),
            }),
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'drive_upload_file',
        displayName: 'Upload Drive File',
        description: 'Upload a binary file to Google Drive from base64 content',
        input: z.object({
          name: z.string().describe('File name'),
          content: z.string().describe('Base64-encoded file content'),
          mimeType: z.string().describe('File MIME type'),
          parentId: z.string().optional().describe('Parent folder ID'),
        }),
        execute: async ({ name, content, mimeType, parentId }) => {
          const metadata = { name, ...(parentId ? { parents: [parentId] } : {}) };
          return JSON.stringify(await this.multipartUpload(metadata, content, mimeType, true), null, 2);
        },
      }),
    );
  }

  private registerCalendar() {
    this.register(
      defineTool({
        name: 'calendar_list_events',
        displayName: 'List Calendar Events',
        description: 'List Google Calendar events in a time window, ordered by start time',
        input: z.object({
          calendarId: z.string().optional().describe("Calendar ID (default 'primary')"),
          timeMin: z.string().optional().describe('RFC 3339 lower bound, e.g. 2026-01-01T00:00:00Z'),
          timeMax: z.string().optional().describe('RFC 3339 upper bound'),
          q: z.string().optional().describe('Free-text search'),
          maxResults: z.number().int().min(1).max(250).optional().describe('Max events (default 25)'),
        }),
        execute: async ({ calendarId, timeMin, timeMax, q, maxResults }) => {
          const data = await this.json<{ items?: Array<Record<string, unknown>> }>(
            withQuery(`${CALENDAR}/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events`, {
              timeMin,
              timeMax,
              q,
              maxResults: maxResults ?? 25,
              singleEvents: true,
              orderBy: 'startTime',
            }),
            'Failed to list calendar events',
          );
          const events = (data.items ?? []).map((e) => ({
            id: e.id,
            summary: e.summary,
            start: e.start,
            end: e.end,
            location: e.location,
            status: e.status,
            attendees: (e.attendees as Array<{ email: string; responseStatus?: string }> | undefined)?.map((a) => ({
              email: a.email,
              responseStatus: a.responseStatus,
            })),
            hangoutLink: e.hangoutLink,
            htmlLink: e.htmlLink,
          }));
          return JSON.stringify(events, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'calendar_check_freebusy',
        displayName: 'Check Calendar Free/Busy',
        description: 'Get busy time ranges for one or more calendars in a time window',
        input: z.object({
          timeMin: z.string().describe('RFC 3339 start of window'),
          timeMax: z.string().describe('RFC 3339 end of window'),
          calendarIds: z.array(z.string()).optional().describe("Calendar IDs or emails (default ['primary'])"),
          timeZone: z.string().optional().describe('IANA time zone for the response'),
        }),
        execute: async ({ timeMin, timeMax, calendarIds, timeZone }) => {
          const data = await this.json<{ calendars?: unknown }>(
            `${CALENDAR}/freeBusy`,
            'Failed to check free/busy',
            jsonBody('POST', {
              timeMin,
              timeMax,
              timeZone,
              items: (calendarIds ?? ['primary']).map((id) => ({ id })),
            }),
          );
          return JSON.stringify(data.calendars ?? {}, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'calendar_create_event',
        displayName: 'Create Calendar Event',
        description: 'Create a Google Calendar event, optionally with a Google Meet link',
        input: z.object({
          calendarId: z.string().optional().describe("Calendar ID (default 'primary')"),
          start: z.string().describe('RFC 3339 date-time, or YYYY-MM-DD for all-day'),
          end: z.string().describe('RFC 3339 date-time, or YYYY-MM-DD (exclusive) for all-day'),
          ...eventFields,
          summary: z.string().describe('Event title'),
          addMeet: z.boolean().optional().describe('Attach a Google Meet link'),
        }),
        execute: async ({ calendarId, start, end, timeZone, attendees, addMeet, sendUpdates, ...rest }) => {
          const event = {
            ...rest,
            start: eventTime(start, timeZone),
            end: eventTime(end, timeZone),
            ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
            ...(addMeet
              ? { conferenceData: { createRequest: { requestId: `lousho-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
              : {}),
          };
          const data = await this.json(
            withQuery(`${CALENDAR}/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events`, {
              sendUpdates,
              conferenceDataVersion: addMeet ? 1 : undefined,
            }),
            'Failed to create calendar event',
            jsonBody('POST', event),
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'calendar_update_event',
        displayName: 'Update Calendar Event',
        description: 'Patch a Google Calendar event; only the given fields change. attendees replaces the whole list',
        input: z.object({
          calendarId: z.string().optional().describe("Calendar ID (default 'primary')"),
          eventId: z.string().describe('Event ID'),
          start: z.string().optional().describe('RFC 3339 date-time, or YYYY-MM-DD for all-day'),
          end: z.string().optional().describe('RFC 3339 date-time, or YYYY-MM-DD for all-day'),
          ...eventFields,
        }),
        execute: async ({ calendarId, eventId, start, end, timeZone, attendees, sendUpdates, ...rest }) => {
          const patch = {
            ...rest,
            ...(start ? { start: eventTime(start, timeZone) } : {}),
            ...(end ? { end: eventTime(end, timeZone) } : {}),
            ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
          };
          const data = await this.json(
            withQuery(
              `${CALENDAR}/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events/${encodeURIComponent(eventId)}`,
              { sendUpdates },
            ),
            'Failed to update calendar event',
            jsonBody('PATCH', patch),
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );
  }

  private registerDocs() {
    this.register(
      defineTool({
        name: 'docs_read_document',
        displayName: 'Read Google Doc',
        description: 'Read a Google Doc and return its title and plain text',
        input: z.object({ documentId: z.string().describe('Google Doc ID') }),
        execute: async ({ documentId }) => {
          const doc = await this.json<{ documentId: string; title: string; body?: { content?: DocsElement[] } }>(
            `${DOCS}/${encodeURIComponent(documentId)}`,
            'Failed to read Google Doc',
          );
          const text = docsText(doc.body?.content);
          return JSON.stringify(
            {
              documentId: doc.documentId,
              title: doc.title,
              text: text.slice(0, MAX_TEXT_CHARS),
              truncated: text.length > MAX_TEXT_CHARS,
            },
            null,
            2,
          );
        },
      }),
    );

    this.register(
      defineTool({
        name: 'docs_create_document',
        displayName: 'Create Google Doc',
        description: 'Create a Google Doc with a title and optional initial text',
        input: z.object({
          title: z.string().describe('Document title'),
          text: z.string().optional().describe('Initial body text'),
        }),
        execute: async ({ title, text }) => {
          const doc = await this.json<{ documentId: string; title: string }>(
            DOCS,
            'Failed to create Google Doc',
            jsonBody('POST', { title }),
          );
          if (text) {
            await this.batchUpdate(
              `${DOCS}/${encodeURIComponent(doc.documentId)}`,
              [{ insertText: { text, endOfSegmentLocation: {} } }],
              'Failed to write Google Doc text',
            );
          }
          return JSON.stringify(
            { documentId: doc.documentId, title: doc.title, url: `https://docs.google.com/document/d/${doc.documentId}/edit` },
            null,
            2,
          );
        },
      }),
    );

    this.register(
      defineTool({
        name: 'docs_append_text',
        displayName: 'Append to Google Doc',
        description: 'Append text to the end of a Google Doc',
        input: z.object({
          documentId: z.string().describe('Google Doc ID'),
          text: z.string().describe('Text to append; include a leading newline to start a new paragraph'),
        }),
        execute: async ({ documentId, text }) => {
          await this.batchUpdate(
            `${DOCS}/${encodeURIComponent(documentId)}`,
            [{ insertText: { text, endOfSegmentLocation: {} } }],
            'Failed to append to Google Doc',
          );
          return JSON.stringify({ documentId, appended: text.length }, null, 2);
        },
      }),
    );
  }

  private registerSheets() {
    const sheetUrl = (spreadsheetId: string) => `${SHEETS}/${encodeURIComponent(spreadsheetId)}`;
    const spreadsheetId = z.string().describe('Spreadsheet ID');
    const sheetId = z.number().int().describe('Numeric tab ID (sheetId from sheets_list_tabs)');

    this.register(
      defineTool({
        name: 'sheets_list_tabs',
        displayName: 'List Sheet Tabs',
        description: 'List the tabs of a Google Sheets spreadsheet with their IDs and sizes',
        input: z.object({ spreadsheetId }),
        execute: async ({ spreadsheetId }) => {
          const data = await this.json<{
            properties?: { title?: string };
            sheets?: Array<{ properties: { sheetId: number; title: string; index: number; gridProperties?: { rowCount?: number; columnCount?: number } } }>;
          }>(withQuery(sheetUrl(spreadsheetId), { fields: 'properties.title,sheets.properties' }), 'Failed to list sheet tabs');
          return JSON.stringify(
            {
              title: data.properties?.title,
              tabs: (data.sheets ?? []).map(({ properties: p }) => ({
                sheetId: p.sheetId,
                title: p.title,
                index: p.index,
                rowCount: p.gridProperties?.rowCount,
                columnCount: p.gridProperties?.columnCount,
              })),
            },
            null,
            2,
          );
        },
      }),
    );

    this.register(
      defineTool({
        name: 'sheets_read_range',
        displayName: 'Read Sheet Range',
        description: "Read cell values from an A1 range, e.g. 'Sheet1!A1:D20'",
        input: z.object({ spreadsheetId, range: z.string().describe('A1 notation range') }),
        execute: async ({ spreadsheetId, range }) => {
          const data = await this.json<{ range?: string; values?: unknown[][] }>(
            `${sheetUrl(spreadsheetId)}/values/${encodeURIComponent(range)}`,
            'Failed to read sheet range',
          );
          return JSON.stringify({ range: data.range, values: data.values ?? [] }, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'sheets_write_range',
        displayName: 'Write Sheet Range',
        description: 'Write a 2D array of values to an A1 range. Values are parsed as if typed (formulas work)',
        input: z.object({
          spreadsheetId,
          range: z.string().describe('A1 notation range'),
          values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).describe('Rows of cell values'),
        }),
        execute: async ({ spreadsheetId, range, values }) => {
          const data = await this.json(
            withQuery(`${sheetUrl(spreadsheetId)}/values/${encodeURIComponent(range)}`, { valueInputOption: 'USER_ENTERED' }),
            'Failed to write sheet range',
            jsonBody('PUT', { range, values }),
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'sheets_add_tab',
        displayName: 'Add Sheet Tab',
        description: 'Add a tab to a spreadsheet',
        input: z.object({ spreadsheetId, title: z.string().describe('New tab title') }),
        execute: async ({ spreadsheetId, title }) => {
          const data = await this.batchUpdate(sheetUrl(spreadsheetId), [{ addSheet: { properties: { title } } }], 'Failed to add sheet tab');
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'sheets_rename_tab',
        displayName: 'Rename Sheet Tab',
        description: 'Rename a spreadsheet tab',
        input: z.object({ spreadsheetId, sheetId, title: z.string().describe('New tab title') }),
        execute: async ({ spreadsheetId, sheetId, title }) => {
          await this.batchUpdate(
            sheetUrl(spreadsheetId),
            [{ updateSheetProperties: { properties: { sheetId, title }, fields: 'title' } }],
            'Failed to rename sheet tab',
          );
          return JSON.stringify({ spreadsheetId, sheetId, title }, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'sheets_delete_tab',
        displayName: 'Delete Sheet Tab',
        description: 'Delete a spreadsheet tab and all its data',
        input: z.object({ spreadsheetId, sheetId }),
        execute: async ({ spreadsheetId, sheetId }) => {
          await this.batchUpdate(sheetUrl(spreadsheetId), [{ deleteSheet: { sheetId } }], 'Failed to delete sheet tab');
          return JSON.stringify({ spreadsheetId, sheetId, deleted: true }, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'sheets_create_spreadsheet',
        displayName: 'Create Spreadsheet',
        description: 'Create a Google Sheets spreadsheet, optionally with named tabs',
        input: z.object({
          title: z.string().describe('Spreadsheet title'),
          tabs: z.array(z.string()).optional().describe('Tab titles to create'),
        }),
        execute: async ({ title, tabs }) => {
          const data = await this.json<{ spreadsheetId: string; spreadsheetUrl: string; sheets?: Array<{ properties: { sheetId: number; title: string } }> }>(
            SHEETS,
            'Failed to create spreadsheet',
            jsonBody('POST', {
              properties: { title },
              ...(tabs?.length ? { sheets: tabs.map((t) => ({ properties: { title: t } })) } : {}),
            }),
          );
          return JSON.stringify(
            {
              spreadsheetId: data.spreadsheetId,
              spreadsheetUrl: data.spreadsheetUrl,
              tabs: (data.sheets ?? []).map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title })),
            },
            null,
            2,
          );
        },
      }),
    );
  }

  private registerGmail() {
    const messageUrl = (id: string) => `${GMAIL}/messages/${encodeURIComponent(id)}`;

    this.register(
      defineTool({
        name: 'gmail_list_messages',
        displayName: 'List Gmail Messages',
        description: 'Search Gmail with Gmail query syntax (e.g. "from:alice is:unread newer_than:7d")',
        input: z.object({
          q: z.string().optional().describe('Gmail search query'),
          maxResults: z.number().int().min(1).max(50).optional().describe('Max messages (default 10)'),
          pageToken: z.string().optional().describe('Token from a previous page'),
        }),
        execute: async ({ q, maxResults, pageToken }) => {
          const list = await this.json<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
            withQuery(`${GMAIL}/messages`, { q, maxResults: maxResults ?? 10, pageToken }),
            'Failed to list Gmail messages',
          );
          const messages = await Promise.all(
            (list.messages ?? []).map(async ({ id }) => {
              const params = new URLSearchParams({ format: 'metadata' });
              for (const h of ['From', 'Subject', 'Date']) params.append('metadataHeaders', h);
              const m = await this.json<GmailMessage>(`${messageUrl(id)}?${params}`, 'Failed to get Gmail message');
              return {
                id: m.id,
                threadId: m.threadId,
                from: header(m.payload, 'From'),
                subject: header(m.payload, 'Subject'),
                date: header(m.payload, 'Date'),
                snippet: m.snippet,
                labelIds: m.labelIds,
              };
            }),
          );
          return JSON.stringify({ messages, nextPageToken: list.nextPageToken }, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'gmail_read_message',
        displayName: 'Read Gmail Message',
        description: 'Read a Gmail message: headers, text body, and attachment list',
        input: z.object({ messageId: z.string().describe('Gmail message ID') }),
        execute: async ({ messageId }) => {
          const m = await this.json<GmailMessage>(withQuery(messageUrl(messageId), { format: 'full' }), 'Failed to read Gmail message');
          const parts = flattenParts(m.payload);
          const plain = parts.find((p) => p.mimeType === 'text/plain' && !p.filename && p.body?.data);
          const html = parts.find((p) => p.mimeType === 'text/html' && !p.filename && p.body?.data);
          const body = plain?.body?.data
            ? decodeBase64Url(plain.body.data)
            : html?.body?.data
              ? decodeBase64Url(html.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
              : '';
          return JSON.stringify(
            {
              id: m.id,
              threadId: m.threadId,
              labelIds: m.labelIds,
              from: header(m.payload, 'From'),
              to: header(m.payload, 'To'),
              cc: header(m.payload, 'Cc'),
              subject: header(m.payload, 'Subject'),
              date: header(m.payload, 'Date'),
              messageIdHeader: header(m.payload, 'Message-ID'),
              body: body.slice(0, MAX_TEXT_CHARS),
              truncated: body.length > MAX_TEXT_CHARS,
              attachments: parts
                .filter((p) => p.filename && p.body?.attachmentId)
                .map((p) => ({ attachmentId: p.body!.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body!.size })),
            },
            null,
            2,
          );
        },
      }),
    );

    this.register(
      defineTool({
        name: 'gmail_download_attachment',
        displayName: 'Download Gmail Attachment',
        description: `Download a Gmail attachment as base64 (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`,
        input: z.object({
          messageId: z.string().describe('Gmail message ID'),
          attachmentId: z.string().describe('Attachment ID from gmail_read_message'),
        }),
        execute: async ({ messageId, attachmentId }) => {
          const m = await this.json<GmailMessage>(withQuery(messageUrl(messageId), { format: 'full' }), 'Failed to read Gmail message');
          const part = flattenParts(m.payload).find((p) => p.body?.attachmentId === attachmentId);
          if ((part?.body?.size ?? 0) > MAX_ATTACHMENT_BYTES) {
            throw toolFailure(`Attachment is ${part!.body!.size} bytes, over the ${MAX_ATTACHMENT_BYTES} byte limit`);
          }
          const data = await this.json<{ data: string; size: number }>(
            `${messageUrl(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
            'Failed to download Gmail attachment',
          );
          if (data.size > MAX_ATTACHMENT_BYTES) {
            throw toolFailure(`Attachment is ${data.size} bytes, over the ${MAX_ATTACHMENT_BYTES} byte limit`);
          }
          return JSON.stringify(
            {
              filename: part?.filename ?? 'attachment',
              mimeType: part?.mimeType,
              size: data.size,
              contentBase64: Buffer.from(data.data, 'base64url').toString('base64'),
            },
            null,
            2,
          );
        },
      }),
    );

    this.register(
      defineTool({
        name: 'gmail_create_draft',
        displayName: 'Create Gmail Draft',
        description: 'Create a Gmail draft without sending it',
        input: emailInput,
        execute: async ({ threadId, ...message }) => {
          const data = await this.json(
            `${GMAIL}/drafts`,
            'Failed to create Gmail draft',
            jsonBody('POST', { message: { raw: buildRawEmail(message), ...(threadId ? { threadId } : {}) } }),
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'gmail_send_email',
        displayName: 'Send Gmail Email',
        description: 'Send an email from the connected Gmail account',
        input: emailInput,
        execute: async ({ threadId, ...message }) => {
          const data = await this.json(
            `${GMAIL}/messages/send`,
            'Failed to send Gmail email',
            jsonBody('POST', { raw: buildRawEmail(message), ...(threadId ? { threadId } : {}) }),
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'gmail_modify_labels',
        displayName: 'Modify Gmail Labels',
        description: 'Add or remove label IDs on a message (e.g. remove UNREAD to mark read, remove INBOX to archive)',
        input: z.object({
          messageId: z.string().describe('Gmail message ID'),
          addLabelIds: z.array(z.string()).optional().describe('Label IDs to add'),
          removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove'),
        }),
        execute: async ({ messageId, addLabelIds, removeLabelIds }) => {
          const data = await this.json<GmailMessage>(
            `${messageUrl(messageId)}/modify`,
            'Failed to modify Gmail labels',
            jsonBody('POST', { addLabelIds: addLabelIds ?? [], removeLabelIds: removeLabelIds ?? [] }),
          );
          return JSON.stringify({ id: data.id, labelIds: data.labelIds }, null, 2);
        },
      }),
    );
  }

  private registerMeet() {
    const conferenceRecordId = z.string().describe("Conference record ID or name ('conferenceRecords/...')");

    this.register(
      defineTool({
        name: 'meet_get_conference_record',
        displayName: 'Get Meet Conference Record',
        description: 'Get a Google Meet conference record by ID, or list recent records for a meeting code',
        input: z.object({
          conferenceRecordId: conferenceRecordId.optional(),
          meetingCode: z.string().optional().describe('Meeting code, e.g. abc-mnop-xyz'),
        }),
        execute: async ({ conferenceRecordId, meetingCode }) => {
          if (conferenceRecordId) {
            const data = await this.json(`${MEET}/${conferenceRecordName(conferenceRecordId)}`, 'Failed to get conference record');
            return JSON.stringify(data, null, 2);
          }
          if (!meetingCode) throw toolFailure('Provide conferenceRecordId or meetingCode');
          const data = await this.json(
            withQuery(`${MEET}/conferenceRecords`, { filter: `space.meeting_code = "${meetingCode}"` }),
            'Failed to list conference records',
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'meet_list_transcript_entries',
        displayName: 'List Meet Transcript Entries',
        description: 'List transcript entries (speaker and text) for a Google Meet conference record',
        input: z.object({
          conferenceRecordId,
          transcriptId: z.string().optional().describe('Transcript ID; defaults to the first transcript of the record'),
          pageSize: z.number().int().min(1).max(100).optional().describe('Max entries (default 100)'),
          pageToken: z.string().optional().describe('Token from a previous page'),
        }),
        execute: async ({ conferenceRecordId, transcriptId, pageSize, pageToken }) => {
          const record = conferenceRecordName(conferenceRecordId);
          let transcript = transcriptId ? `${record}/transcripts/${transcriptId.split('/').pop()}` : undefined;
          if (!transcript) {
            const list = await this.json<{ transcripts?: Array<{ name: string }> }>(
              `${MEET}/${record}/transcripts`,
              'Failed to list transcripts',
            );
            transcript = list.transcripts?.[0]?.name;
            if (!transcript) return JSON.stringify({ entries: [], message: 'No transcript for this conference' }, null, 2);
          }
          const data = await this.json(
            withQuery(`${MEET}/${transcript}/entries`, { pageSize: pageSize ?? 100, pageToken }),
            'Failed to list transcript entries',
          );
          return JSON.stringify({ transcript, ...data }, null, 2);
        },
      }),
    );

    this.register(
      defineTool({
        name: 'meet_list_participants',
        displayName: 'List Meet Participants',
        description: 'List participants of a Google Meet conference record',
        input: z.object({
          conferenceRecordId,
          pageSize: z.number().int().min(1).max(250).optional().describe('Max participants (default 100)'),
          pageToken: z.string().optional().describe('Token from a previous page'),
        }),
        execute: async ({ conferenceRecordId, pageSize, pageToken }) => {
          const data = await this.json(
            withQuery(`${MEET}/${conferenceRecordName(conferenceRecordId)}/participants`, { pageSize: pageSize ?? 100, pageToken }),
            'Failed to list Meet participants',
          );
          return JSON.stringify(data, null, 2);
        },
      }),
    );
  }
}

/** Creates the Google Workspace tool registry; pass `.getAll()` to an agent. */
export function createGoogleWorkspaceTools(config: GoogleWorkspaceConfig): GoogleWorkspaceTools {
  return new GoogleWorkspaceTools(config);
}
