# Dependency advisory triage — 2026-09-02

Record of an automated dependency-audit sweep that flagged 20 vulnerable
dependency occurrences (12 high, 7 medium, 1 low) across the root, `server/`,
and `mobile/` lockfiles. This file is the tracked containment rationale for the
occurrences that were **not** bumped, and the validation evidence for the ones
that were. It supersedes `dependency-advisories-2026-09-01.md` for the packages
covered here; the three unfixable advisories below were re-reviewed this sweep
and cross-reference that file rather than duplicating its deep-dives.

## Fixed (bumped + re-resolved with npm — no hand-edited lock fields)

| Package        | Manifest(s)                                     | From → To           | Advisories                                                                                                                                             | Fixed floor |
| -------------- | ----------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| fast-uri       | `package-lock.json`, `server/package-lock.json` | 3.1.5 → **3.1.7**   | GHSA-f65p-4m7j-42xc (CVE-2026-75975), GHSA-fph4-wmhf-6fwf (CVE-2026-75899), GHSA-jqff-g426-hqxp (CVE-2026-76172), GHSA-5jgf-p345-68v8 (CVE-2026-75931) | 3.1.6       |
| qs             | `package-lock.json`, `server/package-lock.json` | 6.15.3 → **6.16.0** | GHSA-4mjr-xmp4-gh2g (CVE-2026-82417), GHSA-x5fp-wj9c-mxmx (CVE-2026-82562)                                                                             | 6.16.0      |
| @humanfs/node  | `package-lock.json`                             | 0.16.7 → **0.16.8** | GHSA-p498-v437-472g                                                                                                                                    | 0.16.8      |
| @xmldom/xmldom | `package-lock.json`, `mobile/package-lock.json` | 0.8.13 → **0.8.15** | GHSA-6gmq-8vp8-gcm6 (CVE-2026-83610)                                                                                                                   | 0.8.15      |

All four patched versions and their `first_patched_version` were confirmed
against the live GitHub advisory DB (`gh api /advisories/<GHSA>`) before writing
the floors.

**fast-uri** — every copy sits under `ajv`'s `fast-uri: ^3.0.1` in both
lockfiles, so `npm update fast-uri` re-resolved to 3.1.7 (top of the 3.1.x line)
in range with no override. 3.1.7 exceeds the 3.1.6 fixed floor for all four new
SSRF / host-confusion advisories and subsumes the earlier 3.1.5 fix
(GHSA-7p8r-x3mc-p8w7).

**@humanfs/node** — root-only, arriving solely via `eslint`'s
`@humanfs/node: ^0.16.6` (a devDependency that never ships). 0.16.8 re-resolved
in range with no override; the re-resolve also added `@humanfs/types@0.15.0` and
moved `@humanwhocodes/retry` 0.19.1 → 0.19.2 forward within eslint's dev tree.

**@xmldom/xmldom** — root (via `plist`) and mobile (via `plist` / `@expo/plist`),
both declaring `@xmldom/xmldom: ^0.8.8`, so 0.8.15 re-resolved in range with no
override. 0.8.15 is the 0.8.x-line patch; the 0.9.x line patches at 0.9.12, but
neither consumer's range admits the 0.9.x major.

**qs** — split resolution. In the root, `qs` arrives under `superagent`'s
`^6.14.1`, so `npm update qs` re-resolved to 6.16.0 in range. In `server`, the
top-level `express@4` and its `body-parser` pin `qs ~6.15.1` (`< 6.16.0`), so a
plain re-resolve stays on 6.15.x; 6.16.0 is reachable there only through a new
`"qs": "^6.16.0"` **override** in `server/package.json`. qs 6.16.0 is a minor
within the same major (`parse`/`stringify` API unchanged), so the override is
behaviour-preserving for express/body-parser.

## Guard coverage (server/dependency-security-guards.test.ts)

- fast-uri floor raised 3.1.5 → **3.1.6**, advisory list replaced with the four
  new SSRF / host-confusion GHSAs.
- qs floor raised 6.15.2 → **6.16.0**, advisory list replaced with the two new
  GHSAs; a `server` `qs` override entry added to `OVERRIDE_FLOORS` (parent range
  `~6.15.1`) so removing the override — which would silently re-resolve back into
  the vulnerable range — fails the suite.
