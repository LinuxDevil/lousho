import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertStudioBundleFresh } from './studioFreshness';

let dir: string;

function touch(rel: string, seconds: number): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const time = new Date(Date.now() + seconds * 1000);
  fs.utimesSync(file, time, time);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fresh-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('assertStudioBundleFresh', () => {
  it('passes when the bundle is newer than every source', () => {
    touch('server/a.ts', -100);
    touch('src/b.tsx', -50);
    touch('shared/c.ts', -60);
    touch('dist-server/cli.cjs', 0);
    expect(() => assertStudioBundleFresh(dir)).not.toThrow();
  });

  it('fails naming the newest source newer than the bundle', () => {
    touch('server/a.ts', -100);
    touch('src/old.tsx', 10);
    touch('src/deep/new.tsx', 20);
    touch('dist-server/cli.cjs', 0);
    expect(() => assertStudioBundleFresh(dir)).toThrow(/src\/deep\/new\.tsx.*npm run build:studio/);
  });

  it('ignores tests, node_modules and dist folders', () => {
    touch('server/a.ts', -100);
    touch('server/a.test.ts', 50);
    touch('src/node_modules/x/index.js', 50);
    touch('src/dist-widget/w.js', 50);
    touch('dist-server/cli.cjs', 0);
    expect(() => assertStudioBundleFresh(dir)).not.toThrow();
  });
});
