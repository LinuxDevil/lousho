import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFigmaTools, parseFigmaRef, trimFigmaNode, type FigmaTools } from './figma';
import { getToolExecute } from '../toolContract';
import type { ToolExecutionContext } from '../../types';

const ctx = {} as ToolExecutionContext;

function run(tools: FigmaTools, name: string, input: Record<string, unknown>) {
  const execute = getToolExecute(tools.get(name)!);
  return execute!(input, ctx) as Promise<string>;
}

describe('parseFigmaRef', () => {
  it('parses design and file URLs with node ids', () => {
    expect(parseFigmaRef('https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=x')).toEqual({ fileKey: 'AbC123', nodeId: '12:34' });
    expect(parseFigmaRef('https://www.figma.com/file/Key9/Name')).toEqual({ fileKey: 'Key9', nodeId: undefined });
  });

  it('uses the branch key for branch URLs', () => {
    expect(parseFigmaRef('https://www.figma.com/design/Main1/branch/Br2/Name').fileKey).toBe('Br2');
  });

  it('passes a bare file key through', () => {
    expect(parseFigmaRef('AbC123')).toEqual({ fileKey: 'AbC123' });
  });
});

describe('trimFigmaNode', () => {
  it('keeps layout, paint and text fields and stops at the depth limit', () => {
    const node = {
      id: '1:1',
      name: 'Frame',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      fills: [],
      blendMode: 'NORMAL',
      children: [
        {
          id: '1:2',
          name: 'Label',
          type: 'TEXT',
          characters: 'Hi',
          style: { fontSize: 12 },
          fills: [{ type: 'SOLID' }],
          children: [{ id: '1:3', name: 'Deep', type: 'RECTANGLE' }],
        },
      ],
    };

    expect(trimFigmaNode(node, 1)).toEqual({
      id: '1:1',
      name: 'Frame',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      children: [
        { id: '1:2', name: 'Label', type: 'TEXT', characters: 'Hi', style: { fontSize: 12 }, fills: [{ type: 'SOLID' }], childCount: 1 },
      ],
    });
  });
});

describe('FigmaTools', () => {
  let tools: FigmaTools;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tools = createFigmaTools({ token: 'figd_test' });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the expected tools', () => {
    expect(tools.list().sort()).toEqual([
      'figma_get_comments',
      'figma_get_node',
      'figma_get_node_image',
      'figma_get_variables',
      'figma_list_pages',
    ]);
  });

  it('requests node images from a URL with the token header', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ err: null, images: { '12:34': 'https://img/1.svg' } })));

    const result = JSON.parse(
      await run(tools, 'figma_get_node_image', { fileKey: 'https://www.figma.com/design/AbC123/F?node-id=12-34', format: 'svg', scale: 2 })
    );

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.figma.com/v1/images/AbC123?ids=12%3A34&format=svg&scale=2');
    expect(init.headers['X-Figma-Token']).toBe('figd_test');
    expect(result.images).toEqual({ '12:34': 'https://img/1.svg' });
  });

  it('returns trimmed nodes from the nodes endpoint', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      nodes: { '1:2': { document: { id: '1:2', name: 'Btn', type: 'COMPONENT', effects: [], children: [{ id: '1:3', name: 'x', type: 'TEXT' }] } } },
    })));

    const result = JSON.parse(await run(tools, 'figma_get_node', { fileKey: 'AbC123', nodeIds: ['1-2'], depth: 0 }));

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.figma.com/v1/files/AbC123/nodes?ids=1%3A2&depth=1');
    expect(result.nodes).toEqual([{ id: '1:2', name: 'Btn', type: 'COMPONENT', childCount: 1 }]);
  });
});
