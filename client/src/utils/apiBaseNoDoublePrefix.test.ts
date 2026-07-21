import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// getApiBase() already returns a base ending in `/api` (see utils/connection.ts).
// Appending another `/api/...` yields `/api/api/...`, which 404s and floods the
// console during preview teardown. Guard the whole client tree against it.
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Matches `${getApiBase()}/api/...` — the doubled-prefix bug regardless of whitespace.
const DOUBLE_PREFIX = /getApiBase\(\)\s*\}\s*\/api\//;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry) && !/\.test\.(ts|tsx|js|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('getApiBase() call sites', () => {
  it('never double-prefix `/api` (getApiBase already ends in /api)', () => {
    const offenders = collectSourceFiles(srcRoot).filter((file) =>
      DOUBLE_PREFIX.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
