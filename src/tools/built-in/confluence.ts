import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';
import { defineTool, type DefinedTool } from '../defineTool';
import { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { assertOk } from './assertOk';
import { toolFailure } from './toolFailure';

/** Atlassian Cloud credentials for the Confluence tools (same as Jira). */
export interface ConfluenceConfig {
  /** Atlassian site URL, e.g. https://your-site.atlassian.net. */
  baseUrl: string;
  /** Atlassian account email. */
  email: string;
  /** Atlassian API token. */
  apiToken: string;
}

interface ConfluencePageResource {
  id: string;
  title: string;
  status: string;
  spaceId: string;
  parentId?: string;
  version: { number: number; createdAt?: string };
  body?: { storage?: { value: string } };
  _links?: { webui?: string };
}

function storageToText(storage: string): string {
  return storage
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toStorage(body: string, format: 'storage' | 'plain'): string {
  if (format === 'storage') return body;
  return body
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

const bodyFormat = z.enum(['storage', 'plain']).optional().default('storage').describe('storage = Confluence XHTML storage format, plain = plain text');

/** Confluence Cloud tools (pages, CQL search, comments). */
export class ConfluenceTools extends ToolRegistry {
  private config: ConfluenceConfig;
  private authHeader: string;

  constructor(config: ConfluenceConfig) {
    super();
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') };
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
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
    this.registerGetPage();
    this.registerSearch();
    this.registerCreatePage();
    this.registerUpdatePage();
    this.registerAddComment();
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': this.authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private async fetchPage(id: string): Promise<ConfluencePageResource> {
    const response = await fetch(`${this.config.baseUrl}/wiki/api/v2/pages/${id}?body-format=storage`, {
      headers: this.headers(),
    });
    await assertOk(response, 'Failed to get Confluence page');
    return await response.json() as ConfluencePageResource;
  }

  private summarize(page: ConfluencePageResource) {
    return {
      id: page.id,
      title: page.title,
      status: page.status,
      spaceId: page.spaceId,
      parentId: page.parentId,
      version: page.version?.number,
      url: page._links?.webui ? `${this.config.baseUrl}/wiki${page._links.webui}` : undefined,
    };
  }

  private registerGetPage() {
    this.register(
      defineTool({
        name: 'confluence_get_page',
        displayName: 'Get Confluence Page',
        description: 'Get a Confluence page by id, with its body in storage format and as plain text',
        input: z.object({
          pageId: z.string().describe('The Confluence page id'),
        }),
        execute: async ({ pageId }) => {
          const page = await this.fetchPage(pageId);
          const storage = page.body?.storage?.value ?? '';
          return JSON.stringify({ ...this.summarize(page), body: storage, text: storageToText(storage) }, null, 2);
        },
      })
    );
  }

  private registerSearch() {
    this.register(
      defineTool({
        name: 'confluence_search',
        displayName: 'Search Confluence',
        description: 'Search Confluence with CQL, or with plain text (matched as text ~ "...")',
        input: z.object({
          query: z.string().describe('A CQL query, or plain text to search for'),
          cql: z.boolean().optional().default(false).describe('Treat query as raw CQL'),
          limit: z.number().optional().default(25).describe('Maximum number of results'),
        }),
        execute: async ({ query, cql = false, limit = 25 }) => {
          const cqlQuery = cql ? query : `text ~ "${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
          const params = new URLSearchParams({ cql: cqlQuery, limit: String(limit) });
          const response = await fetch(`${this.config.baseUrl}/wiki/rest/api/search?${params}`, {
            headers: this.headers(),
          });
          await assertOk(response, 'Failed to search Confluence');
          const data = await response.json() as {
            totalSize?: number;
            results: Array<{
              title: string;
              excerpt?: string;
              url?: string;
              lastModified?: string;
              content?: { id: string; type: string; space?: { key?: string } };
            }>;
          };
          const results = data.results.map((result) => ({
            id: result.content?.id,
            type: result.content?.type,
            title: result.title,
            spaceKey: result.content?.space?.key,
            excerpt: result.excerpt,
            url: result.url ? `${this.config.baseUrl}/wiki${result.url}` : undefined,
            lastModified: result.lastModified,
          }));
          return JSON.stringify({ total: data.totalSize ?? results.length, cql: cqlQuery, results }, null, 2);
        },
      })
    );
  }

  private async resolveSpaceId(spaceId: string | undefined, spaceKey: string | undefined): Promise<string> {
    if (spaceId) return spaceId;
    if (!spaceKey) throw toolFailure('Provide spaceId or spaceKey');
    const response = await fetch(`${this.config.baseUrl}/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`, {
      headers: this.headers(),
    });
    await assertOk(response, 'Failed to resolve Confluence space');
    const data = await response.json() as { results: Array<{ id: string }> };
    const space = data.results[0];
    if (!space) throw toolFailure(`Confluence space not found: ${spaceKey}`);
    return space.id;
  }

  private registerCreatePage() {
    this.register(
      defineTool({
        name: 'confluence_create_page',
        displayName: 'Create Confluence Page',
        description: 'Create a Confluence page in a space (by id or key), optionally under a parent page',
        input: z.object({
          spaceId: z.string().optional().describe('Space id'),
          spaceKey: z.string().optional().describe('Space key, used when spaceId is not given'),
          title: z.string().describe('Page title'),
          body: z.string().describe('Page body'),
          bodyFormat,
          parentId: z.string().optional().describe('Parent page id'),
        }),
        execute: async ({ spaceId, spaceKey, title, body, bodyFormat: format = 'storage', parentId }) => {
          const resolvedSpaceId = await this.resolveSpaceId(spaceId, spaceKey);
          const response = await fetch(`${this.config.baseUrl}/wiki/api/v2/pages`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
              spaceId: resolvedSpaceId,
              status: 'current',
              title,
              ...(parentId ? { parentId } : {}),
              body: { representation: 'storage', value: toStorage(body, format) },
            }),
          });
          await assertOk(response, 'Failed to create Confluence page');
          const page = await response.json() as ConfluencePageResource;
          return JSON.stringify(this.summarize(page), null, 2);
        },
      })
    );
  }

  private registerUpdatePage() {
    this.register(
      defineTool({
        name: 'confluence_update_page',
        displayName: 'Update Confluence Page',
        description: 'Update a Confluence page title and/or body; the version number is incremented automatically',
        input: z.object({
          pageId: z.string().describe('The Confluence page id'),
          title: z.string().optional().describe('New title (defaults to the current title)'),
          body: z.string().optional().describe('New body (defaults to the current body)'),
          bodyFormat,
          versionMessage: z.string().optional().describe('Version comment'),
        }),
        execute: async ({ pageId, title, body, bodyFormat: format = 'storage', versionMessage }) => {
          const current = await this.fetchPage(pageId);
          const response = await fetch(`${this.config.baseUrl}/wiki/api/v2/pages/${pageId}`, {
            method: 'PUT',
            headers: this.headers(),
            body: JSON.stringify({
              id: pageId,
              status: 'current',
              title: title ?? current.title,
              body: {
                representation: 'storage',
                value: body === undefined ? current.body?.storage?.value ?? '' : toStorage(body, format),
              },
              version: { number: current.version.number + 1, ...(versionMessage ? { message: versionMessage } : {}) },
            }),
          });
          await assertOk(response, 'Failed to update Confluence page');
          const page = await response.json() as ConfluencePageResource;
          return JSON.stringify(this.summarize(page), null, 2);
        },
      })
    );
  }

  private registerAddComment() {
    this.register(
      defineTool({
        name: 'confluence_add_comment',
        displayName: 'Add Confluence Comment',
        description: 'Add a footer comment to a Confluence page',
        input: z.object({
          pageId: z.string().describe('The Confluence page id'),
          body: z.string().describe('Comment body'),
          bodyFormat,
        }),
        execute: async ({ pageId, body, bodyFormat: format = 'storage' }) => {
          const response = await fetch(`${this.config.baseUrl}/wiki/api/v2/footer-comments`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
              pageId,
              body: { representation: 'storage', value: toStorage(body, format) },
            }),
          });
          await assertOk(response, 'Failed to add Confluence comment');
          const comment = await response.json() as { id: string; version?: { number: number } };
          return JSON.stringify({ id: comment.id, pageId }, null, 2);
        },
      })
    );
  }
}

/** Create the Confluence tool registry. */
export function createConfluenceTools(config: ConfluenceConfig): ConfluenceTools {
  return new ConfluenceTools(config);
}
