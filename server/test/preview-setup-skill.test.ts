/**
 * Coverage guard for the `preview-setup` default skill.
 *
 * Pins the SKILL.md frontmatter shape (so the skill loader can index
 * it) and the surfaces the wizard skill MUST keep documented:
 *   - calls the static `preview/detect` endpoint as a baseline
 *   - runs the env-usage and package-scripts scanner helpers
 *   - emits exactly one `agenthub:ask` block
 *   - persists via PATCH /api/projects/:id + the secrets import route
 *   - pings the wizard-complete broadcast endpoint at the end
 */
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'preview-setup');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

describe('preview-setup default skill — SKILL.md frontmatter', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('has a parseable YAML frontmatter with name/description/version', () => {
    const body = readFileSync(SKILL_MD, 'utf8');
    // Frontmatter must be the first thing in the file and bracketed by
    // `---` lines. Match minimally — actual schema validation lives in
    // the skill loader's own tests.
    const match = body.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const fm = match![1];
    expect(fm).toMatch(/^name:\s*preview-setup\s*$/m);
    expect(fm).toMatch(/^description:/m);
    expect(fm).toMatch(/^version:\s*\d+\.\d+\.\d+\s*$/m);
  });

  it('frontmatter description mentions the wizard role and the trigger', () => {
    const fm = readFileSync(SKILL_MD, 'utf8').match(/^---\n([\s\S]*?)\n---\n/)![1];
    expect(fm).toMatch(/wizard/i);
    expect(fm).toMatch(/TRIGGER/);
    expect(fm).toMatch(/setup-wizard/);
  });

  it('body documents the required step surfaces', () => {
    const body = readFileSync(SKILL_MD, 'utf8');
    expect(body).toMatch(/preview\/detect/);
    expect(body).toMatch(/scan-env-usage\.sh/);
    expect(body).toMatch(/scan-package-scripts\.sh/);
    expect(body).toMatch(/agenthub:ask/);
    expect(body).toMatch(/preview\/secrets\/import/);
    expect(body).toMatch(/PATCH/);
    expect(body).toMatch(/preview\/wizard-complete/);
    expect(body).toMatch(/agenthub:close-card/);
  });

  it('ships executable helper scripts', () => {
    const envScan = path.join(SKILL_DIR, 'scripts', 'scan-env-usage.sh');
    const pkgScan = path.join(SKILL_DIR, 'scripts', 'scan-package-scripts.sh');
    expect(existsSync(envScan)).toBe(true);
    expect(existsSync(pkgScan)).toBe(true);
    // Executable bit on owner (0o100). This matters because the SKILL.md
    // tells the agent to invoke the scripts directly.
    expect(statSync(envScan).mode & 0o100).toBeTruthy();
    expect(statSync(pkgScan).mode & 0o100).toBeTruthy();
  });

  it('body uses placeholder substitution syntax (not undefined shell env vars)', () => {
    // The route writes PROJECT_ID / PROJECT_CWD / SKILL_SCRIPTS_DIR into
    // the kickoff prompt as "bound values". It does NOT export them as
    // shell env vars — adding new keys to EXTRA_ENV_ALLOWLIST is the
    // only path for that and we deliberately keep it tight. So the
    // skill body MUST reference `<PROJECT_ID>` placeholders (which the
    // agent substitutes from the prompt) and MUST NOT reference the
    // historical `$PREVIEW_WIZARD_*` / `$AGENT_HUB_SKILL_DIR` shell
    // variables, which would expand to empty strings at runtime and
    // break every curl URL + scanner path.
    const body = readFileSync(SKILL_MD, 'utf8');
    expect(body).toMatch(/<PROJECT_ID>/);
    expect(body).toMatch(/<PROJECT_CWD>/);
    expect(body).toMatch(/<SKILL_SCRIPTS_DIR>/);
    expect(body).not.toMatch(/\$PREVIEW_WIZARD_PROJECT_ID/);
    expect(body).not.toMatch(/\$PREVIEW_WIZARD_CWD/);
    expect(body).not.toMatch(/\$AGENT_HUB_SKILL_DIR/);
  });
});
