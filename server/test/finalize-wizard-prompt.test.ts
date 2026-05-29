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
 *   3. The resolved apply target is surfaced (or the no-worktree
 *      callout when null) so the agent always tells the user which
 *      branch will receive the commit (PR #1179 round-1 fix).
 *   4. The draft JSON is embedded under a "Server-provided draft"
 *      heading and the agent is told NOT to re-run the scanners.
 *   5. The skill is loaded via the `<agenthub:skill>` gateway block
 *      with name `finalize-setup`.
 *   6. The "Required walkthrough order" is documented and includes the
 *      "Confirm target branch" step that the round-1 fix added.
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
import {
  buildKickoffPrompt,
  FINALIZE_SETUP_SKILL_SCRIPTS_DIR,
  type ResolvedApplyTarget,
} from '../routes/finalize-wizard.js';
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

const resolvedTarget: ResolvedApplyTarget = {
  sessionId: 'sess-abc',
  branch: 'feature/x',
  worktreePath: '/srv/workspaces/demo/wt',
};

describe('finalize-wizard kickoff prompt', () => {
  const promptWithTarget = buildKickoffPrompt(
    'demo-project-id',
    '/srv/workspaces/demo',
    sampleDraft,
    resolvedTarget,
  );
  const promptNoTarget = buildKickoffPrompt(
    'demo-project-id',
    '/srv/workspaces/demo',
    sampleDraft,
    null,
  );

  it('declares guided walkthrough and bound values', () => {
    expect(promptWithTarget).toMatch(/guided walkthrough/i);
    expect(promptWithTarget).toMatch(/## Bound values/);
    expect(promptWithTarget).toMatch(/PROJECT_ID.*`demo-project-id`/);
    expect(promptWithTarget).toMatch(/PROJECT_CWD.*`\/srv\/workspaces\/demo`/);
  });

  it('surfaces the resolved apply target so the agent can confirm it (PR #1179 round 1)', () => {
    expect(promptWithTarget).toMatch(/RESOLVED COMMIT TARGET/);
    expect(promptWithTarget).toMatch(/session sess-abc/);
    expect(promptWithTarget).toMatch(/feature\/x/);
    expect(promptWithTarget).toMatch(/\/srv\/workspaces\/demo\/wt/);
    // Heads-up callout about apply-time re-resolution.
    expect(promptWithTarget).toMatch(/re-resolution at apply time/i);
  });

  it('signals the no-worktree fallback when target is null', () => {
    expect(promptNoTarget).toMatch(/no worktree-bearing session found yet/i);
    // Even when target is null, the heads-up callout still appears so
    // the agent never forgets to confirm whatever lands at apply time.
    expect(promptNoTarget).toMatch(/re-resolution at apply time/i);
  });

  it('embeds the draft JSON and tells the agent NOT to rescan', () => {
    expect(promptWithTarget).toMatch(/Server-provided draft \(do NOT re-run scanners\)/);
    expect(promptWithTarget).toMatch(/"stack":\s*"node"/);
    expect(promptWithTarget).toMatch(/"packageManager":\s*"npm"/);
    expect(promptWithTarget).toMatch(/proposedCiYaml/);
  });

  it('documents the full walkthrough order including the PR #1179 round-1 confirm step', () => {
    expect(promptWithTarget).toMatch(/## Required walkthrough order/);
    expect(promptWithTarget).toMatch(/1\. \*\*Summarise the repo\*\*/);
    expect(promptWithTarget).toMatch(/2\. \*\*Existing config\*\*/);
    expect(promptWithTarget).toMatch(/3\. \*\*Monorepo \/ sub-projects\*\*/);
    expect(promptWithTarget).toMatch(/4\. \*\*Step proposal\*\*/);
    expect(promptWithTarget).toMatch(/5\. \*\*Env vars\*\*/);
    // Round-1 fix: confirm-before-apply guard.
    expect(promptWithTarget).toMatch(/6\. \*\*Confirm target branch\*\*/);
    expect(promptWithTarget).toMatch(/7\. \*\*Persist\*\*/);
    expect(promptWithTarget).toMatch(/8\. \*\*`POST .*wizard-complete`\*\*/);
  });

  it('hard-codes the v1 schema constraints into the proposal step', () => {
    // The reviewer's round-2 worry was that the wizard might propose
    // schema-invalid YAML. The prompt itself enumerates the v1
    // constraints so the agent can't quietly emit a banned field.
    expect(promptWithTarget).toMatch(/`version: 1`/);
    expect(promptWithTarget).toMatch(/`on:` of `finalize`\/`manual`/);
    expect(promptWithTarget).toMatch(/`name`\+`run` per step only/);
    expect(promptWithTarget).toMatch(/`timeout_minutes` in `\[1, 60\]`/);
    expect(promptWithTarget).toMatch(/Never.*propose.*shell:.*env:.*uses:.*with:.*matrix:/);
  });

  it('loads the finalize-setup skill via the gateway block', () => {
    expect(promptWithTarget).toMatch(/<agenthub:skill>/);
    expect(promptWithTarget).toMatch(/"name":"finalize-setup"/);
    expect(promptWithTarget).toMatch(/<\/agenthub:skill>/);
  });

  it('does not reference made-up shell env vars for binding context', () => {
    // The preview-wizard regression test caught a prod bug where the
    // prompt referenced `$AGENT_HUB_SKILL_DIR` / `$PROJECT_WIZARD_ID`
    // style vars that were never set. Make sure none of those snuck in
    // here either — the prompt should self-contain all binding context.
    expect(promptWithTarget).not.toMatch(/\$FINALIZE_WIZARD_PROJECT_ID/);
    expect(promptWithTarget).not.toMatch(/\$AGENT_HUB_SKILL_DIR/);
    expect(promptWithTarget).not.toMatch(/\$FINALIZE_SETUP_SKILL_SCRIPTS_DIR/);
    expect(promptWithTarget).not.toMatch(/\$PROJECT_WIZARD_ID/);
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
