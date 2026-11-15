
import { describe, expect, it } from 'vitest';
import { isZod4Schema } from '../../utils/zodCompat';
import { workspaceManifestObjectSchema } from '../contracts/workspace';
import { NOT_EXPRESSIBLE, committedWorkspaceSchemas, renderWorkspaceSchemas, schemaFileOf, validatorFor } from '../../../scripts/workspacesSchema';
import { readFixtureTree, readNegativeIndex, readNegativeTree } from '../__fixtures__/readTree';
import { validateWorkspace } from '../contracts/validate';

const POSITIVE = ['marketing', 'ops-desk', 'coding'];

describe('G0 contract gate', () => {
  it.each(POSITIVE)('positive fixture %s validates with zero problems', (name) => {
    expect(validateWorkspace(readFixtureTree(name), { mode: 'default' })).toEqual([]);
  });

  it.skipIf(isZod4Schema(workspaceManifestObjectSchema))('the committed schemas/*.v1.json equal the zod-generated schemas', () => {
    const rendered = renderWorkspaceSchemas();
    const committed = committedWorkspaceSchemas();
    expect(Object.keys(committed)).toEqual(Object.keys(rendered).sort());
    for (const [file, content] of Object.entries(rendered)) expect(committed[file], file).toBe(content);
  });

  it('the committed JSON Schemas agree with zod on every fixture file', () => {
    for (const name of POSITIVE) {
      for (const [filePath, value] of Object.entries(readFixtureTree(name))) {
        const file = schemaFileOf(filePath);
        if (file !== undefined) expect(validatorFor(file)(value), `${name}/${filePath}`).toBe(true);
      }
    }
    const schemaCases = readNegativeIndex().cases.filter((item) => item.checkedBy === 'schema' && !NOT_EXPRESSIBLE.includes(item.name));
    expect(schemaCases.length).toBeGreaterThan(0);
    for (const item of schemaCases) {
      const file = schemaFileOf(item.file);
      if (file === undefined) continue;
      expect(validatorFor(file)(readNegativeTree(item.name)[item.file]), item.name).toBe(false);
    }
  });
});
