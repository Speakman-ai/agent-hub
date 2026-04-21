import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('.husky/pre-commit — GUI / Electron PATH bootstrap', () => {
  it('exports PATH with repo node_modules/.bin and common Node locations before lint-staged', () => {
    const script = readFileSync(path.join(repoRoot, '.husky', 'pre-commit'), 'utf-8');
    expect(script).toContain('ROOT="$(cd "$(dirname "$0")/.." && pwd)"');
    expect(script).toContain('node_modules/.bin');
    expect(script).toContain('/opt/homebrew/bin');
    expect(script).toContain('node_modules/.bin/eslint');
    expect(script).toContain('exec npx --no-install lint-staged');
  });
});

describe('.npmrc — devDependencies for hooks', () => {
  it('includes dev so eslint/husky install with npm install', () => {
    const rc = readFileSync(path.join(repoRoot, '.npmrc'), 'utf-8');
    expect(rc).toMatch(/include\s*=\s*dev/);
  });
});
