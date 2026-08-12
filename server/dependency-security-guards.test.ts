import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { major, minVersion, satisfies, subset } from 'semver';

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
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function lockPackages(relPath: string): Record<string, LockEntry> {
  return (readJson(relPath).packages ?? {}) as Record<string, LockEntry>;
}

/** The bare package name for a lock key, e.g. `a/node_modules/b` -> `b`. */
function packageNameOf(lockKey: string): string {
  const i = lockKey.lastIndexOf('node_modules/');
  return i === -1 ? '' : lockKey.slice(i + 'node_modules/'.length);
}

/**
 * npm's nearest-ancestor resolution: a dependency of the package at `fromKey`
 * resolves to `<fromKey>/node_modules/<dep>` if present, otherwise we walk up
 * the nesting chain to the lockfile root.
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

/** Specifiers that carry no comparable semver range. */
const NON_REGISTRY_SPEC = /^(npm:|file:|link:|git|https?:)/;

describe('dependency security guards (high-severity advisory floors)', () => {
  /**
   * Advisory floors cleared by the 22-finding audit fix. `line` narrows the
   * assertion to a single major when older majors are legitimately still in
   * the tree (see the brace-expansion note below).
   */
  const FLOORS: Array<{
    pkg: string;
    min: string;
    /**
     * Every advisory this floor enforces. When several advisories share one
     * patched version a single assertion covers them all, but they are still
     * listed individually so the test name and the failure message name each
     * one -- otherwise a failure points at one GHSA and silently drops the
     * others, leaving no trail back to what the floor is actually holding.
     */
    advisory: string | readonly string[];
    line?: string;
    only?: ReadonlyArray<(typeof LOCKFILES)[number]['name']>;
  }> = [
    // GHSA-6g55-p6wh-862q (8.5.12) + GHSA-r28c-9q8g-f849 (8.5.18): sourceMappingURL
    // path traversal / arbitrary .map file disclosure.
    { pkg: 'postcss', min: '8.5.18', advisory: 'GHSA-r28c-9q8g-f849' },
    // GHSA-4c8g-83qw-93j6 (3.1.3) + GHSA-v2hh-gcrm-f6hx (3.1.4) +
    // GHSA-7p8r-x3mc-p8w7 (3.1.5): host confusion, most recently via a
    // backslash authority introducer. Every copy sits under `ajv`'s
    // `fast-uri: ^3.0.1`, so each patch re-resolves in range with no override.
    { pkg: 'fast-uri', min: '3.1.5', advisory: 'GHSA-7p8r-x3mc-p8w7' },
    // GHSA-v245-v573-v5vm: quadratic-complexity DoS in the `mailto:` validator.
    { pkg: 'linkify-it', min: '5.0.2', advisory: 'GHSA-v245-v573-v5vm' },
    // GHSA-7g7r-gx96-252g: uncontrolled AppImage search path.
    { pkg: 'app-builder-lib', min: '26.15.0', advisory: 'GHSA-7g7r-gx96-252g' },
    // GHSA-p2f4-r6v6-j797: cross-origin redirect leaks Authorization credentials.
    { pkg: 'builder-util-runtime', min: '9.7.0', advisory: 'GHSA-p2f4-r6v6-j797' },
    // GHSA-mh99-v99m-4gvg: unbounded expansion OOM. brace-expansion@3 dropped
    // the callable CJS/default export that minimatch 3/5/9 rely on, so the 1.x
    // and 2.x copies under those parents can never be forced onto the 5.x line
    // without breaking them at runtime (see the callability assertion below).
    // The fix instead rides the maintenance backports -- 1.1.18 and 2.1.4 both
    // carry the EXPANSION_MAX_LENGTH cap and both sit inside every declared
    // parent range (^1.1.7, ^2.0.1, ^2.0.2), so no override or parent bump is
    // needed. Each live line gets its own floor.
    //
    // The registry advisory still records the vulnerable range as `<=5.0.7`,
    // which predates the backports, so `npm audit` keeps reporting the 1.x/2.x
    // copies. That is stale advisory metadata, not an unpatched dependency --
    // the behavioural guard further down asserts the installed code is bounded.
    //
    // GHSA-rgw5-rvv9-x895 is the follow-up: the length cap above only measured
    // the *combined output*, so a pattern could still drive an unbounded
    // intermediate array before the cap ever applied. Its patched set is
    // (<1.1.18, <2.1.4, <3.0.6, <5.0.9), which the 1.x and 2.x backports
    // already satisfy at the versions pinned here -- only the 5.x floor moved.
    { pkg: 'brace-expansion', min: '1.1.18', advisory: 'GHSA-rgw5-rvv9-x895', line: '1.x' },
    { pkg: 'brace-expansion', min: '2.1.4', advisory: 'GHSA-rgw5-rvv9-x895', line: '2.x' },
    { pkg: 'brace-expansion', min: '5.0.9', advisory: 'GHSA-rgw5-rvv9-x895', line: '5.x' },

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
    // (cx() escaping bypass), GHSA-xgm2-5f3f-mvvc (header de-dup drop), and
    // GHSA-8j4g-w8fx-2239 (4.12.34) quadratic backtracking in the hono/cors
    // preflight parser. The last one is behaviour-preserving on outputs, so it
    // gets the CPU-footprint guard further down as well as this floor.
    { pkg: 'hono', min: '4.12.34', advisory: 'GHSA-8j4g-w8fx-2239' },
    // GHSA-frvp-7c67-39w9: serve-static path traversal via encoded backslash.
    // The advisory covers `< 2.0.5` with no backport, so the whole 1.x line is
    // affected. Its sole consumer, @modelcontextprotocol/sdk, declares
    // `^1.19.9` even at its newest release, so 2.x is reachable only through
    // the server `@hono/node-server` override asserted below.
    { pkg: '@hono/node-server', min: '2.0.5', advisory: 'GHSA-frvp-7c67-39w9' },
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
    // GHSA-c2j3-45gr-mqc4 (3.4.12): CUSTOM_ELEMENT_HANDLING bypasses
    // afterSanitizeElements. GHSA-55q2-fjhq-7xh7 (3.4.13) supersedes it: on the
    // IN_PLACE path a node detached by an uponSanitizeElement/beforeSanitizeElements
    // hook -- the documented `node.remove()` pattern -- was left un-neutralized,
    // so a queued resource handler on the detached subtree (`<img onerror>`,
    // `<video>` error, lazy `onload`, ...) still fired in page scope after
    // sanitize returned. 3.4.13 neutralizes the detached subtree inline. The
    // floor names the stricter constraint; the behavioural guard further down
    // asserts the installed code actually strips those handlers.
    { pkg: 'dompurify', min: '3.4.13', advisory: 'GHSA-55q2-fjhq-7xh7' },
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

    // --- 17-finding audit (fast-uri / undici / hono) ---

    // Five advisories against undici, patched across both live lines:
    //   GHSA-m8rv-5g2x-5cg5  CRLF injection via a blob-like body `type`
    //   GHSA-v3r7-h72x-cjcm  cookie attribute injection via unsanitized domain
    //   GHSA-8xcm-r25x-g524  response desync via the retry interceptor
    //   GHSA-4cwx-7wf7-3272  cross-user disclosure + parse crash on degenerate
    //                        private cache directives          (7.x/8.x only)
    //   GHSA-jr45-8vmc-qm54  cross-user disclosure via whitespace around `=`
    //                        in Cache-Control directives        (7.x/8.x only)
    // The first three are patched on both 6.28.0 and 7.29.0; the last two never
    // affected the 6.x line. Both lines stay in the tree on purpose -- root's
    // node-gyp declares `^6.25.0` and mobile's @expo/cli `^6.18.2`, while jsdom
    // (root + client) declares `^7.24.5`. Every patched version sits inside its
    // parent's range, so this is a plain re-resolve with no override.
    { pkg: 'undici', min: '6.28.0', advisory: 'GHSA-8xcm-r25x-g524', line: '6.x' },
    { pkg: 'undici', min: '7.29.0', advisory: 'GHSA-4cwx-7wf7-3272', line: '7.x' },

    // --- 10-finding audit (js-yaml / mermaid) ---

    // GHSA-5p4m-2wfm-xmqj (CVE-2026-59870): quadratic CPU consumption resolving
    // `!!omap`. The advisory patches each live line separately -- `>=3.0.0
    // <3.15.1` and `>=4.0.0 <4.3.1` -- because the 4.x fix was not backported,
    // so neither floor covers the other and both lines are in the tree. Every
    // declared parent range already admits its patched version (@eslint/eslintrc
    // and electron-builder want `^4.1.x`, gray-matter and
    // @istanbuljs/load-nyc-config want `^3.13.1`), so this is a plain
    // re-resolve with no override. Re-resolving also hoisted mobile's 4.x copy
    // out of @expo/xcpretty to the root, which the coherence check below
    // validates.
    { pkg: 'js-yaml', min: '3.15.1', advisory: 'GHSA-5p4m-2wfm-xmqj', line: '3.x' },
    { pkg: 'js-yaml', min: '4.3.1', advisory: 'GHSA-5p4m-2wfm-xmqj', line: '4.x' },
    // Five advisories against mermaid:
    //   GHSA-2v8p-3f2j-5mp7  infinite-loop DoS in XY charts
    //   GHSA-6x64-9x62-f2gx  CSS injection reaching the diagram's siblings
    //   GHSA-3rrr-jr9j-h3q3  prototype pollution in architecture diagrams
    //   GHSA-rhh3-jpg6-66xh  DoS in radar diagrams
    //   GHSA-c4c3-pg64-4m4v  prototype pollution via the configuration APIs
    // All five report the same `first_patched_version` on the 11.x line, so one
    // floor at 11.16.1 enforces every one of them -- any downgrade that
    // reintroduces any single advisory drops below 11.16.1 and fails here. They
    // are enumerated rather than collapsed to a representative ID so a failure
    // names the full set instead of stranding the other four.
    // (Three of them also have a 10.9.8 fix on the 10.x line, which is
    // unreachable here: client declares `mermaid: ^11.14.0`.)
    // Scoped to `client` -- it is the only surface that renders diagrams.
    {
      pkg: 'mermaid',
      min: '11.16.1',
      advisory: [
        'GHSA-2v8p-3f2j-5mp7',
        'GHSA-6x64-9x62-f2gx',
        'GHSA-3rrr-jr9j-h3q3',
        'GHSA-rhh3-jpg6-66xh',
        'GHSA-c4c3-pg64-4m4v',
      ],
      only: ['client'],
    },

    // --- 8-finding audit (nanoid / image-size / @ai-sdk/provider-utils) ---

    // GHSA-2v37-7h3g-55p8: a custom generator called with size 0 never
    // terminates. The sync generator appends a character and then tests
    // `id.length === size`, so the equality can never hold and the `while
    // (true)` loop spins forever on a live thread. Present in every workspace
    // via postcss (`nanoid: ^3.3.16`), and in mobile additionally via
    // @react-navigation (`^3.3.11`); every declared range already admits the
    // patch, so this is a plain re-resolve with no override.
    //
    // The floor names 3.3.17, the version the advisory patches. The lockfiles
    // actually resolved to 3.3.18, which additionally guards
    // `async/index.native.js` -- Metro reaches that file by platform extension
    // on mobile, and 3.3.17 left it returning a one-character id for size 0.
    // That is a correctness bug, not the DoS, so it does not raise the floor.
    { pkg: 'nanoid', min: '3.3.17', advisory: 'GHSA-2v37-7h3g-55p8', line: '3.x' },
  ];

  for (const { pkg, min, advisory, line, only } of FLOORS) {
    const advisories = typeof advisory === 'string' ? [advisory] : advisory;
    const label = advisories.join(', ');
    it(`resolves every ${line ? `${line} ` : ''}${pkg} copy at or above ${min} (${label})`, () => {
      let checked = 0;
      for (const { name, lock } of LOCKFILES) {
        if (only && !only.includes(name)) continue;
        for (const [key, meta] of Object.entries(lockPackages(lock))) {
          if (packageNameOf(key) !== pkg || !meta.version) continue;
          if (line && !satisfies(meta.version, line)) continue;
          checked++;
          expect(
            compareSemver(meta.version, min) >= 0,
            `${name}: ${key}@${meta.version} is below the ${min} floor shared by ${advisories.length > 1 ? `${advisories.length} advisories: ` : ''}${label}`,
          ).toBe(true);
        }
      }
      expect(checked, `expected at least one ${pkg} entry across the lockfiles`).toBeGreaterThan(0);
    });
  }
});

