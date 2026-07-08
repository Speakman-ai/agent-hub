/**
 * Tests for THIS repository's own committed `.agent-hub/ci.yaml`.
 *
 * Card 5d68e03e — "Roll out Finalize Code Changes to agent-hub repo
 * (first dogfood)" — added the file at the repo root and originally
 * locked a v1 sequential step set ("install, typecheck, lint, test,
 * openapi checks, build"). The follow-up "v2 per-job GHA parity" rollout
 * migrated the file to v2 so every GitHub Actions job runs as its own
 * concurrent runner on the Finalize DinD fleet (build, test matrix,
 * lint). These tests now lock the v2 contract.
 *
 * Live, evergreen check that the committed file:
 *
 *   1. Exists at the repo root (`<repo>/.agent-hub/ci.yaml`). If
 *      someone moves or deletes it during a refactor, this test fails
 *      loudly rather than the orchestrator silently classifying every
 *      `finalize` run as `ci_config_invalid` at the first invocation.
 *
 *   2. Parses cleanly against the v2 schema in `parseCiConfig`. The
 *      parser is the single source of truth — if it tightens (e.g. v3
 *      adds a stricter constraint), this test surfaces the regression
 *      on the file as part of the normal test run, not on a runtime
 *      finalize click.
 *
 *   3. Declares the GHA-parity jobs (build, test, lint)
 *      with a 12-way test matrix (server 1/6 through 6/6, client 1/3
 *      through 3/3, electron, and mobile 1/2 through 2/2): the whole
 *      point of v2 is concurrent per-job fan-out, so the test pins the job
 *      set and the matrix shape so an accidental grouping / serialization
 *      can't slip in.
 *
 *   4. Sets an explicit fast-fail `timeout_minutes` (the dogfood cap is
 *      45 minutes). v2's reason for an explicit cap: a single broken
 *      step shouldn't burn the 4-hour system default on the fleet.
 *
 * Why a runtime test instead of a snapshot or schema diff: the schema
 * diff already exists (the parser itself). What we want to guarantee
 * here is that the *real file on disk*, as committed to main, satisfies
 * both the schema AND the per-repo job contract. That can only be
 * verified by reading the file the orchestrator would read.
 */

import path from 'path';
import { readFile } from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { loadCiConfigFromFile } from './ci-config.js';
import { expandJobInstances } from './ci-config-v2.js';

// Resolve the repo root from this file's location. The test file lives
// at `<repo>/server/finalize/repo-ci-yaml.test.ts`; the ci.yaml lives
// at `<repo>/.agent-hub/ci.yaml`. Two parent hops from the directory
// of this file gets us there. Using `import.meta.url` keeps the test
// CWD-agnostic — vitest is launched from inside `server/` but the
// file we want is two levels up.
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const CI_YAML_PATH = path.join(REPO_ROOT, '.agent-hub', 'ci.yaml');

