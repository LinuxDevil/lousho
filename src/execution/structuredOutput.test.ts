/**
 * `createAgent({ output })` / `ExecuteOptions.output` - the final
 * reply is parsed and validated into `result.object`, with one repair step.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';

const weather = z.object({ city: z.string(), tempC: z.number() });

describe('structured output', () => {

  describe('responseFormat and tools', () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'Current temperature',
      input: z.object({ city: z.string() }),
      execute: async () => 21,
    });
    const toolCall = { toolCalls: [{ name: 'lookup', args: { city: 'Paris' } }] };

    it("promptSchema: false defaults to 'always', the response format being the only copy of the schema", async () => {
      const model = mockModel([toolCall, '{"city":"Paris","tempC":21}']);
      await createAgent({ provider: model, tools: [lookup], output: { schema: weather, promptSchema: false } }).send('go');
      expect(model.calls[0].responseFormat?.type).toBe('json');

      const final = mockModel([toolCall, '{"city":"Paris","tempC":21}']);
      await createAgent({ provider: final, tools: [lookup], output: { schema: weather, promptSchema: false, responseFormat: 'final' } }).send('go');
      expect(final.calls[0]).not.toHaveProperty('responseFormat');
    });

    it('rejects an unknown responseFormat mode', () => {
      expect(() => createAgent({ provider: mockModel([]), output: { schema: weather, responseFormat: 'sometimes' as never } })).toThrow(
        /output\.responseFormat must be 'final' or 'always'/
      );
    });
  });

  it('stream(): run.done has no object when the output is invalid', async () => {
    const agent = createAgent({ provider: mockModel(['x', 'y']), output: weather });

    const run = agent.stream('go');
    const events: AgentEvent[] = [];
    for await (const event of run) events.push(event);

    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'run.done', finishReason: 'output-invalid' });
    expect(done).not.toHaveProperty('object');
    expect((await run.result).outputError?.issues).toHaveLength(1);
  });
});

describe('structured output with optional fields', () => {
  // OpenAI-strict json_schema requires `required` to list every key of
  // `properties`; an optional field is sent required + nullable instead,
  // and the model's `null` for it is read back as an absent key.
  type Node = { anyOf?: Node[]; type?: unknown; required?: string[]; properties?: Record<string, Node>; items?: Node };
  const sentSchema = (model: ReturnType<typeof mockModel>) => model.calls[0].responseFormat?.schema as Node;

  it('zod 4: lists every key in required and makes optional ones nullable (nested, in items, in union branches)', async () => {
    const output = z4.object({
      title: z4.string(),
      note: z4.string().optional(),
      score: z4.number().nullable(),
      geo: z4.object({ lat: z4.number(), label: z4.string().optional() }),
      hits: z4.array(z4.object({ id: z4.string(), line: z4.number().int().optional() })),
      choice: z4.union([z4.object({ a: z4.string().optional() }), z4.object({ b: z4.number() })]),
    });
    const model = mockModel(['{"title":"t","note":null,"score":null,"geo":{"lat":1,"label":null},"hits":[],"choice":{"b":1}}']);
    await createAgent({ provider: model, output }).send('go');

    const schema = sentSchema(model);
    expect(schema.required).toEqual(['title', 'note', 'score', 'geo', 'hits', 'choice']);
    expect(schema.properties?.note).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    // Already nullable: kept as is, not wrapped again.
    expect(JSON.stringify(schema.properties?.score)).not.toContain('"anyOf":[{"anyOf"');
    expect(schema.properties?.geo.required).toEqual(['lat', 'label']);
    expect(schema.properties?.geo.properties?.label).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(schema.properties?.hits.items?.required).toEqual(['id', 'line']);
    expect(schema.properties?.choice.anyOf?.map((b) => b.required)).toEqual([['a'], ['b']]);
  });

  it('zod 3: the same normalization on the ai converter path', async () => {
    const output = z.object({ a: z.string().optional(), b: z.number().nullable().optional(), n: z.object({ x: z.string().optional() }) });
    const model = mockModel(['{"a":null,"b":null,"n":{"x":null}}']);
    const result = await createAgent({ provider: model, output }).send('go');

    const schema = sentSchema(model);
    expect(schema.required).toEqual(['a', 'b', 'n']);
    expect(schema.properties?.a).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(schema.properties?.b).toEqual({ type: ['number', 'null'] });
    expect(schema.properties?.n.required).toEqual(['x']);
    // `b` accepts null itself, so its null is kept; `a` and `n.x` read back as absent.
    expect(result.object).toEqual({ b: null, n: {} });
    expect(result.object).not.toHaveProperty('a');
  });

  it('zod 4: a reply with null for optional keys validates, and the keys are absent in result.object', async () => {
    const output = z4.object({
      verdict: z4.enum(['approve', 'request_changes']),
      summary: z4.string().optional(),
      maybe: z4.string().nullish(),
      issues: z4.array(z4.object({ file: z4.string(), line: z4.number().int().optional() })),
      meta: z4.object({ by: z4.string().optional() }).optional(),
    });
    const reply = '{"verdict":"approve","summary":null,"maybe":null,"issues":[{"file":"a.ts","line":null},{"file":"b.ts","line":3}],"meta":{"by":null}}';
    const result = await createAgent({ provider: mockModel([reply]), output }).send('go');

    expect(result.outputError).toBeUndefined();
    expect(result.steps).toBe(1);
    expect(result.object).toEqual({ verdict: 'approve', maybe: null, issues: [{ file: 'a.ts' }, { file: 'b.ts', line: 3 }], meta: {} });
    expect(result.object).not.toHaveProperty('summary');
    expect((result.object as { issues: object[] }).issues[0]).not.toHaveProperty('line');
  });

  it('zod 4: null for an optional object is dropped too, and a recursive ($ref) schema is walked', async () => {
    type Tree = { name: string; children?: Tree[] };
    const tree: z4.ZodType<Tree> = z4.object({
      name: z4.string(),
      get children() {
        return z4.array(tree).optional();
      },
    });
    const model = mockModel(['{"name":"root","children":[{"name":"leaf","children":null}]}']);
    const result = await createAgent({ provider: model, output: tree }).send('go');

    expect(result.outputError).toBeUndefined();
    expect(result.object).toEqual({ name: 'root', children: [{ name: 'leaf' }] });
    expect(sentSchema(model).required).toEqual(['name', 'children']);
  });
});

describe('structured output near misses and repair', () => {
  const J = '{"city":"Paris","tempC":21}';

  it.each([
    ['trailing prose after a fenced block', '```json\n' + J + '\n```\nLet me know if you need more detail.'],
    ['a stray closing </think> tag', `Paris is {mild} today.</think>${J}`],
  ])('takes the JSON out of %s without a repair call', async (_name, reply) => {
    const model = mockModel([reply]);
    const result = await createAgent({ provider: model, output: weather }).send('Weather in Paris?');

    expect(model.calls).toHaveLength(1);
    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe(reply);
    expect(result.outputRepaired).toBeUndefined();
  });

  it('reports the issues of the extracted JSON when it does not validate', async () => {
    const model = mockModel(['Sure! {"city":"Paris","tempC":"warm"} hope that helps', J]);
    const result = await createAgent({ provider: model, output: weather }).send('go');

    expect(model.calls[1].messages.at(-1)?.content).toContain('tempC: Expected number, received string');
    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
  });

  it('detects a JSON Schema echo and answers it with an example instance, not the schema', async () => {
    const echo = '{"type":"object","properties":{"city":{"type":"string"},"tempC":{"type":"number"}},"required":["city","tempC"]}';
    const model = mockModel([echo, J]);
    const result = await createAgent({ provider: model, output: weather }).send('go');

    const repair = model.calls[1].messages.at(-1)?.content as string;
    expect(repair).toMatch(/^\[output-invalid\] Your reply is the JSON Schema itself\./);
    expect(repair).toContain('{"city":"<string>","tempC":0}');
    expect(repair).not.toContain('"properties"');
    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
  });

  for (const [zod, output] of [
    ['zod 3', z.object({ counts: z.record(z.string(), z.number()) })],
    ['zod 4', z4.object({ counts: z4.record(z4.string(), z4.number()) })],
  ] as const) {
    it(`${zod}: sends a record as a { key, value } array and decodes the reply back to a record`, async () => {
      const model = mockModel(['{"counts":[{"key":"a","value":2},{"key":"b","value":1}]}']);
      const result = await createAgent({ provider: model, output }).send('go');

      const counts = ((model.calls[0].responseFormat?.schema as Record<string, unknown>).properties as Record<string, unknown>).counts;
      expect(counts).toEqual({
        type: 'array',
        items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'number' } }, required: ['key', 'value'], additionalProperties: false },
      });
      expect(result.object).toEqual({ counts: { a: 2, b: 1 } });
    });
  }

  for (const [zod, output] of [
    ['zod 3', z.object({ point: z.tuple([z.number(), z.string()]) })],
    ['zod 4', z4.object({ point: z4.tuple([z4.number(), z4.string()]) })],
  ] as const) {
    it(`${zod}: sends a tuple as an object of _0.._n and decodes the reply back to an array`, async () => {
      const model = mockModel(['{"point":{"_0":1,"_1":"x"}}']);
      const result = await createAgent({ provider: model, output }).send('go');

      const point = ((model.calls[0].responseFormat?.schema as Record<string, unknown>).properties as Record<string, unknown>).point;
      expect(point).toEqual({
        type: 'object',
        properties: { _0: { type: 'number' }, _1: { type: 'string' } },
        required: ['_0', '_1'],
        additionalProperties: false,
      });
      expect(result.object).toEqual({ point: [1, 'x'] });
    });
  }

  it('rejects z.date() in an output schema at config time, naming the field', () => {
    const output = z4.object({ issued: z4.date(), lines: z4.array(z4.object({ due: z4.date().optional() })), ok: z4.coerce.date() });
    expect(() => createAgent({ provider: mockModel([]), output })).toThrow(
      "output: 'issued', 'lines[].due' are z.date(), which JSON cannot carry, so no reply could validate. Use z.iso.date()"
    );
  });
});

describe('structured output cut off by maxTokens', () => {
  it("skips the repair after a 'length' reply and reports outputError.kind 'truncated'", async () => {
    const model = mockModel([{ text: '{"city":"Par', finishReason: 'length' }, '{"city":"Paris","tempC":21}']);
    const agent = createAgent({ provider: model, output: weather, modelSettings: { maxTokens: 5 } });

    const result = await agent.send('Weather in Paris?');

    expect(model.calls).toHaveLength(1);
    expect(result.finishReason).toBe('output-invalid');
    expect(result.object).toBeUndefined();
    expect(result.outputError?.kind).toBe('truncated');
    expect(result.outputError?.message).toMatch(/cut off at the maxTokens limit/);
    expect(result.outputError?.message).toMatch(/raise modelSettings\.maxTokens/i);
  });
});
