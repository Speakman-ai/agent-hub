import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { satisfies } from 'semver';

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

/** Every workspace lockfile, paired with the manifest whose `overrides` govern it. */
const LOCKFILES = [
  { name: 'root', lock: '../package-lock.json', manifest: '../package.json' },
  { name: 'server', lock: './package-lock.json', manifest: './package.json' },
  { name: 'client', lock: '../client/package-lock.json', manifest: '../client/package.json' },
  { name: 'mobile', lock: '../mobile/package-lock.json', manifest: '../mobile/package.json' },
  { name: 'shared', lock: '../shared/package-lock.json', manifest: '../shared/package.json' },
] as const;

interface LockEntry {
  version?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function lockPackages(relPath: string): Record<string, LockEntry> {
  return (readJson(relPath).packages ?? {}) as Record<string, LockEntry>;
}

/** The bare package name for a lock key, e.g. `a/node_modules/b` -> `b`. */
function packageNameOf(lockKey: string): string {
  const i = lockKey.lastIndexOf('node_modules/');
  return i === -1 ? '' : lockKey.slice(i + 'node_modules/'.length);
}

describe('dependency security guards (high-severity advisory floors)', () => {
  /**
   * Advisory floors cleared by the 22-finding audit fix. `line` narrows the
   * assertion to a single major when older majors are legitimately still in
   * the tree (see the brace-expansion note below).
   */
  const FLOORS: Array<{
    pkg: string;
    min: string;
    advisory: string;
    line?: string;
    only?: ReadonlyArray<(typeof LOCKFILES)[number]['name']>;
  }> = [
    // GHSA-6g55-p6wh-862q (8.5.12) + GHSA-r28c-9q8g-f849 (8.5.18): sourceMappingURL
    // path traversal / arbitrary .map file disclosure.
    { pkg: 'postcss', min: '8.5.18', advisory: 'GHSA-r28c-9q8g-f849' },
    // GHSA-4c8g-83qw-93j6 (3.1.3) + GHSA-v2hh-gcrm-f6hx (3.1.4): host confusion.
    { pkg: 'fast-uri', min: '3.1.4', advisory: 'GHSA-v2hh-gcrm-f6hx' },
    // GHSA-v245-v573-v5vm: quadratic-complexity DoS in the `mailto:` validator.
    { pkg: 'linkify-it', min: '5.0.2', advisory: 'GHSA-v245-v573-v5vm' },
    // GHSA-7g7r-gx96-252g: uncontrolled AppImage search path.
    { pkg: 'app-builder-lib', min: '26.15.0', advisory: 'GHSA-7g7r-gx96-252g' },
    // GHSA-p2f4-r6v6-j797: cross-origin redirect leaks Authorization credentials.
    { pkg: 'builder-util-runtime', min: '9.7.0', advisory: 'GHSA-p2f4-r6v6-j797' },
    // GHSA-mh99-v99m-4gvg: unbounded expansion OOM. Patched only on the 5.x
    // line, and brace-expansion@3 dropped the callable CJS/default export that
    // minimatch 3/5/9 rely on -- so the 1.x and 2.x copies under those parents
    // cannot be forced to 5.x without breaking them at runtime. Guard the 5.x
    // line only; the older copies are assessed, not fixed.
    { pkg: 'brace-expansion', min: '5.0.8', advisory: 'GHSA-mh99-v99m-4gvg', line: '5.x' },

    // --- 33-finding audit (electron / uuid / qs / protobufjs / hono / ...) ---

    // GHSA-4p4r-m79c-wq3v (39.8.3) response-header injection, GHSA-xwr5-m59h-vwqr
    // (39.8.4) nodeIntegrationInWorker scoping, GHSA-f3pv-wv63-48x8 +
    // GHSA-f37v-82c4-4x64 + GHSA-8x5q-pvf5-64mp (39.8.5). 39.8.5 clears all five.
    { pkg: 'electron', min: '39.8.5', advisory: 'GHSA-f3pv-wv63-48x8' },
    // GHSA-w5hq-g745-h8pq: missing buffer bounds check in v3/v5/v6. Patched only
    // on the 11.x line, so mobile's xcode@3 (uuid ^7) and server's
    // @langchain/core (uuid ^10) both need the `uuid` override to reach it.
    { pkg: 'uuid', min: '11.1.1', advisory: 'GHSA-w5hq-g745-h8pq' },
    // GHSA-q8mj-m7cp-5q26: qs.stringify TypeError crash on null entries in
    // comma-format arrays. Reached in-range once express@4 moved to `qs ~6.15.1`.
    { pkg: 'qs', min: '6.15.2', advisory: 'GHSA-q8mj-m7cp-5q26' },
    // GHSA-f38q-mgvj-vph7 (7.6.3) property shadowing + GHSA-j3f2-48v5-ccww
    // (7.6.5) infinite loop in .proto option parsing.
    { pkg: 'protobufjs', min: '7.6.5', advisory: 'GHSA-j3f2-48v5-ccww' },
    // GHSA-q6x5-8v7m-xcrf: overlong UTF-8 decoding.
    { pkg: '@protobufjs/utf8', min: '1.1.1', advisory: 'GHSA-q6x5-8v7m-xcrf' },
    // GHSA-hvrm-45r6-mjfj (cross-request JSX context leak), GHSA-w62v-xxxg-mg59
    // (cx() escaping bypass), GHSA-xgm2-5f3f-mvvc (header de-dup drop).
    { pkg: 'hono', min: '4.12.27', advisory: 'GHSA-hvrm-45r6-mjfj' },
    // GHSA-frvp-7c67-39w9: serve-static path traversal via encoded backslash.
    // Backported to the 1.x line at 1.19.15, which stays inside
    // @modelcontextprotocol/sdk's `^1.19.9` range -- no override needed.
    { pkg: '@hono/node-server', min: '1.19.15', advisory: 'GHSA-frvp-7c67-39w9' },
    // GHSA-r4q5-vmmm-2653: Authorization header leaked across a cross-domain redirect.
    { pkg: 'follow-redirects', min: '1.16.0', advisory: 'GHSA-r4q5-vmmm-2653' },
    // GHSA-v2v4-37r5-5v8g: XSS in the Address6 HTML-emitting methods.
    { pkg: 'ip-address', min: '10.1.1', advisory: 'GHSA-v2v4-37r5-5v8g' },
    // GHSA-v422-hmwv-36x6: an invalid `limit` silently disables size enforcement.
    // Patched separately on each supported line, and both lines are live here
    // (express@4 pulls 1.x, express@5 under @slack/bolt + MCP SDK pulls 2.x).
    { pkg: 'body-parser', min: '1.20.6', advisory: 'GHSA-v422-hmwv-36x6', line: '1.x' },
    { pkg: 'body-parser', min: '2.3.0', advisory: 'GHSA-v422-hmwv-36x6', line: '2.x' },
    // GHSA-r292-9mhp-454m: uncatchable stack-overflow DoS via a crafted long-path tar.
    { pkg: 'tar', min: '7.5.21', advisory: 'GHSA-r292-9mhp-454m' },
    // GHSA-c2j3-45gr-mqc4: CUSTOM_ELEMENT_HANDLING bypasses afterSanitizeElements.
    { pkg: 'dompurify', min: '3.4.12', advisory: 'GHSA-c2j3-45gr-mqc4' },
    // GHSA-4x5r-pxfx-6jf8: arbitrary file read via a sourceMappingURL comment.
    { pkg: '@babel/core', min: '7.29.6', advisory: 'GHSA-4x5r-pxfx-6jf8' },
    // GHSA-6vfc-qv3f-vr6c (12.3.2) + GHSA-6v5v-wf23-fmfq (>14.1.1, i.e. 14.2.0).
    // react-native-markdown-display@7 declares `markdown-it ^10.0.0` and has no
    // newer release, so mobile forces 14.x via an override. The renderer's call
    // surface is guarded by mobile/src/utils/markdownItRendererContract.test.ts.
    { pkg: 'markdown-it', min: '14.2.0', advisory: 'GHSA-6v5v-wf23-fmfq' },
    // GHSA-g7r4-m6w7-qqqr: arbitrary file read from the Windows dev server.
    // Scoped to `server`: the advisory covers the 0.27.x line that tsx pulled in,
    // and client's esbuild@0.25 (via vite@6) is outside the affected range.
    { pkg: 'esbuild', min: '0.28.1', advisory: 'GHSA-g7r4-m6w7-qqqr', only: ['server'] },
  ];

  for (const { pkg, min, advisory, line, only } of FLOORS) {
    it(`resolves every ${line ? `${line} ` : ''}${pkg} copy at or above ${min} (${advisory})`, () => {
      let checked = 0;
      for (const { name, lock } of LOCKFILES) {
        if (only && !only.includes(name)) continue;
        for (const [key, meta] of Object.entries(lockPackages(lock))) {
          if (packageNameOf(key) !== pkg || !meta.version) continue;
          if (line && !satisfies(meta.version, line)) continue;
          checked++;
          expect(
            compareSemver(meta.version, min) >= 0,
            `${name}: ${key}@${meta.version} is below the ${advisory} floor ${min}`,
          ).toBe(true);
        }
      }
      expect(checked, `expected at least one ${pkg} entry across the lockfiles`).toBeGreaterThan(0);
    });
  }
});

/**
 * Structural guard against the hand-edited-lockfile failure mode.
 *
 * The audit fix uncovered a lock entry that a previous automated bump had
 * edited in place: `mobile` recorded
 * `node_modules/markdown-it/node_modules/linkify-it` at version 5.0.1 (with
 * 5.0.1's tarball + integrity) while markdown-it@10 declares `linkify-it:
 * ^2.0.0`, and the entry still carried linkify-it 2.x's dependency block
 * (`uc.micro: ^1.0.1`, where real 5.0.1 needs `^2.0.0`). The version string had
 * been rewritten without re-resolving the graph, so the lockfile no longer
 * described an installable tree.
 *
 * A resolved version may legitimately fall outside a parent's declared range,
 * but only when an `overrides` entry deliberately forces it. Anything else is
 * drift, and that is exactly what this asserts.
 */
describe('lockfile coherence (no hand-edited version strings)', () => {
  /**
   * npm's nearest-ancestor resolution: a dependency of the package at
   * `fromKey` resolves to `<fromKey>/node_modules/<dep>` if present, otherwise
   * we walk up the nesting chain to the lockfile root.
   */
  function resolveDependency(
    packages: Record<string, LockEntry>,
    fromKey: string,
    dep: string,
  ): string | null {
    let prefix = fromKey;
    for (;;) {
      const candidate = `${prefix ? `${prefix}/` : ''}node_modules/${dep}`;
      if (packages[candidate]) return candidate;
      if (!prefix) return null;
      const i = prefix.lastIndexOf('/node_modules/');
      prefix = i === -1 ? '' : prefix.slice(0, i);
    }
  }

  /** Top-level `overrides` keys, with any `name@range` suffix stripped. */
  function overriddenPackages(manifestPath: string): Set<string> {
    const overrides = (readJson(manifestPath).overrides ?? {}) as Record<string, unknown>;
    return new Set(
      Object.keys(overrides).map((key) => {
        const at = key.lastIndexOf('@');
        return at > 0 ? key.slice(0, at) : key;
      }),
    );
  }

  for (const { name, lock, manifest } of LOCKFILES) {
    it(`${name}: every resolved version satisfies its parent's range or is overridden`, () => {
      const packages = lockPackages(lock);
      const overridden = overriddenPackages(manifest);
      const violations: string[] = [];

      for (const [key, entry] of Object.entries(packages)) {
        if (entry.link) continue;
        const declared = { ...entry.dependencies, ...entry.optionalDependencies };
        for (const [dep, range] of Object.entries(declared)) {
          // Aliases and non-registry specifiers carry no comparable range.
          if (/^(npm:|file:|link:|git|https?:)/.test(range)) continue;
          if (overridden.has(dep)) continue;
          const target = resolveDependency(packages, key, dep);
          const version = target ? packages[target]?.version : undefined;
          if (!version) continue;
          if (!satisfies(version, range)) {
            violations.push(`${key || '(root)'} wants ${dep}@${range} but resolved ${version}`);
          }
        }
      }

      expect(violations, `${name}/package-lock.json is incoherent`).toEqual([]);
    });
  }
});