function suiteBranch(raw: string, suite: string): string {
  const suiteIdx = raw.indexOf(`"$FINALIZE_MATRIX_SUITE" = "${suite}"`);
  expect(suiteIdx).toBeGreaterThan(-1);
  const after = raw.slice(suiteIdx);
  const branchEnd = after.search(/elif \[|^\s*fi\b/m);
  return branchEnd > -1 ? after.slice(0, branchEnd) : after;
}

describe('agent-hub repo: .agent-hub/ci.yaml', () => {
  it('parses cleanly against the v2 schema', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    if (!result.ok) {
      // Surface the parser's structured error if the file is invalid —
      // the message + path are exactly what the orchestrator would
      // render to the user, so the test failure tells you what to fix.
      throw new Error(
        `ci.yaml failed to parse: code=${result.error.code} path=${result.error.path ?? '(root)'} message=${result.error.message}`,
      );
    }
    // v2 routes the run to the DinD fleet (one privileged container per
    // job instance). v1 would run sequentially on the Hub box and lose
    // GHA parity — pin v2 so an accidental downgrade fails loudly.
    expect(result.config.version).toBe(2);
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

  it('fans onto the GHA-parity jobs (build, test, lint, secret-scan) with a 12-way test matrix', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok || result.config.version !== 2) return;

    // The v2 contract from the rollout PR: every GitHub Actions job
    // becomes its own concurrent fleet runner. Lock the job id set so
    // an accidental grouping (e.g. merging lint into build to "save" a
    // runner) fails the test rather than silently undoing the parity.
    const jobIds = Object.keys(result.config.jobs).sort();
    expect(jobIds).toEqual(['build', 'lint', 'secret-scan', 'test']);

    // Every job runs on `ubuntu-24.04` — same image GitHub Actions uses
    // for the canonical workflows. Drift here means the runner image
    // pin diverged from GHA and parity claims become unreliable.
    for (const jobId of jobIds) {
      expect(result.config.jobs[jobId].runsOn).toBe('ubuntu-24.04');
    }

    // The `test` matrix expands to 12 concurrent instances: server 1/6
    // through 6/6, client 1/3 through 3/3, electron, and mobile 1/2
    // through 2/2. Asserting the shape here (rather than counting
    // instances later) keeps the failure message tied to the ci.yaml
    // authoring mistake, not to a downstream expansion bug.
    const testJob = result.config.jobs.test;
    expect(testJob.matrixInclude).toHaveLength(12);
    const suites = testJob.matrixInclude.map((row) => row.suite).sort();
    expect(suites).toEqual([
      'client',
      'client',
      'client',
      'electron',
      'mobile',
      'mobile',
      'server',
      'server',
      'server',
      'server',
      'server',
      'server',
    ]);
    const serverShards = testJob.matrixInclude
      .filter((row) => row.suite === 'server')
      .map((row) => row.shard)
      .sort();
    expect(serverShards).toEqual(['1', '2', '3', '4', '5', '6']);
    const clientShards = testJob.matrixInclude
      .filter((row) => row.suite === 'client')
      .map((row) => row.shard)
      .sort();
    expect(clientShards).toEqual(['1', '2', '3']);
    const mobileShards = testJob.matrixInclude
      .filter((row) => row.suite === 'mobile')
      .map((row) => row.shard)
      .sort();
    expect(mobileShards).toEqual(['1', '2']);

    // The full expansion is what the orchestrator actually fans out.
    // Single-instance jobs (build, lint, secret-scan) + 12 test shards = 15
    // concurrent runners. Pin it so a future "single global runner" refactor
    // surfaces here.
    const instances = expandJobInstances(result.config, {});
    expect(instances).toHaveLength(15);
  });

  it('passes the matrix shard flag into sharded Vitest suites', async () => {
    const raw = await readFile(CI_YAML_PATH, 'utf8');
    for (const suite of ['server', 'client', 'mobile']) {
      expect(suiteBranch(raw, suite)).toContain(
        '--shard="$FINALIZE_MATRIX_SHARD/$FINALIZE_MATRIX_SHARDS"',
      );
    }
  });

  it('reconciles the optional rolldown binding before running the electron suite', async () => {
    // Regression for the Finalize electron-shard failure where vitest's startup
    // aborted with "Cannot find native binding" / "Cannot find module
    // '@rolldown/binding-linux-x64-gnu'" (npm/cli#4828).
    //
    // electron/ has no package.json, so `npm run test:electron` resolves vitest
    // (and its platform-specific rolldown native binding, an OPTIONAL dep) from
    // the ROOT node_modules. The root install uses `npm ci --ignore-scripts` to
    // skip the heavy electron-binary download + better-sqlite3 rebuild, and npm
    // intermittently omits the optional binding under that path. The fix adds an
    // optional-deps reconcile in the electron branch BEFORE the suite runs.
    //
    // We assert on the raw run-script text (not the parsed model) because the
    // per-suite branch lives inside a single shell `run:` block keyed off
    // FINALIZE_MATRIX_SUITE — exactly the surface a future edit might drop.
    const raw = await readFile(CI_YAML_PATH, 'utf8');
    const electronBranch = suiteBranch(raw, 'electron');

    const reconcileIdx = electronBranch.indexOf('npm install --include=optional');
    const testIdx = electronBranch.indexOf('npm run test:electron');
    // The reconcile step exists, includes optional deps, keeps --ignore-scripts
    // (so the electron binary / native rebuild stay skipped), and runs BEFORE
    // the electron suite.
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(electronBranch).toMatch(/npm install --include=optional[^\n]*--ignore-scripts/);
    expect(testIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeLessThan(testIdx);
  });

  it('sets an explicit fast-fail timeout (dogfood cap is 45 minutes)', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The dogfood ci.yaml lowers the runtime cap to 45 minutes so a
    // broken step fails fast on the fleet instead of burning the
    // 4-hour system default. The parser allows lowering but never
    // raising — if this number is bumped above 240, the parser would
    // refuse before this test ran.
    expect(result.config.timeoutMinutes).toBe(45);
  });
});
