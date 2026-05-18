/**
 * Regression test for the reviewer "You've hit your limit" production bug:
 * reviewer sessions store `owner_user_id = NULL` on purpose (so the
 * thread is shared/read-only across the org), but `chat.ts` then skipped
 * per-user Claude / Cursor / Gemini / Codex creds entirely on NULL and
 * fell straight through to the host-wide `config.anthropicApiKey`.
 * Operators who had configured their own un-throttled per-account
 * Anthropic OAuth token via Settings still saw the reviewer hammer the
 * shared host subscription until it 429'd.
 *
 * The fix wires `resolveSpawnCredsOwnerUserId` (session-ownership.ts)
 * between `getSessionOwner` and the per-user CLI auth lookup so that
 * NULL falls back to the org owner. Identity-bearing branches (GitHub
 * token attribution, per-session ownership writes, per-user MCP)
 * deliberately keep gating on the persisted owner — see the comment
 * block above the resolver call in `chat.ts`.
 *
 * This file walks the resolver → users-store → buildSpawnEnv chain
 * end-to-end so a future refactor that drops the org-owner fallback
 * (or accidentally swaps `credsOwnerId` back to `ownerId` in the
 * lookup) shows up as a red test instead of a silent 429 on prod.
 */

import './test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import config, { buildSpawnEnv } from './config.js';
import { resolveSpawnCredsOwnerUserId, resetOrgOwnerCache } from './session-ownership.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser, getUserClaudeAuth, setUserClaudeAuth } from './users-store.js';

const HOST_OAUTH = 'sk-ant-oat01-host-shared-subscription';
const USER_OAUTH = 'sk-ant-oat01-user-personal-quota';
const USER_API_KEY = 'sk-ant-api03-user-personal';

describe('reviewer spawn creds — NULL session owner falls back to org owner', () => {
  let orgOwnerId: string;
  let savedHostOauth: string | null;
  let savedHostApiKey: string | null;

  beforeEach(() => {
    // Fresh orgs.db per spec so the seeded "first user" cleanly maps to
    // getOrgOwnerUserId(). The shared test/setup.ts does not init orgs.db.
    const dir = mkdtempSync(path.join(tmpdir(), 'reviewer-spawn-creds-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
    orgOwnerId = createUser({
      username: `org-owner-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
    resetOrgOwnerCache();

    // Stash host-config Claude creds so per-spec mutation does not bleed
    // into sibling suites.
    savedHostOauth = config.claudeCodeOAuthToken;
    savedHostApiKey = config.anthropicApiKey;
  });

  afterEach(() => {
    config.claudeCodeOAuthToken = savedHostOauth;
    config.anthropicApiKey = savedHostApiKey;
  });

  it('reviewer-style spawn (ownerId=null) bills to the org owner instead of host config', () => {
    // The production setup: operator filed a personal OAuth token via
    // the per-user Settings panel. The host config still carries the
    // old global subscription token that has hit its rate limit.
    setUserClaudeAuth(orgOwnerId, { claudeCodeOAuthToken: USER_OAUTH });
    config.claudeCodeOAuthToken = HOST_OAUTH;
    config.anthropicApiKey = null;

    // Step 1: chat.ts reads `ownerId = getSessionOwner(sessionId)` — for
    // a reviewer session that is NULL because the webhook handler
    // deliberately leaves the column blank.
    const ownerId: string | null = null;

    // Step 2: chat.ts then asks the resolver which user should pay for
    // this spawn's CLI tokens. Pre-fix this expression was just
    // `ownerId`, i.e. null, and the per-user lookup was skipped.
    const credsOwnerId = resolveSpawnCredsOwnerUserId(ownerId);
    expect(credsOwnerId).toBe(orgOwnerId);

    // Step 3: chat.ts looks up the per-user creds keyed off credsOwnerId.
    const userClaude = getUserClaudeAuth(credsOwnerId!);
    expect(userClaude?.claudeCodeOAuthToken).toBe(USER_OAUTH);

    // Step 4: buildSpawnEnv injects the override. The user's token must
    // win over the host's rate-limited one.
    const env = buildSpawnEnv(config, {
      userOverride: {
        anthropicApiKey: userClaude?.anthropicApiKey ?? null,
        claudeCodeOAuthToken: userClaude?.claudeCodeOAuthToken ?? null,
      },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(USER_OAUTH);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(HOST_OAUTH);
  });

  it('user with only an API key (no OAuth) also flows through', () => {
    // Settings exposes both fields independently — operators may store
    // only ANTHROPIC_API_KEY without an OAuth token. The chain must
    // still pick it up for the reviewer.
    setUserClaudeAuth(orgOwnerId, { anthropicApiKey: USER_API_KEY });
    config.anthropicApiKey = 'sk-ant-api03-host';
    config.claudeCodeOAuthToken = null;

    const credsOwnerId = resolveSpawnCredsOwnerUserId(null);
    const userClaude = getUserClaudeAuth(credsOwnerId!);
    const env = buildSpawnEnv(config, {
      userOverride: {
        anthropicApiKey: userClaude?.anthropicApiKey ?? null,
        claudeCodeOAuthToken: userClaude?.claudeCodeOAuthToken ?? null,
      },
    });
    expect(env.ANTHROPIC_API_KEY).toBe(USER_API_KEY);
  });

  it('no regression: NULL owner + unconfigured org owner stays on host config', () => {
    // The operator never visited per-user Settings. The reviewer must
    // continue to use the host config exactly as it did before the fix
    // — no environment churn, no missing-credential failures.
    config.claudeCodeOAuthToken = HOST_OAUTH;
    config.anthropicApiKey = null;

    const credsOwnerId = resolveSpawnCredsOwnerUserId(null);
    // Org owner exists but has no per-user creds stored.
    expect(credsOwnerId).toBe(orgOwnerId);
    const userClaude = getUserClaudeAuth(credsOwnerId!);
    expect(userClaude?.claudeCodeOAuthToken ?? null).toBeNull();
    expect(userClaude?.anthropicApiKey ?? null).toBeNull();

    // chat.ts only assembles `userOverride` when at least one user
    // field is populated (the `hasAny` guard). With none, the call to
    // buildSpawnEnv passes no override → host config wins.
    const env = buildSpawnEnv(config /* no override */);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_OAUTH);
  });

  it('persisted owner ALWAYS wins over the org-owner fallback (no rewriting attributable sessions)', () => {
    // An interactive session owned by `user-alice` must bill to alice
    // even when `orgOwnerId` has different creds stashed. The fallback
    // is for NULL only.
    const alice = createUser({
      username: `alice-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
    setUserClaudeAuth(orgOwnerId, { claudeCodeOAuthToken: 'sk-ant-oat01-owner' });
    setUserClaudeAuth(alice, { claudeCodeOAuthToken: 'sk-ant-oat01-alice' });

    const credsOwnerId = resolveSpawnCredsOwnerUserId(alice);
    expect(credsOwnerId).toBe(alice);
    const userClaude = getUserClaudeAuth(credsOwnerId!);
    expect(userClaude?.claudeCodeOAuthToken).toBe('sk-ant-oat01-alice');
  });
});