/**
 * Behavioural guard for GHSA-mh99-v99m-4gvg (CVE-2026-14257), the one advisory
 * whose fix a version floor alone cannot express honestly.
 *
 * Two things have to hold at once and they pull in opposite directions:
 *
 *   1. Every resolved copy must actually bound expansion output. The bug is a
 *      pattern of chained brace groups whose *combined length* explodes while
 *      the result count stays under the pre-existing `EXPANSION_MAX` cap:
 *      `({a*20000,b*20000}) x 8` is an 0.8 MB pattern that expands to 41 MB on
 *      1.1.16 / 2.1.2 and is capped at 4 MB on 1.1.18 / 2.1.4 / 5.0.8. The
 *      registry advisory range (`<=5.0.7`) predates the 1.x/2.x backports and
 *      still flags them, so npm audit cannot settle this -- running the code
 *      can.
 *   2. Copies on the 1.x and 2.x lines must stay callable as a bare CJS export.
 *      minimatch 3/5/9 do `require('brace-expansion')(pattern)`, while 3.x
 *      onwards exports `{ expand }`. Forcing those copies to 5.x to satisfy the
 *      stale advisory range is the obvious "fix" and it breaks every glob in
 *      the tree at runtime with `expand is not a function`.
 *   3. Every resolved copy must also bound the *intermediate* arrays it builds
 *      on the way to that output (GHSA-rgw5-rvv9-x895). 5.0.8 concatenated each
 *      comma part's full sub-expansion into one array and only capped the
 *      result afterwards, so a 3.6 KB pattern could allocate hundreds of MB
 *      while returning a perfectly legal 1.8 MB. Output assertions cannot see
 *      that -- 5.0.8 and 5.0.9 return byte-identical results for it -- so the
 *      guard measures the footprint instead.
 *
 * Asserts only on copies whose on-disk version matches what the lockfile
 * resolved. A missing `node_modules` is a legitimate local state, and a *stale*
 * one is install drift rather than a lockfile defect -- this repo's own mobile
 * tree carries copies several patches behind its lock. Either way the lockfile
 * floors above are the authority on what ships; this block proves the code those
 * versions actually contain is bounded.
 */
