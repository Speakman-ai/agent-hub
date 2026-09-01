# Dependency advisory triage — 2026-09-01

Record of an automated dependency-audit sweep that flagged 10 vulnerable
dependency occurrences (8 high, 1 medium, 1 low). This file is the tracked
containment rationale for the occurrences that were **not** bumped, and the
validation evidence for the ones that were. Update it on the next sweep rather
than duplicating.

## Fixed (bumped + re-resolved with npm — no hand-edited lock fields)

| Package | Manifest(s) | From → To | Advisories |
| --- | --- | --- | --- |
| browserslist | `client/package-lock.json`, `mobile/package-lock.json` | 4.28.4 / 4.28.2 → **4.28.8** | GHSA-c83g-rgw3-j3cx (CVE-2026-73089), GHSA-73wf-gq98-2v4g (CVE-2026-73088) |
| decode-uri-component | `mobile/package-lock.json` | 0.2.2 → **0.5.0** (override + patch-package) | GHSA-vcc3-ghjq-m6fr (CVE-2026-45822) |

4.28.8 exceeds the 4.28.7 fixed floor for both browserslist advisories.
Re-resolved via `npm update browserslist` in each package (which also moved the
browserslist family — `caniuse-lite`, `electron-to-chromium`, `node-releases`,
`update-browserslist-db`, `baseline-browser-mapping` — forward within their
existing `^` ranges). No `overrides` were needed because every dependent's
range already admits 4.28.8.

`decode-uri-component` is bumped to the patched **0.5.0** via an `overrides`
entry in `mobile/package.json`, so the real registry `decode-uri-component@0.5.0`
is what resolves in `mobile/package-lock.json`. Because 0.5.0 is ESM-only and its
consumer `query-string@7` is CommonJS (`const decodeComponent =
require('decode-uri-component')`), a one-line **patch-package** patch
(`mobile/patches/query-string+7.1.3.patch`) unwraps the ESM default so the
require stays callable. `query-string` deliberately stays at **7.1.3** — the
version `@react-navigation/core@7` needs (its `import * as queryString …
queryString.parse` requires named entry exports that only qs7 provides; qs8/qs9
moved to a default-only entry). `patch-package` is a regular `mobile` dependency
with a `postinstall: patch-package` hook, so the patch re-applies on every clean
install (verified: `query-string@7.1.3 ✔`). See the deep-dive below for why this
two-part fix is the only compatible way to land the bump.

### Validation (both touched packages)

- **client**: `npm run typecheck` (tsc --noEmit) → exit 0; `vitest run` →
  375 files / 4570 tests passed.
- **mobile**: `npm run typecheck` (tsc --noEmit) → exit 0; `vitest run` →
  177 files / 2174 tests passed.
- **decode-uri-component runtime (mobile)** — the patched `query-string@7`
  exercised exactly as `@react-navigation/core` calls it:
  `queryString.parse('user=%20alice%20&id=42&tags=a&tags=b')` →
  `{id:'42', tags:['a','b'], user:' alice '}`;
  `queryString.stringify({q:'a b',n:3},{sort:false})` → `q=a%20b&n=3`; a malformed
  percent sequence (`x=%E0%A4%A`) is handled without throwing (the advisory's DoS
  path); and the decoder actually loaded resolves to **0.5.0**. `postinstall`
  re-applies the patch on a clean install.
- **Metro / Babel compatibility (mobile)** — because a lockfile fixpoint check
  alone does not exercise the bundler, the actual browserslist consumers on the
  Metro/Babel target-resolution path were exercised under 4.28.8:
  `browserslist(['defaults','last 2 versions'])` resolves 39 targets;
  `@babel/helper-compilation-targets` resolves targets;
  `core-js-compat({targets:'defaults'})` computes 216 polyfills; and
  `@expo/metro-config` loads (`getDefaultConfig` present) and sees browserslist
  4.28.8. This is a **patch-level** bump within the already-resolved 4.28.x line
  (no public API change — the advisories touched internal cache eviction and
  `normalizeStats`), and every dependent's range (`^4.24.0`, `^4.25.0`,
  `^4.28.1`, `>=4.21.0`) already admits 4.28.8.
- **client + mobile**: `npm install --package-lock-only` re-run produces **zero
  drift** — the committed lockfiles are stable npm-resolved fixpoints, so they
  install cleanly under `npm ci`.

## Root cause & sibling scan (mobile lockfile)

Every advisory package in the mobile lockfile was scanned against one class:
*the only published fix is a module-system or major-version break incompatible
with a consumer this repo pins and cannot move.*

| Package | Only available fix | Blocking consumer (pinned) | Same-class? | Disposition |
| --- | --- | --- | --- | --- |
| browserslist | 4.28.7+ (patch, same major) | dependents allow `^4.24`–`^4.28.1` | **No** | **Fixed** → 4.28.8 |
| decode-uri-component | 0.5.0 (**ESM-only**) | `query-string@7` (CJS), pinned `^7.1.3` by `@react-navigation/core` | **Yes** | **Fixed** → 0.5.0 (override + patch-package; see below) |
| image-size | 2.0.x (**breaking major**, changed export shape) | Metro, pinned `^1.0.2` | **Yes** | Descoped → #2045 |

