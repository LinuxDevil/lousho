import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalRoot, workspaceSlug } from '../workspaceId';

describe('workspaceSlug', () => {

  it("returns 'workspace' for a name with no slug content", () => {
    expect(workspaceSlug('')).toBe('workspace');
    expect(workspaceSlug('!!!')).toBe('workspace');
  });
});

describe('workspaceIdFor / workspaceRefFor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w00-wsid-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('canonicalRoot returns an absolute path for a folder that does not exist', () => {
    expect(canonicalRoot(path.join(tmp, 'missing'))).toBe(path.resolve(tmp, 'missing'));
  });
});
