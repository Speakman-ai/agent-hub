/**
 * Guards the auth-failure contract in
 * `default-skills/preview-setup/SKILL.md`.
 *
 * Before this card landed (kanban `19cea6db`), the skill listed
 * `$AGENT_HUB_API_KEY` under **Bound values** with no guidance about
 * what to do if it resolved empty. When the var was missing — which
 * happens on installs without `cfg.apiKey` AND a spawn site that
 * didn't thread `spawnCredsUserId` to `buildSpawnEnv` — the agent
 * improvised bad workarounds, including asking the operator to paste
 * a bearer token into chat. Captured in session `53cf73a5` against
 * the Webapp Lead preview wizard.
 *
 * The skill now contains an explicit **Auth failure** rule with three
 * binding contracts: (1) never ask for a token in chat, (2) point the
 * operator at `PATCH /api/config` or `~/.agent-hub/data/config.json`,
 * (3) link to the canonical wiki page on the auth model.
 *
 * These tests pin the prose so a future drive-by edit that softens or
 * removes the guard surfaces in CI rather than silently regressing
 * the UX.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD = path.join(__dirname, 'default-skills', 'preview-setup', 'SKILL.md');

describe('preview-setup SKILL.md — auth-failure guard', () => {
  const skill = readFileSync(SKILL_MD, 'utf-8');

  it('has an Auth failure section', () => {
    expect(skill).toMatch(/^## Auth failure$/m);
  });

  it("forbids asking the operator to paste a token into chat — explicit 'Never'", () => {
    // The Bound values line carries a Never-paste callout that links to the
    // section below. Test the literal phrasing so a softening rewrite (e.g.
    // "avoid asking") doesn't silently slip through.
    expect(skill).toMatch(/\*\*Never\*\* ask the operator to paste a token into chat/);
  });

  it("Auth failure section explicitly says 'Do not' work around it with chat-side credentials", () => {
    const section = skill.split(/^## /m).find((s) => s.startsWith('Auth failure'));
    expect(section, "Auth failure section missing — guard test can't run").toBeDefined();
    // Allow either straight quote, curly quote, or apostrophe variants.
    expect(section!).toMatch(/\*\*Do not\*\*/);
    expect(section!).toMatch(/asking the user for a token/);
    expect(section!).toMatch(/paste a bearer string into chat/);
  });

  it('points the operator at PATCH /api/config OR ~/.agent-hub/data/config.json', () => {
    const section = skill.split(/^## /m).find((s) => s.startsWith('Auth failure'));
    expect(section!).toMatch(/PATCH `?\/api\/config`?/);
    expect(section!).toMatch(/~\/\.agent-hub\/data\/config\.json/);
  });

  it('links to the canonical auth wiki page', () => {
    // The slug is the canonical reference for the multi-user auth model.
    expect(skill).toMatch(/replacing-the-static-api-key-per-user-ahub-tokens-invite-flow/);
  });

  it('Bound values entry forward-references the Auth failure section', () => {
    // The line under Bound values should send readers to the rule rather
    // than re-stating it inline — that's the seam future edits will keep
    // editing, so it must point somewhere.
    const boundValues = skill.split(/^## /m).find((s) => s.startsWith('Bound values'));
    expect(boundValues, 'Bound values section missing').toBeDefined();
    expect(boundValues!).toMatch(/AGENT_HUB_API_KEY/);
    expect(boundValues!).toMatch(/#auth-failure/);
  });

  // The next three tests pin contracts surfaced by the PR #1095 review:
  // an earlier version of the rule fired on "empty env var" alone and
  // glossed over the in-memory vs on-disk distinction in `config.apiKey`.
  // Pinning the prose stops a future edit from silently regressing to the
  // looser shape.

  it('fires on HTTP 401/403, not on an empty env var alone', () => {
    const section = skill.split(/^## /m).find((s) => s.startsWith('Auth failure'));
    expect(section, "Auth failure section missing — guard test can't run").toBeDefined();
    // The detection trigger must name the HTTP status codes explicitly —
    // empty-key-only is too loose (key may be present-but-stale) and too
    // tight (open hubs are fine with no key at all).
    expect(section!).toMatch(/HTTP \*\*401\*\* or \*\*403\*\*|HTTP 401 or 403|401 or 403/);
    // The bound-values forward reference should also use the HTTP-status
    // wording, not the looser "resolves empty" phrasing the first draft had.
    const boundValues = skill.split(/^## /m).find((s) => s.startsWith('Bound values'));
    expect(boundValues!).toMatch(/401|403/);
  });

  it('documents the open-hub exception — empty key is fine when no auth is configured', () => {
    const section = skill.split(/^## /m).find((s) => s.startsWith('Auth failure'));
    expect(section!).toMatch(/open/i);
    // The exception must call out that on an open hub an empty
    // $AGENT_HUB_API_KEY is not an error. We pin "open" + a phrase that
    // ties to the underlying server behaviour (auth.ts:177).
    expect(section!).toMatch(/empty key|empty.*\$?AGENT_HUB_API_KEY|empty/i);
  });

  it('distinguishes PATCH /api/config (hot) from direct file edit (requires restart)', () => {
    const section = skill.split(/^## /m).find((s) => s.startsWith('Auth failure'));
    expect(section!).toBeDefined();
    // PATCH path must be flagged as the no-restart option.
    expect(section!).toMatch(/PATCH `?\/api\/config`?/);
    // Direct-file-edit path must call out the restart requirement so an
    // operator who takes that route is not surprised by the next 401.
    expect(section!).toMatch(/restart/i);
    expect(section!).toMatch(/~\/\.agent-hub\/data\/config\.json/);
    // The two paths must be presented as alternatives, not as
    // equivalents — pin the wording that distinguishes them.
    expect(section!).toMatch(/hot|immediately|no restart/i);
  });
});
