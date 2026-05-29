/**
 * Cross-repo parity: the v1 ci.yaml parser produces the same structural
 * shape for the agent-hub config and the survey-tracker reference.
 *
 * Card 5df552ec — "Roll out Finalize Code Changes to survey-tracker repo
 * (second dogfood)" — has as its last acceptance criterion:
 *
 *   "Cross-repo behavior parity: same step failure on both repos produces
 *    the same fix-dispatch shape and the same metric labels."
 *
 * The fix-dispatch module (`fix-dispatch.ts`) is repo-agnostic by design
 * — a `grep -n 'repo\|github\|metric'` against the file produces zero
 * hits. The behavioural property we want to pin is the layer ONE level
 * above: that the parser hands the orchestrator a structurally
 * identical `CiConfig` object regardless of which repo's file it
 * loaded.
 *
 * Concretely, this test parses both files (the real, committed
 * `<repo>/.agent-hub/ci.yaml` and the survey-tracker reference fixture)
 * and asserts:
 *
 *   1. Both parse with `ok: true`. If either fails, the failure mode
 *      surfaces here rather than at first finalize-click against the
 *      other repo.
 *
 *   2. The set of top-level CiConfig keys is identical. This is the
 *      "shape" half of cross-repo parity — the orchestrator only ever
 *      reads `version`, `on`, `timeoutMinutes`, `steps`, so the same
 *      keys must be present and the same keys must be absent.
 *
 *   3. The `version` ratchet is locked at 1 on both files. If either
 *      drifts (e.g. a v2 migration that only updates one repo), the
 *      parity is broken and the orchestrator would have to branch on
 *      version per repo — exactly the failure mode this test catches.
 *
 *   4. Both files declare the `finalize` trigger and both fit inside
 *      the v1 timeout ceiling (1..60). Anything else fails the
 *      orchestrator's own contract before we ever get to fix-dispatch.
 *
 * What this test deliberately does NOT assert:
 *
 *   - That the step sets are identical. They MUST differ (different
 *     stack: npm/tsc/vitest on agent-hub, venv/Angular/Cypress on
 *     survey-tracker). The card's parity AC is about the orchestrator's
 *     output shape on failure, not about the input commands.
 *
 *   - That the number of steps matches. agent-hub has 6, survey-tracker
 *     has 5 (backend pytest deferred — see the survey-tracker fixture
 *     header and the wiki appendix).
 *
 * The companion per-repo tests (`repo-ci-yaml.test.ts` for agent-hub
 * and `repo-ci-yaml-example-surveytracker.test.ts` for survey-tracker)
 * pin the per-repo step contracts; this test pins what's COMMON.
 */

import path from 'path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { loadCiConfigFromFile, type CiConfig } from './ci-config.js';

const __filename = fileURLToPath(import.meta.url);

// agent-hub's own ci.yaml lives at `<repo>/.agent-hub/ci.yaml`.
// This test file is at `<repo>/server/finalize/cross-repo-parity.test.ts`,
// so two parent hops gets us to the repo root.
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const AGENT_HUB_CI_YAML = path.join(REPO_ROOT, '.agent-hub', 'ci.yaml');

// The survey-tracker reference is a fixture in this repo (the real
// commit lives in the survey-tracker repo and is shipped by a separate
// session — see the card 5df552ec follow-ups).
const SURVEYTRACKER_CI_YAML = path.join(
  path.dirname(__filename),
  'fixtures',
  'example-surveytracker.ci.yaml',
);

// Helper: load + assert ok, returning the CiConfig (or throwing with a
// clear test-failure message that pinpoints which file is broken).
async function loadOk(label: string, file: string): Promise<CiConfig> {
  const result = await loadCiConfigFromFile(file);
  if (!result.ok) {
    throw new Error(
      `${label} ci.yaml failed to parse: code=${result.error.code} ` +
        `path=${result.error.path ?? '(root)'} message=${result.error.message}`,
    );
  }
  return result.config;
}

describe('cross-repo parity: agent-hub vs survey-tracker ci.yaml', () => {
  it('both files parse cleanly against the v1 schema', async () => {
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const surveyTracker = await loadOk('survey-tracker', SURVEYTRACKER_CI_YAML);
    expect(agentHub.version).toBe(1);
    expect(surveyTracker.version).toBe(1);
  });

  it('produces the same set of top-level CiConfig keys for both repos', async () => {
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const surveyTracker = await loadOk('survey-tracker', SURVEYTRACKER_CI_YAML);
    // Sort so the comparison is order-independent. The exact key set
    // is locked at v1: `version`, `on`, `timeoutMinutes`, `steps`.
    // Anything else means one of the configs picked up a key the
    // parser doesn't honour (which would be a parser bug) OR the
    // configs diverged at the type layer (which is the parity break
    // this test exists to catch).
    const agentHubKeys = Object.keys(agentHub).sort();
    const surveyTrackerKeys = Object.keys(surveyTracker).sort();
    expect(agentHubKeys).toEqual(surveyTrackerKeys);
    expect(agentHubKeys).toEqual(['on', 'steps', 'timeoutMinutes', 'version']);
  });

  it('both files declare the finalize trigger (orchestrator needs it)', async () => {
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const surveyTracker = await loadOk('survey-tracker', SURVEYTRACKER_CI_YAML);
    expect(agentHub.on).toContain('finalize');
    expect(surveyTracker.on).toContain('finalize');
  });

  it('both files have timeouts within the v1 ceiling [1, 60]', async () => {
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const surveyTracker = await loadOk('survey-tracker', SURVEYTRACKER_CI_YAML);
    for (const cfg of [agentHub, surveyTracker]) {
      expect(cfg.timeoutMinutes).toBeGreaterThanOrEqual(1);
      expect(cfg.timeoutMinutes).toBeLessThanOrEqual(60);
    }
  });

  it('every step on every repo has a non-empty name and run', async () => {
    // Both per-step invariants are also asserted by the parser, but
    // pinning them here makes the parity property obvious from this
    // test alone (no need to read ci-config.ts to trust the claim).
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const surveyTracker = await loadOk('survey-tracker', SURVEYTRACKER_CI_YAML);
    for (const cfg of [agentHub, surveyTracker]) {
      expect(cfg.steps.length).toBeGreaterThan(0);
      for (const step of cfg.steps) {
        expect(step.name).toBeTruthy();
        expect(step.run.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
