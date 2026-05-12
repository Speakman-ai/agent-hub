/**
 * Contract test for the preview-setup wizard kickoff prompt.
 *
 * The reviewer pinned a real bug: SKILL.md referenced shell env vars
 * (`$PREVIEW_WIZARD_PROJECT_ID`, `$AGENT_HUB_SKILL_DIR`, etc.) that the
 * route never set, so every curl URL and scanner path expanded to an
 * empty string at runtime. The fix is to surface those values as a
 * literal "bound values" block in the kickoff prompt so the agent
 * substitutes them inline. This test pins both halves:
 *
 *   1. The prompt body contains a "Bound values" header.
 *   2. Each of PROJECT_ID, PROJECT_CWD, SKILL_SCRIPTS_DIR appears
 *      verbatim (so the agent can find them by name).
 *   3. The skill is loaded via the `<agenthub:skill>` block.
 *   4. The prompt explicitly tells the agent NOT to rely on the
 *      historical env-var names — defense in depth against the
 *      blueprint regressing in either direction.
 *   5. PREVIEW_SETUP_SKILL_SCRIPTS_DIR resolves to a real directory on
 *      disk that holds both scanner scripts. Renaming or moving the
 *      directory breaks the wizard in production silently otherwise.
 */
import { existsSync, statSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import './setup.js';
import { buildKickoffPrompt, PREVIEW_SETUP_SKILL_SCRIPTS_DIR } from '../routes/preview-wizard.js';

describe('preview-wizard kickoff prompt', () => {
  const prompt = buildKickoffPrompt(
    'demo-project-id',
    '/srv/workspaces/demo',
    '/srv/skill-scripts/preview-setup',
  );

  it('declares a Bound values section', () => {
    expect(prompt).toMatch(/Bound values/);
  });

  it('embeds PROJECT_ID, PROJECT_CWD, and SKILL_SCRIPTS_DIR verbatim', () => {
    expect(prompt).toMatch(/PROJECT_ID.*`demo-project-id`/);
    expect(prompt).toMatch(/PROJECT_CWD.*`\/srv\/workspaces\/demo`/);
    expect(prompt).toMatch(/SKILL_SCRIPTS_DIR.*`\/srv\/skill-scripts\/preview-setup`/);
  });

  it('warns against the historical env-var names', () => {
    expect(prompt).toMatch(/\$PREVIEW_WIZARD_PROJECT_ID/);
    expect(prompt).toMatch(/\$PREVIEW_WIZARD_CWD/);
    expect(prompt).toMatch(/\$AGENT_HUB_SKILL_DIR/);
    expect(prompt).toMatch(/NOT set/i);
  });

  it('loads the preview-setup skill via the gateway block', () => {
    expect(prompt).toMatch(/<agenthub:skill>/);
    expect(prompt).toMatch(/"name":"preview-setup"/);
    expect(prompt).toMatch(/<\/agenthub:skill>/);
  });
});

describe('PREVIEW_SETUP_SKILL_SCRIPTS_DIR', () => {
  it('resolves to the on-disk skill scripts directory', () => {
    expect(existsSync(PREVIEW_SETUP_SKILL_SCRIPTS_DIR)).toBe(true);
    expect(statSync(PREVIEW_SETUP_SKILL_SCRIPTS_DIR).isDirectory()).toBe(true);
  });

  it('ships both scanner scripts at the resolved path', () => {
    const envScan = path.join(PREVIEW_SETUP_SKILL_SCRIPTS_DIR, 'scan-env-usage.sh');
    const pkgScan = path.join(PREVIEW_SETUP_SKILL_SCRIPTS_DIR, 'scan-package-scripts.sh');
    expect(existsSync(envScan)).toBe(true);
    expect(existsSync(pkgScan)).toBe(true);
  });
});
