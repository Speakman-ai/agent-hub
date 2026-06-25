import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Regression guards for PR #272 (security: bump 20 dependencies).
 *
 * The original bump hand-edited package-lock.json version strings without
 * re-resolving the dependency graph, which left every install broken:
 *   - server: langsmith was forced to 0.6.0 at the top level even though
 *     @langchain/core@0.3.80 declares `langsmith: ^0.3.67`, so `npm ci`
 *     failed with "Missing: langsmith@0.3.87 from lock file".
 *   - client: vite was bumped to ^8 while @vitejs/plugin-react@4.7.0 only
 *     supports vite peers through ^7, so `npm ci` failed with ERESOLVE.
 *
 * The fix forces langsmith to a patched line via a real `overrides` entry
 * (the npm-supported way to bump a transitive dep past a parent's declared
 * range) and keeps client vite inside the React plugin's peer range. These
 * tests assert the security-critical invariants so a future lockfile
 * regeneration cannot silently revert them and reintroduce the advisories
 * or the broken install.
 */

const here = dirname(fileURLToPath(import.meta.url));

function readJson(relPath: string): any {
  return JSON.parse(readFileSync(join(here, relPath), 'utf8'));
}

/** Compare two `MAJOR.MINOR.PATCH` strings; returns <0, 0, or >0. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe('dependency security guards (PR #272)', () => {
  // langsmith advisories cleared only at >=0.6.0:
  //   GHSA-v34v-rq6j-cj6p (SSRF)            fixed in 0.4.6
  //   GHSA-fw9q-39r9-c252 (proto pollution) fixed in 0.5.18
  //   GHSA-rr7j-v2q5-chgv (redaction)       fixed in 0.5.19
  //   GHSA-3644-q5cj-c5c7 (prompt pull)     fixed in 0.6.0
  const LANGSMITH_MIN = '0.6.0';

  it('pins a langsmith override that clears the high-severity advisories', () => {
    const pkg = readJson('./package.json');
    expect(pkg.overrides, 'server/package.json must keep the langsmith override').toBeDefined();
    expect(pkg.overrides.langsmith, 'langsmith override must be present').toBeTruthy();

    // The override range must start at or above the patched floor. Strip any
    // leading range operator (^, ~, >=) before comparing the base version.
    const base = String(pkg.overrides.langsmith).replace(/^[^\d]*/, '');
    expect(
      compareSemver(base, LANGSMITH_MIN) >= 0,
      `langsmith override "${pkg.overrides.langsmith}" must be >= ${LANGSMITH_MIN}`,
    ).toBe(true);
  });

  it('resolves every langsmith copy in the lockfile to a patched version', () => {
    const lock = readJson('./package-lock.json');
    const entries = Object.entries(lock.packages as Record<string, { version?: string }>).filter(
      ([name]) => name === 'node_modules/langsmith' || name.endsWith('/node_modules/langsmith'),
    );
    expect(entries.length, 'expected at least one resolved langsmith entry').toBeGreaterThan(0);
    for (const [name, meta] of entries) {
      expect(meta.version, `${name} must have a resolved version`).toBeDefined();
      expect(
        compareSemver(meta.version as string, LANGSMITH_MIN) >= 0,
        `${name}@${meta.version} must be >= ${LANGSMITH_MIN}`,
      ).toBe(true);
    }
  });

  it('keeps client vite within the @vitejs/plugin-react peer range', () => {
    const lock = readJson('../client/package-lock.json');
    const vite = lock.packages['node_modules/vite']?.version as string | undefined;
    const plugin = lock.packages['node_modules/@vitejs/plugin-react']?.version as
      | string
      | undefined;
    expect(vite, 'client root vite must be resolved').toBeDefined();
    expect(plugin, '@vitejs/plugin-react must be resolved').toBeDefined();

    // plugin-react 4.x supports vite peers ^4 || ^5 || ^6 || ^7. If the plugin
    // is still on 4.x, the root vite major must not exceed 7 or `npm ci` breaks
    // with ERESOLVE (the exact failure that blocked this PR).
    const pluginMajor = parseInt((plugin as string).split('.')[0], 10);
    const viteMajor = parseInt((vite as string).split('.')[0], 10);
    if (pluginMajor === 4) {
      expect(
        viteMajor <= 7,
        `vite@${vite} exceeds @vitejs/plugin-react@${plugin} peer range (<=7)`,
      ).toBe(true);
    }
  });
});