- New floors added for `@humanfs/node` (0.16.8, root-only) and `@xmldom/xmldom`
  (0.8.15, root + mobile).
- The three unfixable advisories below keep their existing containment guards in
  the same file (`unpatched advisories (containment guards)`), unchanged.

## Validation

- `cd server && npx vitest run dependency-security-guards.test.ts` →
  **94 tests passed** (all floors, override-backed floors, containment guards,
  behavioural regression guards, lockfile-coherence, and Node-engine coverage).
- `cd server && npx vitest run worktree-dependency-install.test.ts` →
  **5 tests passed**.
- `cd server && npm run typecheck` (`tsc --noEmit`) → **exit 0**.
- Lockfile blast radius reviewed: only the four target packages plus their own
  sub-deps changed (`@humanfs/types` added, `@humanwhocodes/retry` re-resolved
  in-range). The `lockfile coherence (no hand-edited version strings)` guard
  confirms every resolved version still satisfies its parent range or an
  `overrides` entry, i.e. the lockfiles remain installable under `npm ci`.

## Not bumped — containment rationale

Each of these has **no published fix at any released version**
(`first_patched_version` is `null` upstream — re-verified against the live
advisory DB on 2026-09-02), so there is nothing to upgrade to. Per the
`unfixable-dependency-advisories-containment-guards-not-version-floors`
convention they get **no version floor**; containment is asserted instead by the
guards in `server/dependency-security-guards.test.ts`. Full reachability
deep-dives live in `dependency-advisories-2026-09-01.md`; this sweep re-reviewed
each and confirms the containment argument still holds.

### extract-zip 2.0.1 (root, server) — GHSA-jmr9-qjv8-65gv (CVE-2026-56876), HIGH

- Symlink path traversal while unpacking a zip; only exploitable via an
  attacker-controlled archive. Vulnerable range `<= 2.0.1`, the newest release.
- **root**: dev-only, via `electron` (unpacks the trusted Electron release
  archive at install time, never a user zip; not in any shipped artifact).
- **server**: optional throughout, via `@puppeteer/browsers` (unpacks a Chrome
  for Testing build); the ReAct browser tool runs on Playwright, not this path.
- **Decision:** no fix available. Contained by dev/optional-only reachability;
  the guard asserts it never leaves `electron` (root) / `@puppeteer/browsers`
  (server) and stays `dev`/`optional`. Bump when upstream publishes a patch.

### image-size 1.2.1 (mobile) — GHSA-5p2g-fcmc-qvqq (CVE-2025-71329), GHSA-w3rx-r6r6-pgpr (CVE-2025-71330), HIGH

- Infinite-loop DoS in the JXL/HEIF and ICNS parsers. Vulnerable range
  `<= 2.0.2`; the only non-vulnerable line would be a breaking 2.x major that
  changed the export shape, and `metro@0.87` still pins `image-size: ^1.0.2`.
- Pulled transitively by **Metro**, a build-time bundler dependency that
  measures local trusted image assets and never runs inside the shipped app.
- **Decision:** do not force the breaking major (it would break the bundler
  without clearing the advisory). Contained by build-time-only reachability;
  the guard asserts `image-size` stays confined to `metro`. Tracked as
  follow-up card #2045 from the prior sweep — still blocked on Metro widening
  its range or a 1.x patch.

### @ai-sdk/provider-utils 3.0.23 (server) — GHSA-866g-f22w-33x8 (CVE-2026-8769), LOW

- Uncontrolled resource consumption in `createJsonResponseHandler`. Vulnerable
  range `<= 3.0.97` covers every published 3.x; the reachable sink parses
  responses from configured, trusted LLM provider endpoints, not
  attacker-controlled hosts.
- Hard-pinned to an **exact** version by the whole first-party `ai` / `@ai-sdk/*`
  family, so an override to a 4.x/5.x line would contradict that exact pin and
  break the SDK at runtime while only satisfying a scanner.
- **Decision:** do not force a whole-SDK major bump for a LOW resource-
  consumption issue. Contained by the exact-pin; the guard asserts the
  first-party `@ai-sdk/*` family still pins `@ai-sdk/provider-utils` exactly.
  Address as part of a deliberate `@ai-sdk/*` upgrade.
