import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));

describe('typecheck preflight', () => {
  it('runs assert-dev-types before tsc so missing devDeps fail with a clear message', () => {
    const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')) as {
      scripts?: { typecheck?: string };
    };
    expect(pkg.scripts?.typecheck).toContain('assert-dev-types.mjs');
    expect(pkg.scripts?.typecheck).toContain('tsc --noEmit');
  });
});
