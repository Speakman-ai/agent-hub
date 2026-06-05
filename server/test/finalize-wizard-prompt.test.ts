/**
 * Contract test for the Finalize ci.yaml setup wizard kickoff prompt.
 *
 * The PR #1179 round-2 reviewer asked for a regression test (analogous
 * to `preview-wizard-prompt.test.ts`) that pins the shape of the prompt
 * the route builds and ships to the spawned wizard session. The
 * preview-wizard test already caught a real prod bug where SKILL.md
 * referenced shell env vars that were never bound; this test guards
 * against the same class of failure for finalize.
 *
 * Specifically pinned:
 *
 *   1. The prompt declares it is a guided walkthrough and has a
 *      "Bound values" header.
 *   2. `PROJECT_ID` and `PROJECT_CWD` appear with the literal values
 *      passed in (caller can grep for them in the rendered prompt).
 *   3. The session is framed as a normal worktree-backed session that
 *      commits, verifies, pushes, and opens a PR — and the wizard's own
 *      `SESSION_ID` is bound so the agent passes its own id to
 *      setup-apply (never demanding a different session).
 *   4. The draft JSON is embedded under a "Server-provided draft"
 *      heading and the agent is told NOT to re-run the scanners.
 *   5. The skill is loaded via the `<agenthub:skill>` gateway block
 *      with name `finalize-setup`.
 *   6. The "Required walkthrough order" is documented through the
 *      verify-in-worktree + push + PR steps.
 *   7. The prompt does NOT promote any made-up shell env vars — every
 *      bound value is in the prompt itself, not implied via env. This
 *      matches the failure mode that triggered the preview-wizard test.
 *   8. The exported `FINALIZE_SETUP_SKILL_SCRIPTS_DIR` constant
 *      resolves to a real directory that holds the shipped scanner
 *      script (`scan-ci-signals.sh`). Mirrors the preview-setup
 *      "FINALIZE_*_DIR exists" guard.
 *
 * Note: unlike the preview-wizard prompt, the finalize wizard does NOT
 * embed a `SKILL_SCRIPTS_DIR` bound value into the prompt — the skill
 * already loads its scripts via the `<agenthub:skill>` gateway and the
 * agent uses Read/Bash directly. The reviewer suggested asserting on
 * such a binding, but the prompt simply doesn't emit it, and we don't
 * want to mock a feature into existence just to test it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'fs';
import path from 'path';
import './setup.js';
import { buildKickoffPrompt, FINALIZE_SETUP_SKILL_SCRIPTS_DIR } from '../routes/finalize-wizard.js';
import type { FinalizeSetupDraft } from '../finalize-setup-draft.js';

const sampleDraft: FinalizeSetupDraft = {
  existingCi: false,
  existingCiContent: null,
  stack: 'node',
  packageManager: 'npm',
  isMonorepo: false,
  subprojects: [{ path: '.', manifest: 'package.json', manager: 'npm' }],
  githubWorkflows: ['ci.yml'],
  makefileTargets: [],
  npmScripts: [
    { name: 'test', body: 'vitest', kind: 'test' },
    { name: 'lint', body: 'eslint .', kind: 'lint' },
  ],
  readme: {
    readmePath: '/srv/workspaces/demo/README.md',
    setupExcerpt: null,
    hasDockerHints: false,
    envKeysFromReadme: [],
  },
  envVars: [{ key: 'API_KEY', sources: ['source'], required: false }],
  proposedCiYaml:
    'version: 1\non:\n  - finalize\n  - manual\nsteps:\n  - name: install\n    run: npm ci --include=dev\n  - name: test\n    run: npm test\n',
};

describe('finalize-wizard kickoff prompt', () => {
  const prompt = buildKickoffPrompt(
    'demo-project-id',
    '/srv/workspaces/demo',
    sampleDraft,
    'wizard-session-123',
  );

  it('declares guided walkthrough and bound values', () => {
    expect(prompt).toMatch(/guided walkthrough/i);
    expect(prompt).toMatch(/## Bound values/);
    expect(prompt).toMatch(/PROJECT_ID.*`demo-project-id`/);
    expect(prompt).toMatch(/PROJECT_CWD.*`\/srv\/workspaces\/demo`/);
  });

  it('frames the session as a normal worktree-backed session that ships a PR', () => {
    expect(prompt).toMatch(/normal worktree-backed session/i);
    // The session owns its worktree and commits to its OWN branch.
    expect(prompt).toMatch(/your own dedicated git worktree/i);
    expect(prompt).toMatch(/open a (pull request|PR)/i);
  });

  it('binds the session id so the agent passes its own id to setup-apply', () => {
    expect(prompt).toMatch(/YOUR SESSION_ID/);
    expect(prompt).toMatch(/`wizard-session-123`/);
  });

  it('never tells the agent to hunt for or supply a different session_id', () => {
    // Regression: the wizard used to demand a session_id / "start a
    // card-linked session first" even though it now owns its worktree.
    expect(prompt).toMatch(/this session IS the working session/i);
    expect(prompt).not.toMatch(/start a (different|card-linked) session/i);
    expect(prompt).not.toMatch(/Pick a different session/i);
  });

  it('embeds the draft JSON and tells the agent NOT to rescan', () => {
    expect(prompt).toMatch(/Server-provided draft \(do NOT re-run scanners\)/);
    expect(prompt).toMatch(/"stack":\s*"node"/);
    expect(prompt).toMatch(/"packageManager":\s*"npm"/);
    expect(prompt).toMatch(/proposedCiYaml/);
  });

  it('documents the full walkthrough order through verify + push + PR', () => {
    expect(prompt).toMatch(/## Required walkthrough order/);
    expect(prompt).toMatch(/1\. \*\*Summarise the repo\*\*/);
    expect(prompt).toMatch(/2\. \*\*Existing config\*\*/);
    expect(prompt).toMatch(/3\. \*\*Monorepo \/ sub-projects\*\*/);
    expect(prompt).toMatch(/4\. \*\*Pipeline proposal\*\*/);
    expect(prompt).toMatch(/5\. \*\*Env vars \/ secrets\*\*/);
    expect(prompt).toMatch(/6\. \*\*Confirm with the user\*\*/);
    expect(prompt).toMatch(/7\. \*\*Commit\*\*/);
    // The whole point of the worktree: run the configured steps locally.
    expect(prompt).toMatch(/8\. \*\*Verify in your worktree\*\*/);
    expect(prompt).toMatch(/9\. \*\*Push \+ open a PR\*\*/);
    expect(prompt).toMatch(/10\. \*\*`POST .*wizard-complete`\*\*/);
  });

  it('teaches v2 per-job fan-out as the GHA-parity default in the proposal step', () => {
    // The wizard must prefer v2 concurrent jobs (one per GitHub job on
    // the DinD fleet) whenever the repo runs more than one CI lane, and
    // must never group/serialize/drop jobs to save runners.
    expect(prompt).toMatch(/Prefer v2/i);
    expect(prompt).toMatch(/concurrent `jobs:`/);
    expect(prompt).toMatch(/one v2 `job` per GitHub job/i);
    expect(prompt).toMatch(/matrix\.include/);
    expect(prompt).toMatch(/Do NOT group, serialize, or drop jobs/i);
    expect(prompt).toMatch(/FINALIZE_MATRIX_/);
  });

  it('keeps schema guardrails (shared constraints + banned fields) in the proposal step', () => {
    // The agent still can't emit a banned field; the prompt enumerates
    // the shared constraints and the per-version env/matrix rules.
    expect(prompt).toMatch(/`on:` must be `finalize`\/`manual`/);
    expect(prompt).toMatch(/`timeout_minutes` in `\[1, 240\]`/);
    // shell/uses/with banned at every version; env/matrix are v2-only.
    expect(prompt).toMatch(/Never\*\* propose `shell:`, `uses:`, or `with:`/);
    expect(prompt).toMatch(/At \*\*v1\*\*, `env:` and `matrix:` are also rejected/);
  });

  it('documents CI replacement mode so the wizard does not refuse complex steps', () => {
    expect(prompt).toMatch(/CI replacement mode/i);
    expect(prompt).toMatch(/replace GitHub Actions CI/i);
    expect(prompt).toMatch(/stop downgrading scope/i);
    expect(prompt).toMatch(/Never.*refuse, argue feasibility, or shrink/i);
  });

  it('loads the finalize-setup skill via the gateway block', () => {
    expect(prompt).toMatch(/<agenthub:skill>/);
    expect(prompt).toMatch(/"name":"finalize-setup"/);
    expect(prompt).toMatch(/<\/agenthub:skill>/);
  });

  it('does not reference made-up shell env vars for binding context', () => {
    // The preview-wizard regression test caught a prod bug where the
    // prompt referenced `$AGENT_HUB_SKILL_DIR` / `$PROJECT_WIZARD_ID`
    // style vars that were never set. Make sure none of those snuck in
    // here either — the prompt should self-contain all binding context.
    expect(prompt).not.toMatch(/\$FINALIZE_WIZARD_PROJECT_ID/);
    expect(prompt).not.toMatch(/\$AGENT_HUB_SKILL_DIR/);
    expect(prompt).not.toMatch(/\$FINALIZE_SETUP_SKILL_SCRIPTS_DIR/);
    expect(prompt).not.toMatch(/\$PROJECT_WIZARD_ID/);
  });
});

describe('FINALIZE_SETUP_SKILL_SCRIPTS_DIR exported constant', () => {
  it('resolves to a real directory that ships the scan script', () => {
    // The PR #1179 round-2 reviewer asked us to confirm the directory
    // constant resolves — guards against a refactor that moves the
    // skill files and leaves this constant pointing at nothing. The
    // wizard route imports this constant; if it ever 404s, the agent's
    // shelled-out `scripts/scan-ci-signals.sh` call would fail.
    expect(existsSync(FINALIZE_SETUP_SKILL_SCRIPTS_DIR)).toBe(true);
    expect(statSync(FINALIZE_SETUP_SKILL_SCRIPTS_DIR).isDirectory()).toBe(true);
    const scanScript = path.join(FINALIZE_SETUP_SKILL_SCRIPTS_DIR, 'scan-ci-signals.sh');
    expect(existsSync(scanScript)).toBe(true);
  });
});
