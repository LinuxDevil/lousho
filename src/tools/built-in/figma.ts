import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';
import { defineTool, type DefinedTool } from '../defineTool';
import { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { assertOk } from './assertOk';
import { toolFailure } from './toolFailure';

/** Connection settings for the Figma REST API (personal access token). */
export interface FigmaConfig {
  /** Figma personal access token. */
  token: string;
}

/** A Figma node as returned by the REST API (only the fields read). */
export interface FigmaNodeResource {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: unknown;
  fills?: unknown;
  strokes?: unknown;
  characters?: string;
  style?: unknown;
  children?: FigmaNodeResource[];
}

/** A trimmed Figma node tree suitable for a model. */
export interface FigmaTrimmedNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: unknown;
  fills?: unknown;
  strokes?: unknown;
  characters?: string;
  style?: unknown;
  children?: FigmaTrimmedNode[];
  childCount?: number;
}

interface FigmaVariableResource {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
}

interface FigmaVariableCollectionResource {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
}

interface FigmaCommentResource {
  id: string;
  message: string;
  user?: { handle?: string };
  created_at: string;
  resolved_at?: string | null;
  parent_id?: string;
  client_meta?: { node_id?: string } | null;
}

const API = 'https://api.figma.com/v1';

/** Parse a Figma file key and optional node id from a file key or a Figma URL. */
export function parseFigmaRef(input: string): { fileKey: string; nodeId?: string } {
  const match = input.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (!match) return { fileKey: input.trim() };
  const nodeParam = new URL(input.startsWith('http') ? input : `https://${input}`).searchParams.get('node-id');
  return { fileKey: match[2] ?? match[1], nodeId: nodeParam ? normalizeNodeId(nodeParam) : undefined };
}

/** Normalize a node id from URL form ("1-2") to API form ("1:2"). */
export function normalizeNodeId(nodeId: string): string {
  const fromUrl = nodeId.includes('figma.com') ? parseFigmaRef(nodeId).nodeId : nodeId;
  if (!fromUrl) throw toolFailure(`No node-id in ${nodeId}`);
  return fromUrl.includes(':') ? fromUrl : fromUrl.replace(/-/g, ':');
}

/** Reduce a Figma node to its layout, paint and text fields, down to `depth` levels of children. */
export function trimFigmaNode(node: FigmaNodeResource, depth: number): FigmaTrimmedNode {
  const trimmed: FigmaTrimmedNode = { id: node.id, name: node.name, type: node.type };
  if (node.absoluteBoundingBox) trimmed.absoluteBoundingBox = node.absoluteBoundingBox;
  if (Array.isArray(node.fills) && node.fills.length) trimmed.fills = node.fills;
  if (Array.isArray(node.strokes) && node.strokes.length) trimmed.strokes = node.strokes;
  if (node.characters !== undefined) trimmed.characters = node.characters;
  if (node.style) trimmed.style = node.style;
  if (node.children?.length) {
    if (depth > 0) trimmed.children = node.children.map((child) => trimFigmaNode(child, depth - 1));
    else trimmed.childCount = node.children.length;
  }
  return trimmed;
}

/** Figma REST tools: pages, nodes, rendered images, variables and comments. */
export class FigmaTools extends ToolRegistry {
  private config: FigmaConfig;