describe('brace-expansion bounds expansion (GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895)', () => {
  const require_ = createRequire(import.meta.url);

  /** 0.8 MB of chained two-option groups: 256 results x 160 KB when unbounded. */
  const LENGTH_BOMB = `{${'a'.repeat(20000)},${'b'.repeat(20000)}}`.repeat(8);
  const UNBOUNDED_CHARS = 40_960_000;
  /** Patched lines cap at EXPANSION_MAX_LENGTH (4 MB); leave headroom for a re-tune. */
  const MAX_CHARS = 6_000_000;

  /**
   * Every `brace-expansion` copy that is installed at the version its lockfile
   * resolved. A version mismatch means the tree predates the lock, so the code
   * on disk says nothing about what a fresh `npm ci` would install.
   */
  function copiesMatchingLock(): Array<{
    workspace: string;
    key: string;
    dir: string;
    version: string;
  }> {
    const found: Array<{ workspace: string; key: string; dir: string; version: string }> = [];
    for (const { name, lock } of LOCKFILES) {
      const root = dirname(join(here, lock));
      for (const [key, meta] of Object.entries(lockPackages(lock))) {
        if (packageNameOf(key) !== 'brace-expansion' || !meta.version) continue;
        const manifest = join(root, key, 'package.json');
        if (!existsSync(manifest)) continue;
        const installed = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string })
          .version;
        if (installed !== meta.version) continue;
        found.push({ workspace: name, key, dir: join(root, key), version: meta.version });
      }
    }
    return found;
  }

  /**
   * The callability invariant, asserted from the lockfile so it holds even when
   * nothing is installed and even if someone adds an `overrides` entry (which
   * would make the coherence check further down skip brace-expansion entirely).
   *
   * A consumer whose declared range admits a pre-3.x version calls the module
   * object directly. Resolving it onto 3.x+ swaps that for a named `expand`
   * export and every glob in the tree throws `expand is not a function`.
   */
  it('never resolves a pre-3.x consumer onto the named-export line', () => {
    const violations: string[] = [];
    let checked = 0;
    for (const { name, lock } of LOCKFILES) {
      const packages = lockPackages(lock);
      for (const [key, entry] of Object.entries(packages)) {
        const range = entry.dependencies?.['brace-expansion'];
        if (!range || NON_REGISTRY_SPEC.test(range)) continue;
        const floor = minVersion(range);
        if (!floor || major(floor.version) >= 3) continue; // consumer already on the named export
        checked++;
        const target = resolveDependency(packages, key, 'brace-expansion');
        const version = target ? packages[target]?.version : undefined;
        if (!version) continue;
        if (major(version) >= 3) {
          violations.push(
            `${name}: ${key || '(root)'} declares brace-expansion@${range} but resolved ${version}`,
          );
        }
      }
    }
    expect(checked, 'expected at least one pre-3.x brace-expansion consumer').toBeGreaterThan(0);
    expect(
      violations,
      'these consumers call brace-expansion as a bare function; 3.x+ only exports { expand }, ' +
        'so forcing them up to satisfy the stale GHSA-mh99-v99m-4gvg range breaks globbing at ' +
        'runtime. Use the 1.1.18 / 2.1.4 backports instead.',
    ).toEqual([]);
  });

  const copies = copiesMatchingLock();

  if (copies.length === 0) {
    it.skip('no brace-expansion copy is installed at its lockfile version (run npm ci --include=dev)', () => {});
  }

  for (const { workspace, key, dir, version } of copies) {
    it(`${workspace}: ${key}@${version} caps total expansion length`, () => {
      const mod = require_(dir) as unknown;
      const expand = (typeof mod === 'function' ? mod : (mod as { expand?: unknown }).expand) as (
        pattern: string,
      ) => string[];
      expect(typeof expand, `${key} exposes no callable expander`).toBe('function');

      // A neutered expander would trivially satisfy the length cap below.
      expect(expand('a{b,c}d'), `${key} no longer expands correctly`).toEqual(['abd', 'acd']);

      const chars = expand(LENGTH_BOMB).reduce((n, s) => n + s.length, 0);
      expect(
        chars,
        `${workspace}: ${key}@${version} expanded an 0.8 MB pattern to ${chars} chars ` +
          `(unbounded is ${UNBOUNDED_CHARS}); it is missing the CVE-2026-14257 length cap`,
      ).toBeLessThanOrEqual(MAX_CHARS);
    });

    if (satisfies(version, '1.x || 2.x')) {
      it(`${workspace}: ${key}@${version} stays callable as a bare CJS export`, () => {
        // minimatch 3/5/9 call the module object directly. Bumping these copies
        // onto the 3.x+ `{ expand }` shape to satisfy the stale advisory range
        // breaks every glob in the tree at runtime.
        expect(
          typeof require_(dir),
          `${key}@${version} must stay callable: its minimatch parent does ` +
            `require('brace-expansion')(pattern), which the 3.x+ named export breaks`,
        ).toBe('function');
      });
    }
  }

  /**
   * GHSA-rgw5-rvv9-x895: 5.0.8 walked every comma part of a group and appended
   * that part's *entire* sub-expansion to one array, checking the length cap
   * only once the whole array was built. 60 parts x ~100k short results is a
   * 3.6 KB pattern that allocates ~500 MB before returning the same 1.8 MB
   * 5.0.9 returns in ~95 MB, so the results are identical and only the
   * footprint separates them.
   *
   * Measured in a child process with a hard old-space cap rather than by
   * sampling `memoryUsage()` in-process: the intermediate is freed before
   * `expand` returns, so a post-hoc heap read sees nothing, and the vitest
   * worker's own heap would make any threshold depend on test ordering.
   *
   * 1.1.18, 2.1.4 and 5.0.9 all complete this in ~200 ms and still pass with
   * the cap as low as 64 MB, while 5.0.8 exhausts every cap from 128 MB up.
   * 128 MB therefore leaves 2x headroom on the patched side without landing
   * anywhere near the vulnerable side. The timeout only bounds the failing
   * path -- V8 GC-thrashes for well over a minute before conceding OOM -- and
   * a kill is reported as a failure just like a non-zero exit.
   */
  const HEAP_CAP_MB = 128;
  const CHILD_TIMEOUT_MS = 45_000;
  const PARTS_BOMB = `{${new Array(60).fill('{a,b}'.repeat(18)).join(',')}}`;
  const PARTS_BOMB_RESULTS = 100_000;

  /** One representative copy per distinct version -- the bomb costs ~1s a run. */
  const byVersion = new Map<string, (typeof copies)[number]>();
  for (const copy of copies) if (!byVersion.has(copy.version)) byVersion.set(copy.version, copy);

  for (const { workspace, key, dir, version } of byVersion.values()) {
    // Above the suite-wide 15 s testTimeout: a patched copy returns in ~200 ms,
    // but a vulnerable one has to be allowed to reach CHILD_TIMEOUT_MS so the
    // failure reads as "exhausted the heap" and not as a bare vitest timeout.
    it(`${workspace}: ${key}@${version} bounds intermediate expansion arrays`, () => {
      const child = spawnSync(
        process.execPath,
        [
          `--max-old-space-size=${HEAP_CAP_MB}`,
          '-e',
          `const m = require(${JSON.stringify(dir)});
           const expand = typeof m === 'function' ? m : m.expand;
           process.stdout.write('RESULTS=' + expand(process.env.BRACE_BOMB).length);`,
        ],
        {
          env: { ...process.env, BRACE_BOMB: PARTS_BOMB },
          encoding: 'utf8',
          timeout: CHILD_TIMEOUT_MS,
        },
      );

      const detail =
        `${workspace}: ${key}@${version} could not expand a ${PARTS_BOMB.length}-byte pattern ` +
        `within a ${HEAP_CAP_MB} MB heap; it is missing the GHSA-rgw5-rvv9-x895 intermediate-` +
        `array bound. exit=${child.status} signal=${child.signal} ` +
        `stderr=${(child.stderr || '').slice(-400)}`;

      expect(child.status, detail).toBe(0);
      // Guards the other direction: a copy that bailed out early would also fit
      // in the cap, so the run has to produce the full, correct result set.
      expect(child.stdout, detail).toBe(`RESULTS=${PARTS_BOMB_RESULTS}`);
    }, 60_000);
  }
});

