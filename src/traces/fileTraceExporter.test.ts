/**
 * FileTraceExporter() writes each run of a createAgent() agent as one
 * JSON Lines file under `<dir>/<YYYY-MM-DD>/<traceId>.jsonl`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { fileTraceExporter } from './fileTraceExporter';
import type { TraceLine } from './format';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});

const callWeather = {
  toolCalls: [{ name: 'get_weather', args: { city: 'Paris' }, id: 'call_1' }],
  usage: { inputTokens: 20, outputTokens: 5 },
};

/** Every trace file under `dir`, each as its parsed lines. */
function traceFiles(): { file: string; lines: TraceLine[] }[] {
  const days = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return days.flatMap((day) =>
    fs.readdirSync(path.join(dir, day)).map((name) => {
      const file = path.join(dir, day, name);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as TraceLine);
      return { file, lines };
    })
  );
}

describe('fileTraceExporter', () => {

  it('warns once when the directory cannot be written, and the run still succeeds', async () => {
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'a file where the trace folder should be');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = createAgent({
      provider: mockModel([callWeather, 'Sunny.', 'Again.']),
      tools: [weather],
      exporter: fileTraceExporter({ dir: path.join(blocker, 'traces') }),
    });

    expect((await agent.send('Weather?')).text).toBe('Sunny.');
    expect((await agent.send('Again?')).text).toBe('Again.');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/fileTraceExporter could not write/);
  });

  it('writes attributes that JSON cannot hold as-is (bigints, cycles) without throwing', () => {
    const exporter = fileTraceExporter({ dir });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const span = { id: 'root2', name: 'x', attributes: { big: BigInt(7), cyclic }, startTime: Date.now() };
    exporter.onSpanStart(span);
    exporter.onSpanEnd({ ...span, endTime: span.startTime });

    const [{ lines }] = traceFiles();
    expect(lines[0].attributes).toEqual({ big: '7', cyclic: { a: 1, self: '[Circular]' } });
  });
});