  constructor(config: FigmaConfig) {
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

  private registerAllTools() {
    this.registerListPages();
    this.registerGetNode();
    this.registerGetNodeImage();
    this.registerGetVariables();
    this.registerGetComments();
  }

  private registerListPages() {
    this.register(
      defineTool({
        name: 'figma_list_pages',
        displayName: 'List Figma Pages',
        description: 'List the pages of a Figma file',
        input: z.object({
          fileKey: z.string().describe('Figma file key or full Figma URL'),
        }),
        execute: async ({ fileKey }) => {
          const key = parseFigmaRef(fileKey).fileKey;
          const data = await this.fetchFigma(`/files/${key}?depth=1`, 'Failed to get Figma file');
          const pages = ((data.document?.children ?? []) as FigmaNodeResource[]).map((p) => ({ id: p.id, name: p.name }));
          return JSON.stringify({ name: data.name, lastModified: data.lastModified, pages }, null, 2);
        },
      })
    );
  }

  private registerGetNode() {
    this.register(
      defineTool({
        name: 'figma_get_node',
        displayName: 'Get Figma Node',
        description: 'Get a trimmed node tree (bounds, fills, strokes, text, style, children) for one or more Figma nodes',
        input: z.object({
          fileKey: z.string().describe('Figma file key or full Figma URL (node-id is read from the URL when nodeIds is omitted)'),
          nodeIds: z.union([z.string(), z.array(z.string())]).optional().describe('Node id(s) like "1:2" or "1-2", or a Figma URL'),
          depth: z.number().int().min(0).optional().default(3).describe('How many levels of children to include'),
        }),
        execute: async ({ fileKey, nodeIds, depth = 3 }) => {
          const { key, ids } = this.resolveNodes(fileKey, nodeIds);
          const data = await this.fetchFigma(
            `/files/${key}/nodes?ids=${encodeURIComponent(ids.join(','))}&depth=${depth + 1}`,
            'Failed to get Figma nodes'
          );
          const nodes = Object.entries((data.nodes ?? {}) as Record<string, { document?: FigmaNodeResource } | null>).map(
            ([id, entry]) => (entry?.document ? trimFigmaNode(entry.document, depth) : { id, error: 'Node not found' })
          );
          return JSON.stringify({ nodes }, null, 2);
        },
      })
    );
  }

  private registerGetNodeImage() {
    this.register(
      defineTool({
        name: 'figma_get_node_image',
        displayName: 'Get Figma Node Image',
        description: 'Render Figma nodes to images and return temporary image URLs',
        input: z.object({
          fileKey: z.string().describe('Figma file key or full Figma URL'),
          nodeIds: z.union([z.string(), z.array(z.string())]).optional().describe('Node id(s) like "1:2" or "1-2", or a Figma URL'),
          format: z.enum(['png', 'svg', 'jpg']).optional().default('png').describe('Image format'),
          scale: z.number().min(0.01).max(4).optional().default(1).describe('Image scale (0.01 to 4)'),
        }),
        execute: async ({ fileKey, nodeIds, format = 'png', scale = 1 }) => {
          const { key, ids } = this.resolveNodes(fileKey, nodeIds);
          const params = new URLSearchParams({ ids: ids.join(','), format, scale: String(scale) });
          const data = await this.fetchFigma(`/images/${key}?${params}`, 'Failed to render Figma images');
          if (data.err) throw toolFailure(`Failed to render Figma images: ${data.err}`);
          return JSON.stringify({ images: data.images ?? {} }, null, 2);
        },
      })
    );
  }

  private registerGetVariables() {
    this.register(
      defineTool({
        name: 'figma_get_variables',
        displayName: 'Get Figma Variables',
        description: 'Get the local variables (design tokens) of a Figma file, grouped by collection',
        input: z.object({
          fileKey: z.string().describe('Figma file key or full Figma URL'),
        }),
        execute: async ({ fileKey }) => {
          const key = parseFigmaRef(fileKey).fileKey;
          const data = await this.fetchFigma(`/files/${key}/variables/local`, 'Failed to get Figma variables');
          const variables = Object.values((data.meta?.variables ?? {}) as Record<string, FigmaVariableResource>);
          const collections = Object.values((data.meta?.variableCollections ?? {}) as Record<string, FigmaVariableCollectionResource>).map(
            (c) => {
              const modeNames = Object.fromEntries(c.modes.map((m) => [m.modeId, m.name]));
              return {
                id: c.id,
                name: c.name,
                modes: c.modes.map((m) => m.name),
                variables: variables
                  .filter((v) => v.variableCollectionId === c.id)
                  .map((v) => ({
                    id: v.id,
                    name: v.name,
                    type: v.resolvedType,
                    values: Object.fromEntries(Object.entries(v.valuesByMode).map(([mode, value]) => [modeNames[mode] ?? mode, value])),
                  })),
              };
            }
          );
          return JSON.stringify({ collections }, null, 2);
        },
      })
    );
  }

  private registerGetComments() {
    this.register(
      defineTool({
        name: 'figma_get_comments',
        displayName: 'Get Figma Comments',
        description: 'Get the comments on a Figma file',
        input: z.object({
          fileKey: z.string().describe('Figma file key or full Figma URL'),
        }),
        execute: async ({ fileKey }) => {
          const key = parseFigmaRef(fileKey).fileKey;
          const data = await this.fetchFigma(`/files/${key}/comments`, 'Failed to get Figma comments');
          const comments = ((data.comments ?? []) as FigmaCommentResource[]).map((c) => ({
            id: c.id,
            author: c.user?.handle,
            message: c.message,
            createdAt: c.created_at,
            resolved: Boolean(c.resolved_at),
            parentId: c.parent_id || undefined,
            nodeId: c.client_meta?.node_id,
          }));
          return JSON.stringify({ comments }, null, 2);
        },
      })
    );
  }

  private resolveNodes(fileKey: string, nodeIds: string | string[] | undefined): { key: string; ids: string[] } {
    const ref = parseFigmaRef(fileKey);
    const ids = nodeIds === undefined ? (ref.nodeId ? [ref.nodeId] : []) : [nodeIds].flat().map(normalizeNodeId);
    if (ids.length === 0) throw toolFailure('Provide nodeIds or a Figma URL with a node-id');
    return { key: ref.fileKey, ids };
  }

  private async fetchFigma(path: string, failure: string) {
    const response = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': this.config.token } });
    await assertOk(response, failure);
    return response.json();
  }
}

/** Create the Figma tool registry for the given token. */
export function createFigmaTools(config: FigmaConfig): FigmaTools {
  return new FigmaTools(config);
}