/**
 * GHSA-8j4g-w8fx-2239: `hono/cors` reflects `Access-Control-Request-Headers` on
 * a preflight when `allowHeaders` is unset (the default), and parsed it with a
 * whitespace-tolerant regex whose backtracking is quadratic in the value's
 * length. A single OPTIONS request carrying one long whitespace run with no
 * delimiter burns seconds of CPU: measured on 4.12.32, 50 000 spaces takes
 * 2.7 s, 100 000 takes 8.5 s and 200 000 takes 39.5 s. 4.12.34 answers all
 * three in ~4 ms.
 *
 * Both versions return the *identical* reflected header, so no output
 * assertion can separate them -- the resource the fix bounds is CPU time. As
 * with the brace-expansion heap guard above, the reliable way to constrain
 * that is a child process under a hard timeout, which turns it into a binary
 * exit-code assertion instead of a flaky in-process wall-clock threshold.
 *
 * The whitespace has to sit *between* two tokens. A leading or trailing run is
 * stripped by the `Headers` constructor before the middleware ever sees it, so
 * `x-a<spaces>x-b` is the shape that actually reaches the parser.
 *
 * 200 000 spaces puts the patched path at ~0.24 s wall (including node boot)
 * and the vulnerable path at ~40 s, so a 10 s cap leaves ~40x headroom on the
 * patched side and still fires ~4x before the vulnerable side could finish.
 */
