/**
 * Guards the npm network-resilience config that keeps transient registry
 * resets from red-failing the Finalize / GitHub Actions pipelines.
 *
 * Background: a `build` job failed with `npm error code ECONNRESET` partway
 * through `cd mobile && npm ci` — a network blip, not a defect in the change
 * set. npm's defaults retry a fetch only twice with a short backoff, so a
 * brief reset fails the whole install. We widen the retry budget + socket
 * timeout via `.npmrc`.
 *
 * Critical npm gotcha (verified): npm reads the *project* `.npmrc` from the
 * package directory ONLY — it does NOT walk up to an ancestor `.npmrc`. So a
 * single repo-root `.npmrc` does NOT cover `cd <pkg> && npm ci`; every
 * workspace package that CI installs into needs its own copy. This test
 * fails loudly if any of them loses the settings or drifts out of sync, so
 * the resilience can't silently regress and reopen the ECONNRESET flake.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Repo-root + every package CI runs `npm ci` inside (see .agent-hub/ci.yaml
// + .github/workflows/ci.yml). If a new workspace package starts being
// installed in CI, add it here so its resilience config is guarded too.
const NPMRC_DIRS = ['', 'client', 'server', 'mobile', 'shared'];

// The minimum resilience each `.npmrc` must carry. Values may be raised, not
// lowered — `npm ci` must survive more than npm's default two retries.
const REQUIRED = {
  'fetch-retries': 5,
  'fetch-retry-maxtimeout': 120_000,
  'fetch-timeout': 600_000,
} as const;

function parseNpmrc(rel: string): Map<string, string> {
  const text = readFileSync(path.join(repoRoot, rel || '.', '.npmrc'), 'utf8');
  const map = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

describe('.npmrc network resilience', () => {
  for (const dir of NPMRC_DIRS) {
    const label = dir === '' ? '<repo root>' : dir;

    it(`${label}/.npmrc carries the fetch-retry hardening`, () => {
      const cfg = parseNpmrc(dir);
      for (const [key, min] of Object.entries(REQUIRED)) {
        const value = cfg.get(key);
        expect(value, `${label}/.npmrc must set ${key}`).toBeDefined();
        expect(
          Number(value),
          `${label}/.npmrc ${key}=${value} must be >= ${min}`,
        ).toBeGreaterThanOrEqual(min);
      }
    });
  }

  // `include=dev` must live in EVERY .npmrc that CI installs from, not just the
  // repo root. npm does not inherit an ancestor `.npmrc`, so the root's
  // `include=dev` never reaches `cd <pkg> && npm ci`; in an environment with a
  // global `omit=dev`, a package-level install would silently skip the
  // typecheck/lint/test toolchains. (Per reviewer feedback on the original
  // per-package .npmrc change.)
  for (const dir of NPMRC_DIRS) {
    const label = dir === '' ? '<repo root>' : dir;
    it(`${label}/.npmrc forces dev installs (include=dev)`, () => {
      expect(parseNpmrc(dir).get('include'), `${label}/.npmrc must set include=dev`).toBe('dev');
    });
  }
});
