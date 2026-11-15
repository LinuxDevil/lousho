/**
 * `tools` accepts a record (the `connectMcp().tools` shape), an array
 * of named tools (`defineTool()` / `openApiTools()` / `createFsTools()`), and
 * arrays mixing tools and records.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from './defineTool';
import { toolEntries } from './toolEntries';

const weather = () =>
  defineTool({
    name: 'weather',
    description: 'Weather of a city',
    input: z.object({ city: z.string() }),
    execute: async ({ city }) => `sunny in ${city}`,
  });

describe('toolEntries', () => {

  it('rejects a duplicate name across an array and a record', () => {
    expect(() => toolEntries([weather(), { weather: weather() }], 'test')).toThrow(/two entries.*'weather'/);
  });

  it('rejects an array entry that is neither tool nor record', () => {
    expect(() => toolEntries(['weather' as never], 'test')).toThrow(/must be a tool or a record of tools/);
    expect(() => toolEntries([[weather()] as never], 'test')).toThrow(/must be a tool or a record of tools/);
  });
});
