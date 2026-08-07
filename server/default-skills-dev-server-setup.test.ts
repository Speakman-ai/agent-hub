/**
 * Content guard for `default-skills/dev-server-setup/SKILL.md`.
 *
 * The walkthrough used to stop at `prEnv.devServer`, which boots the process and
 * says nothing about whether the app it boots actually works. It usually does
 * not: a preview browser is on another machine, so an app that binds loopback,
 * trusts only its own Host header, points its client at `127.0.0.1`, or rejects
 * the preview Origin fails anyway. Three of those four fail *after* the preview
 * reports ready, which reads as a bug in the user's app rather than a missing
 * setup step — so the checklist has to be in the skill the wizard loads.
 *
 * The matching assertions on the kickoff prompt (which is what the agent follows
 * turn by turn) live in `test/dev-server-wizard-route.test.ts`.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(__dirname, 'default-skills', 'dev-server-setup', 'SKILL.md');

function readSkill(): string {
  return readFileSync(SKILL, 'utf8');
}

describe('dev-server-setup skill — remote-browser reachability', () => {
  it('covers all four assumptions a remote browser breaks', () => {
    const skill = readSkill();
    // 1. bind address — the only one that fails loudly (health probe timeout).
    expect(skill).toContain('0.0.0.0');
    // 2. host allowlist, across the frameworks we actually see.
    expect(skill).toContain('allowedHosts');
    expect(skill).toContain('ALLOWED_HOSTS');
    // 3. loopback API URL: page loads, every request fails.
    expect(skill).toContain('document.baseURI');
    // 4. trusted origins, or every POST 403s.
    expect(skill).toContain('CSRF_TRUSTED_ORIGINS');
  });

  it('explains where extra ports are mounted, since that is what the API URL derives from', () => {
    const skill = readSkill();
    expect(skill).toContain('/preview/proxy/');
    expect(skill).toMatch(/\/p\/<port>\//);
  });

  it('tells the agent to keep the deployment hostname out of the repo', () => {
    // The Hub's preview domain is per-deployment. A baked-in literal is worse
    // than no config: it works on exactly one host and 403s everywhere else with
    // nothing pointing at the cause.
    const skill = readSkill();
    expect(skill).toMatch(/never hardcode a deployment hostname/i);
    expect(skill).toContain('EXTRA_ALLOWED_HOSTS');
    expect(skill).toContain('devServer.env');
  });

  it('keeps local development unchanged', () => {
    // Every fix has to degrade to the current behavior when the env vars are
    // absent, or the wizard breaks the laptop workflow it was called to support.
    const skill = readSkill();
    expect(skill).toMatch(
      /unchanged for local dev|local dev is unchanged|behaves exactly as before/i,
    );
  });

  it('is honest that this step, unlike the config, edits the repo', () => {
    // The skill's own framing is "writes no repo file"; that stops being true
    // here, and an uncommitted fix is lost with the worktree.
    const skill = readSkill();
    expect(skill).toMatch(/commit/i);
  });

  it('declares a version above the config-only 1.0.0', () => {
    const version = /^version:\s*(\S+)/m.exec(readSkill())?.[1];
    expect(version).toBeDefined();
    expect(version).not.toBe('1.0.0');
  });
});
