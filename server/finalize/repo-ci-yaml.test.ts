/**
 * Tests for THIS repository's own committed `.agent-hub/ci.yaml`.
 *
 * Card 5d68e03e — "Roll out Finalize Code Changes to agent-hub repo
 * (first dogfood)" — added the file at the repo root and locked the
 * step set ("install, typecheck, lint, test, openapi checks, build")
 * via the v1 schema parser in `ci-config.ts`.
 *
 * These tests are the live, evergreen check that the committed file:
 *
 *   1. Exists at the repo root (`<repo>/.agent-hub/ci.yaml`). If
 *      someone moves or deletes it during a refactor, this test fails
 *      loudly rather than the orchestrator silently classifying every
 *      `finalize` run as `ci_config_invalid` at the first invocation.
 *
 *   2. Parses cleanly against the v1 schema in `parseCiConfig`. The
 *      parser is the single source of truth — if it tightens (e.g. v2
 *      adds a stricter constraint), this test surfaces the regression
 *      on the file as part of the normal test run, not on a runtime
 *      finalize click.
 *
 *   3. Matches the contract listed on card 5d68e03e: the six steps
 *      "install, typecheck, lint, test, openapi, build" in that order.
 *      The check is intentionally loose on exact step names (we accept
 *      case differences and small wording drift) but strict on the
 *      ordering and on the `run` script keywords so a future
 *      reordering or accidental deletion can't slip through unnoticed.
 *
 * Why a runtime test instead of a snapshot or schema diff: the schema
 * diff already exists (the parser itself). What we want to guarantee
 * here is that the *real file on disk*, as committed to main, satisfies
 * both the schema AND the per-repo step contract. That can only be
 * verified by reading the file the orchestrator would read.
 */

import path from 'path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { loadCiConfigFromFile } from './ci-config.js';

// Resolve the repo root from this file's location. The test file lives
// at `<repo>/server/finalize/repo-ci-yaml.test.ts`; the ci.yaml lives
// at `<repo>/.agent-hub/ci.yaml`. Two parent hops from the directory
// of this file gets us there. Using `import.meta.url` keeps the test
// CWD-agnostic — vitest is launched from inside `server/` but the
// file we want is two levels up.
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const CI_YAML_PATH = path.join(REPO_ROOT, '.agent-hub', 'ci.yaml');

describe('agent-hub repo: .agent-hub/ci.yaml', () => {
  it('parses cleanly against the v1 schema', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    if (!result.ok) {
      // Surface the parser's structured error if the file is invalid —
      // the message + path are exactly what the orchestrator would
      // render to the user, so the test failure tells you what to fix.
      throw new Error(
        `ci.yaml failed to parse: code=${result.error.code} path=${result.error.path ?? '(root)'} message=${result.error.message}`,
      );
    }
    expect(result.config.version).toBe(1);
  });

  it('declares both finalize + manual triggers (dogfood needs ad-hoc invocation too)', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `finalize` is required for the UI button + agent-block surfaces.
    // `manual` lets operators replay a failing run without re-clicking
    // through the kanban card — useful during the dogfood phase when
    // we may be debugging the orchestrator itself.
    expect(result.config.on).toContain('finalize');
    expect(result.config.on).toContain('manual');
  });

  it('runs the six contracted steps in the card-5d68e03e ordering', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The contract from the card description (verbatim, lowercased):
    //   "install, typecheck, lint, test, openapi checks, build"
    //
    // We assert (a) there are exactly six steps and (b) each step's
    // `run` script invokes the npm script we expect, in order. We do
    // NOT lock the human-readable `name` — that's editorial and may
    // change without affecting the contract.
    expect(result.config.steps).toHaveLength(6);
    const runs = result.config.steps.map((s) => s.run);

    // 1. Install — `install:all` covers root + server + client + mobile
    //    with devDependencies. Plain `npm ci` is insufficient because
    //    the repo is not a real workspaces monorepo (CLAUDE.md notes).
    expect(runs[0]).toMatch(/install/);
    expect(runs[0]).toMatch(/install:all|--include=dev/);

    // 2. Typecheck — `tsc --noEmit` on `server/`.
    expect(runs[1]).toMatch(/typecheck/);

    // 3. Lint — `scripts/run-eslint.mjs .`.
    expect(runs[2]).toMatch(/\blint\b/);

    // 4. Test — server + client + electron + mobile vitest suites.
    expect(runs[3]).toMatch(/\btest\b/);

    // 5. OpenAPI — coverage ratchet + freshness gate.
    expect(runs[4]).toMatch(/check:openapi/);

    // 6. Build — Vite production build of the React client.
    expect(runs[5]).toMatch(/\bbuild\b/);
  });

  it('does not lower the 60-minute timeout ceiling (first dogfood needs slack)', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The system ceiling is 60; the config may lower but never raise.
    // For the first-dogfood deployment we keep the default so a cold
    // `npm run install:all` (~3 min) + full test sweep (~8 min) has
    // headroom. If we tighten this later, this assertion needs a
    // matching update — that's the prompt to re-time the pipeline.
    expect(result.config.timeoutMinutes).toBe(60);
  });
});