describe('hono/cors bounds preflight header parsing (GHSA-8j4g-w8fx-2239)', () => {
  const WHITESPACE_RUN = 200_000;
  const CHILD_TIMEOUT_MS = 10_000;
  /** `x-a` + the run + `x-b`, i.e. what the middleware must reflect back. */
  const EXPECTED_ALLOW_LENGTH = WHITESPACE_RUN + 6;

  /**
   * Every `hono` copy installed at the version its lockfile resolved. A
   * mismatch means the tree predates the lock, so the code on disk says
   * nothing about what a fresh `npm ci` would install.
   */
  const copies: Array<{ workspace: string; key: string; cwd: string; version: string }> = [];
  for (const { name, lock } of LOCKFILES) {
    const root = dirname(join(here, lock));
    for (const [key, meta] of Object.entries(lockPackages(lock))) {
      if (packageNameOf(key) !== 'hono' || !meta.version) continue;
      const manifest = join(root, key, 'package.json');
      if (!existsSync(manifest)) continue;
      const installed = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string })
        .version;
      if (installed !== meta.version) continue;
      // Resolve from the parent of the copy's own `node_modules` so the bare
      // specifier below can only land on this copy, not a hoisted sibling.
      const cwd = join(root, key.slice(0, key.lastIndexOf('node_modules/')) || '.');
      copies.push({ workspace: name, key, cwd, version: meta.version });
    }
  }

  if (copies.length === 0) {
    it.skip('no hono copy is installed at its lockfile version (run npm ci --include=dev)', () => {});
  }

  for (const { workspace, key, cwd, version } of copies) {
    // Above the suite-wide 15 s testTimeout: a vulnerable copy has to be
    // allowed to run into CHILD_TIMEOUT_MS so the failure reads as "the
    // preflight parse never returned" and not as a bare vitest timeout.
    it(`${workspace}: ${key}@${version} answers a whitespace-padded preflight promptly`, () => {
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { Hono } = await import('hono');
           const { cors } = await import('hono/cors');
           const app = new Hono();
           app.use('*', cors());
           app.get('/probe', (c) => c.text('ok'));
           const headers = new Headers({
             Origin: 'https://example.test',
             'Access-Control-Request-Method': 'GET',
           });
           headers.set(
             'Access-Control-Request-Headers',
             'x-a' + ' '.repeat(${WHITESPACE_RUN}) + 'x-b',
           );
           const res = await app.request('/probe', { method: 'OPTIONS', headers });
           process.stdout.write(
             'ALLOW=' + String(res.headers.get('access-control-allow-headers') ?? '').length,
           );`,
        ],
        { cwd, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
      );

      const detail =
        `${workspace}: ${key}@${version} did not answer a preflight carrying a ` +
        `${WHITESPACE_RUN}-space run within ${CHILD_TIMEOUT_MS} ms; it is missing the ` +
        `GHSA-8j4g-w8fx-2239 fix for quadratic backtracking in the Access-Control-Request-` +
        `Headers parser. exit=${child.status} signal=${child.signal} ` +
        `stderr=${(child.stderr || '').slice(-400)}`;

      expect(child.status, detail).toBe(0);
      // Guards the other direction: a middleware that stopped reflecting the
      // requested headers would also finish inside the timeout.
      expect(child.stdout, detail).toBe(`ALLOW=${EXPECTED_ALLOW_LENGTH}`);
    }, 30_000);
  }
});

/**
 * GHSA-55q2-fjhq-7xh7: on the IN_PLACE path DOMPurify treated a node detached
 * by a sanitize hook as "already gone" and returned early, leaving the caller
 * holding a live subtree with its event-handler attributes intact. The caller
 * built that tree in the real document, so an `<img onerror>` in it is already
 * armed and fires in page scope once sanitize returns -- even though the
 * handler never reached the sanitized tree. `node.remove()` inside
 * `uponSanitizeElement` is the pattern DOMPurify's own docs recommend for
 * dropping an element, so this is reachable from documented usage.
 *
 * The floor above proves a version string; this proves the installed code
 * strips the handler. Mutation-checked: 3.4.12 leaves `onerror="alert(1)"` on
 * the detached `<img>`, 3.4.13 returns null for it.
 *
 * Both the sanitized output and `DOMPurify.removed` look identical on the two
 * versions -- the detached subtree is the only place the difference shows --
 * so the assertion has to reach into the node the hook kept a reference to.
 */
describe('dompurify neutralizes hook-detached IN_PLACE subtrees (GHSA-55q2-fjhq-7xh7)', () => {
  const require_ = createRequire(import.meta.url);

  /** Minimal surface of the two untyped modules this guard drives. */
  interface JsdomModule {
    JSDOM: new (html: string) => { window: { document: Document } };
  }
  interface PurifyInstance {
    addHook: (event: string, cb: (node: Element, data: { tagName: string }) => void) => void;
    sanitize: (node: Element, cfg: Record<string, unknown>) => unknown;
  }

  /**
   * `jsdom` is declared by the repo root and by `client`, never by `server`, so
   * resolve it through `createRequire` (node's own upward walk) rather than a
   * static import -- server has no `@types/jsdom` and the specifier would not
   * typecheck.
   */
  let jsdom: JsdomModule | null = null;
  try {
    jsdom = require_('jsdom') as JsdomModule;
  } catch {
    jsdom = null;
  }

  /**
   * Every `dompurify` copy installed at the version its lockfile resolved. A
   * mismatch means the tree predates the lock, so the code on disk says
   * nothing about what a fresh `npm ci` would install.
   */
  const copies: Array<{ workspace: string; key: string; dir: string; version: string }> = [];
  for (const { name, lock } of LOCKFILES) {
    const root = dirname(join(here, lock));
    for (const [key, meta] of Object.entries(lockPackages(lock))) {
      if (packageNameOf(key) !== 'dompurify' || !meta.version) continue;
      const manifest = join(root, key, 'package.json');
      if (!existsSync(manifest)) continue;
      const installed = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string })
        .version;
      if (installed !== meta.version) continue;
      copies.push({ workspace: name, key, dir: join(root, key), version: meta.version });
    }
  }

  if (copies.length === 0) {
    it.skip('no dompurify copy is installed at its lockfile version (run npm ci --include=dev)', () => {});
  } else if (!jsdom) {
    it.skip('jsdom is not installed, so the DOM guard cannot run (run npm ci --include=dev)', () => {});
  }

  for (const { workspace, key, dir, version } of jsdom ? copies : []) {
    it(`${workspace}: ${key}@${version} strips handlers from a hook-detached subtree`, () => {
      const { JSDOM } = jsdom!;
      const createDOMPurify = require_(dir) as (win: unknown) => PurifyInstance;

      const dom = new JSDOM('<!doctype html><body></body>');
      const purify = createDOMPurify(dom.window);

      let detached: Element | null = null;
      purify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'section') {
          detached = node;
          node.remove();
        }
      });

      const root = dom.window.document.createElement('div');
      root.innerHTML = '<section><img src=x onerror="alert(1)"></section>';
      dom.window.document.body.appendChild(root);

      purify.sanitize(root, { IN_PLACE: true });

      const subtree = detached as Element | null;
      expect(subtree, `${key} hook never saw the <section> to detach`).not.toBeNull();
      const img = subtree!.querySelector('img');
      // Asserts the fix did not simply empty the subtree -- a neutralized
      // <img> must still be there, just disarmed.
      expect(img, `${key} detached subtree lost its <img>`).not.toBeNull();
      expect(
        img!.getAttribute('onerror'),
        `${key}@${version} left onerror armed on a subtree detached by an ` +
          'uponSanitizeElement hook during IN_PLACE sanitize; it is missing the ' +
          'GHSA-55q2-fjhq-7xh7 fix.',
      ).toBeNull();
    });
  }
});

/**
 * GHSA-2v37-7h3g-55p8: `customAlphabet(alphabet, n)(0)` never returns. The
 * generator appends a character to `id` before testing `id.length === size`,
 * so with `size === 0` the equality is unreachable and the enclosing
 * `while (true)` spins forever. It is a synchronous loop on whatever thread
 * called it, so one such call wedges a whole event loop -- there is no partial
 * result and no recovery short of killing the process. 3.3.17 short-circuits
 * with `if (size <= 0) return ''`.
 *
 * A size that reaches a generator from request data is the reachable shape
 * here, and 0 is exactly what an absent or coerced field lands on.
 *
 * The floor above proves a version string; this proves the installed code
 * terminates. Measured in a child process under a hard timeout rather than
 * in-process: a vulnerable copy never yields, so an in-process call would hang
 * the vitest worker itself and report as a bare suite timeout with no pointer
 * to the advisory.
 *
 * Both live entry points are exercised. `index.cjs` is what server-side
 * requires resolve, and `index.browser.js` is what the `browser` (client) and
 * `react-native` (mobile) export conditions resolve -- they carry separate
 * copies of the loop. Mutation-checked: on 3.3.16 both hang until the timeout
 * kills the child; on 3.3.18 both return `''` in ~50 ms.
 */
describe('nanoid terminates on a zero-size custom generator (GHSA-2v37-7h3g-55p8)', () => {
  const CHILD_TIMEOUT_MS = 10_000;
  const ALPHABET = 'abcdef';
  const DEFAULT_SIZE = 10;

  /**
   * Every `nanoid` copy installed at the version its lockfile resolved. A
   * mismatch means the tree predates the lock, so the code on disk says
   * nothing about what a fresh `npm ci` would install.
   *
   * Scoped to the 3.x line: 4.x/5.x drop the `async/` subpath and ship a
   * different file layout, so the entry points probed below would not exist.
   */
  const copies: Array<{ workspace: string; key: string; dir: string; version: string }> = [];
  for (const { name, lock } of LOCKFILES) {
    const root = dirname(join(here, lock));
    for (const [key, meta] of Object.entries(lockPackages(lock))) {
      if (packageNameOf(key) !== 'nanoid' || !meta.version) continue;
      if (!satisfies(meta.version, '3.x')) continue;
      const manifest = join(root, key, 'package.json');
      if (!existsSync(manifest)) continue;
      const installed = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string })
        .version;
      if (installed !== meta.version) continue;
      copies.push({ workspace: name, key, dir: join(root, key), version: meta.version });
    }
  }

  if (copies.length === 0) {
    it.skip('no nanoid 3.x copy is installed at its lockfile version (run npm ci --include=dev)', () => {});
  }

  /** One representative copy per distinct version -- each run boots a node. */
  const byVersion = new Map<string, (typeof copies)[number]>();
  for (const copy of copies) if (!byVersion.has(copy.version)) byVersion.set(copy.version, copy);

  for (const { workspace, key, dir, version } of byVersion.values()) {
    // Above the suite-wide 15 s testTimeout: a patched copy answers in ~50 ms,
    // but a vulnerable one has to be allowed to reach CHILD_TIMEOUT_MS so the
    // failure reads as "the generator never returned" and not as a bare vitest
    // timeout.
    it(`${workspace}: ${key}@${version} returns from a zero-size custom generator`, () => {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `const { join } = require('node:path');
           const { pathToFileURL } = require('node:url');
           const dir = ${JSON.stringify(dir)};
           const alphabet = ${JSON.stringify(ALPHABET)};
           const size = ${DEFAULT_SIZE};
           (async () => {
             const cjs = require(join(dir, 'index.cjs'));
             const browser = await import(pathToFileURL(join(dir, 'index.browser.js')).href);
             process.stdout.write('RESULT=' + JSON.stringify({
               cjsZero: cjs.customAlphabet(alphabet, size)(0),
               cjsNormal: cjs.customAlphabet(alphabet, size)().length,
               browserZero: browser.customAlphabet(alphabet, size)(0),
               browserNormal: browser.customAlphabet(alphabet, size)().length,
             }));
           })();`,
        ],
        { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
      );

      const detail =
        `${workspace}: ${key}@${version} did not return from ` +
        `customAlphabet(${JSON.stringify(ALPHABET)}, ${DEFAULT_SIZE})(0) within ` +
        `${CHILD_TIMEOUT_MS} ms; it is missing the GHSA-2v37-7h3g-55p8 zero-size guard. ` +
        `exit=${child.status} signal=${child.signal} stderr=${(child.stderr || '').slice(-400)}`;

      expect(child.status, detail).toBe(0);
      expect(child.stdout.startsWith('RESULT='), detail).toBe(true);

      const result = JSON.parse(child.stdout.slice('RESULT='.length)) as Record<string, unknown>;
      expect(result.cjsZero, detail).toBe('');
      expect(result.browserZero, detail).toBe('');
      // Guards the other direction: a generator neutered to always return ''
      // would satisfy the assertions above, so it still has to produce ids.
      expect(result.cjsNormal, `${key}@${version} no longer generates ids`).toBe(DEFAULT_SIZE);
      expect(result.browserNormal, `${key}@${version} no longer generates ids`).toBe(DEFAULT_SIZE);
    }, 60_000);
  }
});

/**
 * Overrides that are the *only* thing holding a package above its advisory
 * floor. Each of these sits above the range its parent declares, so dropping
 * the override lets a plain `npm install` re-resolve back into the vulnerable
 * line without any lockfile edit looking suspicious. The floor assertions
 * above catch that only after someone re-resolves; these catch the intent
 * being removed.
 */
describe('override-backed advisory floors', () => {
  const OVERRIDE_FLOORS: Array<{
    manifest: (typeof LOCKFILES)[number]['name'];
    pkg: string;
    min: string;
    advisory: string;
    parentRange: string;
  }> = [
    {
      manifest: 'server',
      pkg: '@hono/node-server',
      min: '2.0.5',
      advisory: 'GHSA-frvp-7c67-39w9',
      // @modelcontextprotocol/sdk declares `^1.19.9` and has no release that
      // accepts 2.x, so without the override npm resolves a vulnerable 1.x.
      parentRange: '^1.19.9',
    },
  ];

  for (const { manifest, pkg, min, advisory, parentRange } of OVERRIDE_FLOORS) {
    it(`${manifest}: keeps the ${pkg} override above the ${advisory} floor`, () => {
      const entry = LOCKFILES.find((l) => l.name === manifest);
      expect(entry, `unknown manifest ${manifest}`).toBeDefined();
      const overrides = (readJson(entry!.manifest).overrides ?? {}) as Record<string, string>;
      const range = overrides[pkg];

      expect(
        range,
        `${manifest}/package.json must keep the "${pkg}" override; its parent declares ` +
          `${parentRange}, so removing it re-resolves into the ${advisory} range`,
      ).toBeTruthy();

      const base = String(range).replace(/^[^\d]*/, '');
      expect(
        compareSemver(base, min) >= 0,
        `${manifest} override "${pkg}": "${range}" must be >= ${min} (${advisory})`,
      ).toBe(true);
    });
  }
});

/**
 * Advisories with **no published fix at any released version**. Each vulnerable
 * range below covers every version the registry has ever published, so there is
 * nothing to upgrade *to* -- `first_patched_version` is `null` upstream, not
 * merely undiscovered. Per the convention in
 * `security-bump-prs-hand-edited-lockfiles-break-installs`, these deliberately
 * get **no `FLOORS` entry**: a floor naming a version that does not exist fails
 * immediately, and a floor at the current version passes forever and hides the
 * day a real patch ships.
 *
 * What is guarded here instead is the *reachability argument* that justifies
 * carrying each one. Accepting an unfixable advisory is only defensible while
 * the vulnerable code stays on the path we assessed; if a future dependency
 * change pulls the same package into a new consumer, the justification is void
 * and nobody would otherwise notice. These assertions fail in that case and
 * force the note to be re-derived rather than re-read.
 */
describe('unpatched advisories (containment guards)', () => {
  /**
   * `dependents` is the exhaustive set of packages allowed to pull this copy in.
   * `flags` records the install-class fields the risk assessment leans on.
   */
  const CONTAINED: Array<{
    workspace: (typeof LOCKFILES)[number]['name'];
    pkg: string;
    advisory: string[];
    vulnerableRange: string;
    dependents: string[];
    flags?: { dev?: boolean; optional?: boolean };
    why: string;
  }> = [
    // Vulnerable range `<= 2.0.1`; 2.0.1 is the newest version extract-zip has
    // ever published. Symlink path traversal while unpacking a zip -- only
    // exploitable by an archive an attacker controls.
    //
    // Escaping it needs a parent that drops the dependency outright:
    // `@puppeteer/browsers` 3.x swapped to `modern-tar`, and electron 43 moved
    // to `@electron-internal/extract-zip`. Both are rejected below.
    {
      workspace: 'root',
      pkg: 'extract-zip',
      advisory: ['GHSA-jmr9-qjv8-65gv'],
      vulnerableRange: '<= 2.0.1',
      dependents: ['electron'],
      // devDependency: it runs at `npm install` time to unpack the Electron
      // release archive from the project's own GitHub releases, never a
      // user-supplied zip, and it is not part of any shipped artifact.
      flags: { dev: true },
      why: 'electron 39 -> 43 is four majors of the desktop shell (Chromium/Node bumps, API removals) for a dev-only unpack of a trusted archive',
    },
    {
      workspace: 'server',
      pkg: 'extract-zip',
      advisory: ['GHSA-jmr9-qjv8-65gv'],
      vulnerableRange: '<= 2.0.1',
      dependents: ['@puppeteer/browsers'],
      // Optional throughout: @browserbasehq/stagehand -> puppeteer-core ->
      // @puppeteer/browsers, used only to unpack a browser build downloaded
      // from Chrome for Testing. The ReAct browser tool runs on Playwright.
      flags: { optional: true },
      why: 'puppeteer-core pins @puppeteer/browsers at exactly 2.3.0 (an override to the 3.x line that drops extract-zip breaks that pin), 22.15.0 is the top of the 22.x line stagehand accepts, and the only clean escape is stagehand 3 -> 4, which replaces the whole browser backend',
    },
    // Two advisories, same shape: an infinite loop in a format parser (JXL/HEIF
    // and ICNS). Vulnerable range `<= 2.0.2` covers 2.0.2, the newest published
    // version -- and metro@0.87.0, the newest metro, still declares
    // `image-size: ^1.0.2`, so no parent bump escapes it either.
    {
      workspace: 'mobile',
      pkg: 'image-size',
      advisory: ['GHSA-5p2g-fcmc-qvqq', 'GHSA-w3rx-r6r6-pgpr'],
      vulnerableRange: '<= 2.0.2',
      dependents: ['metro'],
      // Metro is the bundler: it measures image assets committed to this repo
      // at build time and never runs inside the shipped app.
      why: 'every published version is vulnerable and 2.x is a breaking major outside metro’s `^1.0.2` range, so a bump would break the bundler without clearing the advisory',
    },
  ];

  for (const { workspace, pkg, advisory, vulnerableRange, dependents, flags, why } of CONTAINED) {
    const label = advisory.join(', ');

    it(`${workspace}: ${pkg} stays confined to ${dependents.join(', ')} (${label})`, () => {
      const entry = LOCKFILES.find((l) => l.name === workspace);
      expect(entry, `unknown workspace ${workspace}`).toBeDefined();
      const packages = lockPackages(entry!.lock);

      const actual = new Set<string>();
      for (const [key, meta] of Object.entries(packages)) {
        const declared = {
          ...(meta.dependencies ?? {}),
          ...(meta.optionalDependencies ?? {}),
          ...(meta.peerDependencies ?? {}),
        };
        if (declared[pkg]) actual.add(packageNameOf(key) || '<root>');
      }

      expect(
        [...actual].sort(),
        `${workspace}: ${pkg} has no published fix (${label}, vulnerable ${vulnerableRange}); ` +
          `carrying it is only justified while ${dependents.join(', ')} is its sole consumer. ` +
          `A new consumer means the accepted-risk note must be re-derived. Context: ${why}`,
      ).toEqual([...dependents].sort());
    });

    if (flags) {
      it(`${workspace}: every ${pkg} copy stays ${Object.keys(flags).join('/')} (${label})`, () => {
        const entry = LOCKFILES.find((l) => l.name === workspace);
        const packages = lockPackages(entry!.lock);
        let checked = 0;

        for (const [key, meta] of Object.entries(packages)) {
          if (packageNameOf(key) !== pkg || !meta.version) continue;
          checked++;
          for (const [flag, want] of Object.entries(flags)) {
            expect(
              meta[flag as 'dev' | 'optional'] === true,
              `${workspace}: ${key}@${meta.version} must stay "${flag}: ${want}" -- ` +
                `${pkg} carries the unfixed ${label}, and the risk assessment rests on it ` +
                `never entering the production graph`,
            ).toBe(true);
          }
        }

        expect(checked, `expected at least one ${pkg} entry in ${workspace}`).toBeGreaterThan(0);
      });
    }
  }

  /**
   * GHSA-866g-f22w-33x8 (low): uncontrolled resource consumption in
   * `createJsonResponseHandler`. Vulnerable range `<= 3.0.97` while the stable
   * 3.x line tops out at 3.0.32, so every published 3.x is inside it. The
   * reachable sink parses responses from configured, trusted LLM provider
   * endpoints, not attacker-controlled hosts.
   *
   * Containment is asserted on the one fact a lockfile can actually settle:
   * the first-party `ai` / `@ai-sdk/*` family pins provider-utils to an *exact*
   * version. An override to 4.x/5.x therefore does not merely sit outside a
   * declared range, it contradicts an exact pin -- satisfying a scanner while
   * breaking the stack at runtime, the trap documented in
   * `security-bump-prs-hand-edited-lockfiles-break-installs`.
   *
   * Deliberately not asserted: that every consumer's *range* stays inside
   * `<= 3.0.97`. It does not, and should not be forced to -- the third-party
   * `ollama-ai-provider-v2` declares `^3.0.17`, which formally admits 3.1.0+.
   * That range only resolves inside the advisory because the 3.1.0 line is
   * still prerelease-only, which is a registry fact of today rather than a
   * property of this repo, so encoding it here would make the suite fail on an
   * upstream publish that changed nothing about our exposure.
   */
  it('server: the first-party @ai-sdk family pins @ai-sdk/provider-utils exactly', () => {
    const packages = lockPackages('./package-lock.json');
    const ranged: string[] = [];
    let pinned = 0;

    for (const [key, meta] of Object.entries(packages)) {
      const name = packageNameOf(key);
      if (name !== 'ai' && !name.startsWith('@ai-sdk/')) continue;
      const spec = meta.dependencies?.['@ai-sdk/provider-utils'];
      if (!spec || NON_REGISTRY_SPEC.test(spec)) continue;
      if (/^\d+\.\d+\.\d+$/.test(spec)) pinned++;
      else ranged.push(`${name} -> ${spec}`);
    }

    expect(pinned, 'expected first-party @ai-sdk consumers in the server lockfile').toBeGreaterThan(
      0,
    );
    expect(
      ranged.sort(),
      'these first-party @ai-sdk packages no longer pin @ai-sdk/provider-utils exactly; an overrides ' +
        'entry may now be safe where it previously broke the stack at runtime',
    ).toEqual([]);
  });
});

/**
 * A dependency bump can quietly move the Node line out from under us: a new
 * major may raise `engines.node`, or narrow it with an upper bound, which
 * surfaces as an install-time engine failure under `engine-strict` or as a
 * runtime incompatibility on a deploy target long after the PR that moved it.
 * The lockfile records each dependency's `engines.node`, so the check is exact
 * rather than a spot audit of the packages someone thought to look at.
 *
 * The assertion is containment: every Node version the declared range admits
 * must satisfy the dependency, since we can ship or deploy on any of them.
 *
 * `server` must declare a range because it is the deployed runtime and carries
 * the `overrides` that force packages past their parents' declared ranges.
 */
/**
 * `<X.Y.Z` written by hand admits `X.Y.Z-0` once a range is reasoned about
 * prerelease-inclusively, while the `^`/`~`/`x` forms a dependency is far more
 * likely to publish desugar to an upper bound that stops at `<X.Y.Z-0`. Left
 * alone that mismatch makes `>=22.14.0 <23.0.0` look wider than `^22.12.0` and
 * reports a violation on a range that in fact covers us. Pinning the bound to
 * `-0` states the thing the manifest already means: `<23.0.0` excludes Node 23,
 * prereleases included.
 */
function excludeBoundaryPrereleases(range: string): string {
  return range.replace(/<(?!=)\s*(\d+\.\d+\.\d+)(?![-+\w.])/g, '<$1-0');
}

/**
 * Does every Node version we claim to support satisfy `required`?
 *
 * Containment, not a floor probe: a dependency range with an upper bound (say
 * `>=20 <22.16`) accepts our lowest supported Node and still rejects versions
 * further up our own range, so testing the floor alone passes a dependency we
 * would break on after a routine Node patch upgrade.
 */
function declaredRangeCoveredBy(declared: string, required: string): boolean {
  return subset(excludeBoundaryPrereleases(declared), required, { includePrerelease: true });
}

describe('declared Node engines cover every dependency', () => {
  const MUST_DECLARE_ENGINES: ReadonlyArray<(typeof LOCKFILES)[number]['name']> = ['server'];

  for (const name of MUST_DECLARE_ENGINES) {
    it(`${name}: declares an engines.node range`, () => {
      const entry = LOCKFILES.find((l) => l.name === name);
      expect(entry, `unknown manifest ${name}`).toBeDefined();
      const declared = readJson(entry!.manifest).engines?.node as string | undefined;
      expect(
        declared,
        `${name}/package.json must declare "engines.node" so the supported Node line is ` +
          `machine-checked against what its dependencies require`,
      ).toBeTruthy();
    });
  }

  for (const { name, lock, manifest } of LOCKFILES) {
    it(`${name}: every supported Node version satisfies every dependency's engines.node`, () => {
      const declared = readJson(manifest).engines?.node as string | undefined;
      if (!declared) return; // covered by MUST_DECLARE_ENGINES for the surfaces that need it

      expect(
        () => minVersion(declared),
        `${name}: "${declared}" is not a parseable range`,
      ).not.toThrow();

      const violations: string[] = [];
      let checked = 0;
      for (const [key, meta] of Object.entries(lockPackages(lock))) {
        const required = (meta as { engines?: { node?: string } }).engines?.node;
        if (!required) continue;
        checked++;
        // A malformed range from a published package must not silently pass.
        let covered: boolean;
        try {
          covered = declaredRangeCoveredBy(declared, required);
        } catch {
          violations.push(`${key} declares an unparseable engines.node "${required}"`);
          continue;
        }
        if (!covered) violations.push(`${key} requires node "${required}"`);
      }

      expect(checked, `expected ${name} lockfile entries to record engines.node`).toBeGreaterThan(
        0,
      );
      expect(
        violations,
        `${name}: "${declared}" admits Node versions these dependencies reject. Either narrow ` +
          `engines.node across the repo (package.json, .nvmrc, Dockerfiles, CI node-version) ` +
          `or pick dependency versions that cover the whole declared line.`,
      ).toEqual([]);
    });
  }

  // The containment semantics above are the entire point of the guard, so pin
  // them directly rather than inferring them from whatever the tree resolves to
  // today -- a lockfile that happens to hold no upper-bounded range would let a
  // floor-only regression sit here undetected.
  describe('range containment semantics', () => {
    const DECLARED = '>=22.14.0 <23.0.0';

    it.each([
      ['>=20.0.0', true, 'an open lower bound above our floor'],
      ['^20.19.0 || >=22.12.0', true, 'a union whose upper arm is open'],
      ['^20.19.0 || ^22.12.0 || >=24.0.0', true, 'a union arm that brackets our whole range'],
      ['20.x || 22.x || 23.x || 24.x', true, 'x-ranges covering our major'],
      ['>=22.14.0 <23.0.0', true, 'the identical range'],
      ['>=20 <22.16', false, 'an upper bound inside our range'],
      ['>=24.0.0', false, 'a floor above our whole range'],
      ['^20.0.0', false, 'a major we do not run'],
      ['>=22.20.0', false, 'a floor above ours but inside our range'],
    ])('%s -> %s (%s)', (required, expected) => {
      expect(declaredRangeCoveredBy(DECLARED, required as string)).toBe(expected);
    });
  });
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
          if (NON_REGISTRY_SPEC.test(range)) continue;
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