`decode-uri-component` and `image-size` are the same class, but they diverge on
one point: the decode consumer (`query-string@7`) is **first-party-patchable** in
one line, so the bump can be landed with `patch-package`; the image-size consumer
(Metro) is the bundler itself, whose internal `image-size` call sites are not
safely patchable and whose only fix is a breaking 2.x major. So decode is fixed
and image-size is descoped.

## How the decode-uri-component bump was landed (override + patch-package)

A bare `overrides: { "decode-uri-component": "0.5.0" }` does **not** work on its
own, and neither does bumping query-string. The matrix, all resolved with a real
`npm install` and exercised against `@react-navigation/core@7`'s exact access
pattern (`import * as queryString from 'query-string'; queryString.parse(query)`
/ `queryString.stringify(x, { sort: false })`):

| Attempt | decode in lockfile | Result |
| --- | --- | --- |
| `decode-uri-component@0.5.0` override alone | 0.5.0 ✓ | `query-string@7` (CJS) does `require('decode-uri-component')()`; the ESM-only 0.5.0 resolves to `{default: fn}` → `TypeError: decodeComponent is not a function`. |
| `query-string@9.5.1` | 0.5.0 ✓ | qs9's entry is `export default` only, so react-navigation's `import * as queryString … queryString.parse` gets `undefined` (`ns.parse: undefined`, `ns.default.parse: function`). |
| `query-string@8.2.0` + decode 0.5.0 | 0.5.0 ✓ | qs8 entry byte-identical to qs9 → same `parse undefined` break. |
| **override decode 0.5.0 + patch qs7's interop line** | **0.5.0 ✓** | **Works.** qs7 stays (react-navigation gets its named exports); the patch unwraps the ESM default so `decodeComponent` is callable. |

**Root cause:** `@react-navigation/core@7` needs query-string to expose *named*
exports at its entry (only qs7's CJS `module.exports` does), while the patched
decode-uri-component (0.5.0) needs an *ESM-import*-style consumer (qs8/qs9 only).
Those constraints are mutually exclusive at every published version — so instead
of moving a version, the fix keeps qs7 and repairs the single CJS-interop line it
uses to load the decoder.

**The patch** (`mobile/patches/query-string+7.1.3.patch`) is one hunk:

```
-const decodeComponent = require('decode-uri-component');
+const _decodeUriComponent = require('decode-uri-component');
+const decodeComponent = _decodeUriComponent && _decodeUriComponent.default ? _decodeUriComponent.default : _decodeUriComponent;
```

The fallback (`… ? .default : _decodeUriComponent`) also keeps working if the
decoder ever resolves back to a CJS build, so the patch is not brittle to a
future re-resolve. `patch-package` is a regular `mobile` dependency (not a
devDependency) with a `postinstall: patch-package` hook, so the patch applies on
every install path including production installs that omit devDependencies —
avoiding the "postinstall tool missing" footgun. `query-string@7.1.3` is pinned
exactly in the lockfile, so the patch context always matches.

## Image-size — descoped to follow-up #2045

Per the Done-state contract (path b), the one advisory with no deliverable fix is
tracked on the board, not just here: follow-up card **#2045**
(`3b0ba5d2-6403-4e2f-b619-200519eeb9c2`) records `image-size` (advisories 7-8) —
its only fix line is a breaking 2.x major (changed export shape) while Metro pins
`image-size ^1.0.2`, and the vulnerable JXL/HEIF/ICNS parsers only run over local
trusted bundler input. Unblocks when Metro widens its range or a 1.x patch ships.

## Not bumped — containment rationale

Each of these is a valid "checked, no viable fix" outcome. Forcing a change
would break installs or runtime, which is worse than the contained risk.

> `decode-uri-component` is **not** in this list — it was fixed (override +
> patch-package); see "How the decode-uri-component bump was landed" above.

### extract-zip 2.0.1 (server, root) — GHSA-jmr9-qjv8-65gv (CVE-2026-56876), HIGH

- No fix published — 2.0.1 is the latest release on the registry.
- Pulled in as an **optional**, dev/build-time dependency (Electron packaging /
  unpack path). Not reached by the running server.
- **Decision:** no action available; contained by dev-only reachability. Bump
  when upstream publishes a patched release.

### image-size 1.2.1 (mobile) — GHSA-5p2g-fcmc-qvqq (CVE-2025-71329), GHSA-w3rx-r6r6-pgpr (CVE-2025-71330), HIGH

- No fix on the 1.x line; the only patched line is **2.0.x**, a breaking major.
- Pulled transitively by **Metro** (`image-size@^1.0.2`), a build-time bundler
  dependency. An override to 2.0.x would break Metro (2.0 changed the export
  shape from a default function to a named `imageSize`).
- The vulnerable JXL/HEIF/ICNS parsers only run over local, trusted image
  assets during bundling.
- **Decision:** do not force the breaking major. Revisit when Metro widens its
  range to a fixed 2.x or a 1.x patch appears.

### @ai-sdk/provider-utils 3.0.23 (server) — GHSA-866g-f22w-33x8 (CVE-2026-8769), LOW

- Hard-pinned to **exactly** 3.0.23 by the entire `@ai-sdk/*` package set. The
  only newer line is 5.x (a coordinated breaking major of the whole SDK).
- No fix exists on the 3.x line.
- **Decision:** do not force a whole-SDK major bump for a LOW-severity resource
  consumption issue. Address as part of a deliberate `@ai-sdk/*` upgrade.
