// @ts-nocheck
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const utilsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(utilsDir, '..', '..', '..');
describe('root test:mobile script', () => {
  it('delegates to scripts/run-mobile-tests.mjs so deps can be bootstrapped', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:mobile']).toBe('node scripts/run-mobile-tests.mjs');
  });
});
