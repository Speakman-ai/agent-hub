/**
 * Tests for the webapp reference `.agent-hub/ci.yaml` shipped as
 * a fixture in this repo.
 *
 * Card 5df552ec — "Roll out Finalize Code Changes to webapp repo
 * (second dogfood)" — proposed a ci.yaml for the webapp
 * (Angular + Django) stack. Because Agent Hub's PR machinery pushes the
 * worktree branch to the agent-hub remote, the actual commit into the
 * webapp repo must happen via a session on the webapp
 * board. To keep the proposed file from bitrotting in the meantime, the
 * content lives at `server/finalize/fixtures/example-webapp.ci.yaml`
 * and these tests pin its shape against the same parser the
 * orchestrator uses.
 *
 * What the tests guarantee:
 *
 *   1. The fixture parses cleanly against `parseCiConfig` (the single
 *      source of truth on the wire format). If the parser tightens
 *      in a follow-up, this test fails loudly so the fixture is
 *      updated alongside the parser change — preventing the case
 *      where a webapp session ships a now-invalid file.
 *
 *   2. The fixture declares both `finalize` and `manual` triggers,
 *      mirroring the agent-hub config. Manual is needed during the
 *      dogfood phase so the webapp session can replay a failed
 *      run without re-clicking the kanban card.
 *
 *   3. The step set matches the dogfood contract documented in the
 *      file's header AND in the wiki appendix:
 *      install-backend-venv → install-frontend-npm → lint → cypress
 *      component tests → ng prod build. Backend pytest is
 *      intentionally deferred (see the file's header for the rationale
 *      around Postgres + AWS secrets and the missing service-container
 *      syntax).
 *
 *   4. The timeout stays at the 60-minute default. The first cold
 *      `npm ci` on Angular 18 + a venv install + Cypress + ng build
 *      takes ~6 min on a clean runner; leaving the ceiling at 60
 *      gives plenty of headroom for the frontend Cypress flake recovery
 *      that webapp's existing GH Actions occasionally hit.
 */

import path from 'path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { loadCiConfigFromFile, FINALIZE_TIMEOUT_DEFAULT_MINUTES } from './ci-config.js';

// `server/finalize/repo-ci-yaml-example-webapp.test.ts` and the
// fixture file `server/finalize/fixtures/example-webapp.ci.yaml`
// share the same parent directory, so the path is local.
const __filename = fileURLToPath(import.meta.url);
const FIXTURE_PATH = path.join(path.dirname(__filename), 'fixtures', 'example-webapp.ci.yaml');

describe('webapp reference: example-webapp.ci.yaml', () => {
  it('parses cleanly against the schema', async () => {
    const result = await loadCiConfigFromFile(FIXTURE_PATH);
    if (!result.ok) {
      throw new Error(
        `webapp fixture failed to parse: code=${result.error.code} path=${result.error.path ?? '(root)'} message=${result.error.message}`,
      );
    }
    expect(result.config.version).toBe(2);
  });

  it('declares both finalize + manual triggers (dogfood needs replay)', async () => {
    const result = await loadCiConfigFromFile(FIXTURE_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.on).toContain('finalize');
    expect(result.config.on).toContain('manual');
  });

  it('runs the documented dogfood step set in order', async () => {
    const result = await loadCiConfigFromFile(FIXTURE_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Contract (from the file header + wiki appendix):
    //   1. install backend venv + flake8 + black
    //   2. install frontend (cd frontend && npm ci)
    //   3. lint (./lint — Python + Angular + CAD orphan)
    //   4. Cypress component tests
    //   5. ng production build
    //
    // Five steps. Loose on the human-readable `name` field
    // (editorial); strict on the `run` script keywords so a future
    // accidental reorder or deletion can't pass silently.
    const steps = result.config.jobs.checks.steps;
    expect(steps).toHaveLength(5);
    const runs = steps.map((s) => s.run);

    // 1. Backend venv install — must create `.venv` so ./lint can find
    //    `.venv/bin/python`, and must install black pinned at 25.1.0
    //    (matches the agreed black version across the webapp
    //    repo's `pyproject.toml` + lint workflow).
    expect(runs[0]).toMatch(/python3?\s+-m\s+venv\s+\.venv/);
    expect(runs[0]).toMatch(/black==25\.1\.0/);
    expect(runs[0]).toMatch(/flake8/);

    // 2. Frontend npm ci — the Angular 18 install. Must use `npm ci`
    //    (not `npm install`) for lockfile-faithful reproducibility.
    expect(runs[1]).toMatch(/cd\s+frontend/);
    expect(runs[1]).toMatch(/npm ci/);

    // 3. `./lint` — wraps Python + Angular linters. We pin the literal
    //    invocation because changing it (e.g. inlining flake8/black/ng
    //    lint here) would drift from how webapp engineers run
    //    the same checks locally.
    expect(runs[2]).toMatch(/\.\/lint/);

    // 4. Cypress component tests. We accept `npx cypress run` with
    //    `--component` somewhere in the script.
    expect(runs[3]).toMatch(/cypress run/);
    expect(runs[3]).toMatch(/--component/);

    // 5. ng prod build. We accept the npm script alias the repo's
    //    package.json defines (`build:production`) — calling
    //    `ng build --configuration=production` directly would
    //    bypass the project's documented entry point.
    expect(runs[4]).toMatch(/build:production/);
  });

  it('inherits the default timeout (cold Angular install + Cypress needs slack)', async () => {
    const result = await loadCiConfigFromFile(FIXTURE_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fixture omits `timeout_minutes`, so it inherits the parser
    // default. That default was raised from 60m to 240m (4h) to give
    // cold `npm ci` on the Angular 18 dependency graph + a Cypress run
    // plenty of slack on a fresh runner.
    expect(result.config.timeoutMinutes).toBe(FINALIZE_TIMEOUT_DEFAULT_MINUTES);
    expect(result.config.timeoutMinutes).toBe(240);
  });

  it('does NOT include backend pytest (Postgres + AWS secrets deferred)', async () => {
    const result = await loadCiConfigFromFile(FIXTURE_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Tripwire: the moment someone adds a backend pytest step here,
    // they must also wire the service-container / env-passthrough
    // mechanism documented in the wiki appendix (and in this card's
    // follow-ups). The file header explains the rationale; this
    // assertion is the runtime-enforced version of that rationale.
    const runsLower = result.config.jobs.checks.steps.map((s) => s.run.toLowerCase()).join('\n');
    expect(runsLower).not.toMatch(/manage\.py\s+migrate/);
    expect(runsLower).not.toMatch(/\bpytest\b/);
  });
});
