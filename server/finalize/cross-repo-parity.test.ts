/**
 * Cross-repo parity: the ci.yaml parser produces an orchestrator-usable
 * config for both the agent-hub repo and the webapp reference,
 * even when they target different schema versions.
 *
 * Card 5df552ec — "Roll out Finalize Code Changes to webapp repo
 * (second dogfood)" — has as its last acceptance criterion:
 *
 *   "Cross-repo behavior parity: same step failure on both repos produces
 *    the same fix-dispatch shape and the same metric labels."
 *
 * The fix-dispatch module (`fix-dispatch.ts`) is repo-agnostic by design
 * — a `grep -n 'repo\|github\|metric'` against the file produces zero
 * hits. The behavioural property we want to pin is the layer ONE level
 * above: that the parser hands the orchestrator a usable config
 * regardless of which repo's file it loaded.
 *
 * Originally both files were v1; the v2-per-job-parity rollout migrated
 * agent-hub's own ci.yaml to `version: 2` (concurrent fan-out onto the
 * DinD fleet) while webapp's reference fixture stays at v1
 * (single-runner pipeline). The orchestrator already branches on
 * version, so the parity we still care about is what survives the
 * version skew:
 *
 *   1. Both parse with `ok: true`. If either fails, the failure mode
 *      surfaces here rather than at first finalize-click against the
 *      other repo.
 *
 *   2. Both declare the `finalize` trigger. The trigger set is the
 *      orchestrator's entry-point contract and is version-agnostic.
 *
 *   3. Both have `timeoutMinutes` inside the parser-enforced ceiling
 *      [1, 240]. The ceiling is the same field at v1 and v2 — a config
 *      may lower the active-time cap but never raise it.
 *
 *   4. Every executable step on every repo has a non-empty `name` and
 *      `run`. At v1 the steps live at `cfg.steps`; at v2 they live
 *      inside `cfg.jobs[id].steps` and we walk every job's step list.
 *
 * What this test deliberately does NOT assert:
 *
 *   - That both files use the same schema version. The PR that landed
 *     v2 on agent-hub but left webapp at v1 makes version skew
 *     an expected, not pathological, state. If either file regresses
 *     (e.g. agent-hub falls back to v1 unintentionally), the companion
 *     per-repo tests catch that.
 *
 *   - That the step sets are identical. They MUST differ (different
 *     stack: npm/tsc/vitest on agent-hub, venv/Angular/Cypress on
 *     webapp). The card's parity AC is about the orchestrator's
 *     output shape on failure, not about the input commands.
 *
 * The companion per-repo tests (`repo-ci-yaml.test.ts` for agent-hub
 * and `repo-ci-yaml-example-webapp.test.ts` for webapp)
 * pin the per-repo step/job contracts; this test pins what's COMMON
 * across schema versions.
 */

import path from 'path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { loadCiConfigFromFile, type AnyCiConfig, type CiStep } from './ci-config.js';

const __filename = fileURLToPath(import.meta.url);

// agent-hub's own ci.yaml lives at `<repo>/.agent-hub/ci.yaml`.
// This test file is at `<repo>/server/finalize/cross-repo-parity.test.ts`,
// so two parent hops gets us to the repo root.
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const AGENT_HUB_CI_YAML = path.join(REPO_ROOT, '.agent-hub', 'ci.yaml');

// The webapp reference is a fixture in this repo (the real
// commit lives in the webapp repo and is shipped by a separate
// session — see the card 5df552ec follow-ups).
const WEBAPP_CI_YAML = path.join(path.dirname(__filename), 'fixtures', 'example-webapp.ci.yaml');

// Helper: load + assert ok, returning the CiConfig (or throwing with a
// clear test-failure message that pinpoints which file is broken).
// Version-agnostic — the orchestrator branches on version downstream;
// what this helper guarantees is "parsed successfully into something
// the orchestrator can read."
async function loadOk(label: string, file: string): Promise<AnyCiConfig> {
  const result = await loadCiConfigFromFile(file);
  if (!result.ok) {
    throw new Error(
      `${label} ci.yaml failed to parse: code=${result.error.code} ` +
        `path=${result.error.path ?? '(root)'} message=${result.error.message}`,
    );
  }
  return result.config;
}

// Helper: flatten every executable step from a parsed config. At v1 the
// steps sit at `cfg.steps`; at v2 they sit inside `cfg.jobs[id].steps`
// for every job. Returning a flat list keeps the per-step invariants
// readable without leaking the version branch into each assertion.
function allSteps(cfg: AnyCiConfig): CiStep[] {
  if (cfg.version === 1) return cfg.steps;
  return Object.values(cfg.jobs).flatMap((job) => job.steps);
}

describe('cross-repo parity: agent-hub vs webapp ci.yaml', () => {
  it('both files parse cleanly into a usable orchestrator config', async () => {
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const webapp = await loadOk('webapp', WEBAPP_CI_YAML);
    // The orchestrator only branches on `version`; what we pin here is
    // that both files yielded a parsed config with one of the supported
    // versions. Version skew (one v1, one v2) is allowed by design.
    expect([1, 2]).toContain(agentHub.version);
    expect([1, 2]).toContain(webapp.version);
  });

  it('both files declare the finalize trigger (orchestrator needs it)', async () => {
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const webapp = await loadOk('webapp', WEBAPP_CI_YAML);
    expect(agentHub.on).toContain('finalize');
    expect(webapp.on).toContain('finalize');
  });

  it('both files have timeouts within the parser ceiling [1, 240]', async () => {
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const webapp = await loadOk('webapp', WEBAPP_CI_YAML);
    for (const cfg of [agentHub, webapp]) {
      expect(cfg.timeoutMinutes).toBeGreaterThanOrEqual(1);
      expect(cfg.timeoutMinutes).toBeLessThanOrEqual(240);
    }
  });

  it('every executable step on every repo has a non-empty name and run', async () => {
    // Both per-step invariants are also asserted by the parser, but
    // pinning them here makes the parity property obvious from this
    // test alone (no need to read ci-config.ts to trust the claim). At
    // v2 the steps come from every job, so this also guarantees the
    // fan-out matrix can't ship an empty step set.
    const agentHub = await loadOk('agent-hub', AGENT_HUB_CI_YAML);
    const webapp = await loadOk('webapp', WEBAPP_CI_YAML);
    for (const cfg of [agentHub, webapp]) {
      const steps = allSteps(cfg);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.name).toBeTruthy();
        expect(step.run.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
