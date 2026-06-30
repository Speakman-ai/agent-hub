import os from 'os';
import path from 'path';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveOAuthAppCredentials,
  applyGithubSpawnCredentials,
  applyReviewerSpawnIsolation,
  applyReviewerRoleLock,
  ensureReviewerGhConfigDir,
  resolveReviewerGhConfigDir,
  REVIEWER_GH_CONFIG_DIR_NAME,
} from './spawn-github-credentials.js';
import type { AppConfig } from './types.js';

type CredsConfig = Pick<AppConfig, 'personalOAuth'>;

function makeConfig(over: Partial<CredsConfig> = {}): CredsConfig {
  return {
    personalOAuth: null,

    ...over,
  };
}

describe('resolveOAuthAppCredentials', () => {
  it('returns null when personalOAuth is missing or incomplete', () => {
    expect(resolveOAuthAppCredentials(makeConfig())).toBeNull();
    expect(
      resolveOAuthAppCredentials(
        makeConfig({ personalOAuth: { clientId: 'id-only', clientSecret: '' } }),
      ),
    ).toBeNull();
  });

  it('returns personalOAuth credentials when both fields are set', () => {
    const creds = resolveOAuthAppCredentials(
      makeConfig({
        personalOAuth: { clientId: 'personal-id', clientSecret: 'personal-secret' },
      }),
    );
    expect(creds).toEqual({ clientId: 'personal-id', clientSecret: 'personal-secret' });
  });
});

describe('applyGithubSpawnCredentials', () => {
  it('is a no-op when token is null', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyGithubSpawnCredentials(env, null);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('is a no-op when token is empty string', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, '');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('is a no-op when token is undefined', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, undefined);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('sets GH_TOKEN and GITHUB_TOKEN to the supplied token', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, 'ghu_test_token_123');
    expect(env.GH_TOKEN).toBe('ghu_test_token_123');
    expect(env.GITHUB_TOKEN).toBe('ghu_test_token_123');
  });

  it('installs a credential helper scoped to https://github.com', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, 'ghu_test_token_123');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    // Helper snippet must dereference $GH_TOKEN at runtime, not bake the
    // literal token into the gitconfig value.
    expect(env.GIT_CONFIG_VALUE_0).toContain('$GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_0).toContain('username=x-access-token');
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('ghu_test_token_123');
  });

  it('helper snippet emits no output when GH_TOKEN is unset (degrades gracefully)', () => {
    // We can't execute the snippet in-process safely, but we can assert
    // it guards on $GH_TOKEN before printing. Combined with the unset
    // case below, this is enough to know the helper won't emit empty
    // creds when the wrapping process forgot to set GH_TOKEN.
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, 'tok');
    const snippet = String(env.GIT_CONFIG_VALUE_0);
    expect(snippet).toMatch(/test -n "\$GH_TOKEN"/);
  });

  it('appends to a pre-existing GIT_CONFIG_COUNT instead of clobbering', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Existing User',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 'pre@existing.example',
    };
    applyGithubSpawnCredentials(env, 'ghu_token');

    expect(env.GIT_CONFIG_COUNT).toBe('3');
    // Pre-existing entries must be untouched.
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Existing User');
    expect(env.GIT_CONFIG_KEY_1).toBe('user.email');
    expect(env.GIT_CONFIG_VALUE_1).toBe('pre@existing.example');
    // Our helper lands at the next free slot.
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_2).toContain('$GH_TOKEN');
  });

  it('treats a malformed pre-existing GIT_CONFIG_COUNT as 0', () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: 'not-a-number' };
    applyGithubSpawnCredentials(env, 'ghu_token');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('treats a negative pre-existing GIT_CONFIG_COUNT as 0', () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '-3' };
    applyGithubSpawnCredentials(env, 'ghu_token');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('does not leak the token literal into the helper string (rotation safety)', () => {
    const token = 'ghu_super_secret_value_12345';
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, token);
    expect(env.GIT_CONFIG_VALUE_0).not.toContain(token);
    // But GH_TOKEN itself must carry the literal — that's the runtime
    // value the helper reads.
    expect(env.GH_TOKEN).toBe(token);
  });
});

describe('reviewer spawn isolation', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDataDir(): { dataDir: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reviewer-isolation-'));
    tmpDirs.push(dir);
    return { dataDir: dir };
  }

  describe('resolveReviewerGhConfigDir', () => {
    it('returns dataDir/<REVIEWER_GH_CONFIG_DIR_NAME>', () => {
      const cfg = { dataDir: '/var/data/agent-hub' };
      expect(resolveReviewerGhConfigDir(cfg)).toBe(
        path.join('/var/data/agent-hub', REVIEWER_GH_CONFIG_DIR_NAME),
      );
    });

    it('is pure — does not touch the filesystem', () => {
      const cfg = { dataDir: '/this/path/should/not/be/created' };
      resolveReviewerGhConfigDir(cfg);
      expect(existsSync('/this/path/should/not/be/created')).toBe(false);
    });
  });

  describe('ensureReviewerGhConfigDir', () => {
    it('creates the isolation directory under dataDir and returns its path', () => {
      const cfg = makeTempDataDir();
      const created = ensureReviewerGhConfigDir(cfg);
      expect(created).toBe(path.join(cfg.dataDir, REVIEWER_GH_CONFIG_DIR_NAME));
      expect(existsSync(created)).toBe(true);
    });

    it('is idempotent — second call does not throw', () => {
      const cfg = makeTempDataDir();
      ensureReviewerGhConfigDir(cfg);
      expect(() => ensureReviewerGhConfigDir(cfg)).not.toThrow();
    });
  });

  describe('applyReviewerSpawnIsolation', () => {
    it('sets GH_CONFIG_DIR to the resolved isolation directory', () => {
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = {};
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    });

    it('sets AGENT_HUB_REVIEWER_LOCK=1', () => {
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = {};
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    });

    it('overrides any pre-existing GH_CONFIG_DIR from inherited host env', () => {
      // The whole point of the isolation: even if the host process has
      // GH_CONFIG_DIR pointing at the operator's gh config, the reviewer
      // spawn must land in the empty Hub-managed dir.
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = {
        GH_CONFIG_DIR: '/home/operator/.config/gh',
        AGENT_HUB_REVIEWER_LOCK: '',
      };
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
      expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    });

    it('scrubs inherited GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN', () => {
      // Tokens in the inherited env (from the operator's shell, PM2, or
      // systemd) must be deleted so a reviewer spawn cannot authenticate
      // as the host identity when no bot token is configured. `gh` reads
      // GH_TOKEN at higher priority than GH_CONFIG_DIR, so the
      // config-dir isolation alone is insufficient.
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = {
        GH_TOKEN: 'ghp_inherited_operator_token',
        GITHUB_TOKEN: 'ghp_inherited_operator_token',
        GH_ENTERPRISE_TOKEN: 'ghe_inherited',
        GITHUB_ENTERPRISE_TOKEN: 'ghe_inherited',
      };
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    });

    it('installs an empty `credential.https://github.com.helper` at GIT_CONFIG index 0 (clears inherited helper chain)', () => {
      // Closes the PR #612 leak path. Without this empty entry, a host
      // operator's `gh auth setup-git` helper (`!gh auth git-credential`,
      // written to `~/.gitconfig`) survives into the spawn and lets `git
      // push` authenticate as the host operator even when the spawn env
      // has no token. Per git's credential-helper merge rules, an empty
      // value clears the accumulated helper list — so any working helper
      // appended later (by `applyGithubSpawnCredentials`) is the ONLY
      // helper git tries.
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = {};
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.GIT_CONFIG_COUNT).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
      expect(env.GIT_CONFIG_VALUE_0).toBe('');
    });

    it('appends the empty helper after pre-existing GIT_CONFIG_* entries (preserves caller config)', () => {
      // Pre-existing entries (e.g. user.name / user.email written by the
      // spawn caller) must be preserved. The empty helper lands at the
      // next free index; the count is bumped accordingly. This guarantees
      // isolation never clobbers config the caller deliberately staged.
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'Pre-Existing User',
      };
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.GIT_CONFIG_COUNT).toBe('2');
      // Caller's entry untouched.
      expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
      expect(env.GIT_CONFIG_VALUE_0).toBe('Pre-Existing User');
      // Empty helper appended at index 1.
      expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
      expect(env.GIT_CONFIG_VALUE_1).toBe('');
    });

    it('treats a malformed pre-existing GIT_CONFIG_COUNT as 0 (defensive parse)', () => {
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: 'not-a-number' };
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.GIT_CONFIG_COUNT).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
      expect(env.GIT_CONFIG_VALUE_0).toBe('');
    });

    it('treats a negative pre-existing GIT_CONFIG_COUNT as 0 (defensive parse)', () => {
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '-3' };
      applyReviewerSpawnIsolation(env, cfg);
      expect(env.GIT_CONFIG_COUNT).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
      expect(env.GIT_CONFIG_VALUE_0).toBe('');
    });
  });
});

// NOTE — the `selectGithubSpawnToken` policy describe block was removed
// alongside the helper itself (see PR #1069 reviewer finding M1). The
// role-aware credential policy now lives exclusively in
// `resolveGithubSpawnToken` (server/github-spawn-token-resolver.ts) and
// is covered by `github-spawn-token-resolver.test.ts`. The composition
// tests below stay — they pin the env-shape contract that
// `applyReviewerSpawnIsolation` + `applyGithubSpawnCredentials` produce
// regardless of which upstream resolver computed the token. Each test
// now feeds a literal token (or `null`) into `applyGithubSpawnCredentials`
// to simulate the resolver's output rather than invoking a policy
// helper that no longer exists.

describe('reviewer spawn env contract (end-to-end composition)', () => {
  // These tests assemble the same helper calls chat.ts makes for every
  // spawn credential branch, in the same order, and assert on the
  // final env shape. Call order mirrors chat.ts:
  //   1. applyReviewerSpawnIsolation  (scrub inherited tokens + set GH_CONFIG_DIR/lock)
  //   2. applyGithubSpawnCredentials  (re-set the resolved spawn token when present)
  //
  // Option A (card 1f9c8215-…) made step (1) universal — it runs on
  // every spawn regardless of role, so AGENT_HUB_REVIEWER_LOCK=1 is
  // always set and inherited GitHub tokens are always scrubbed before
  // (2) re-injects the role-appropriate credential.
  //
  //   - reviewer + no resolved token  → NO GH_TOKEN, NO GIT_CONFIG_*
  //     working helper. Only GH_CONFIG_DIR + lock sentinel.
  //   - reviewer + App installation token (from `resolveGithubSpawnToken`)
  //                                  → bot/App token wired, lock sentinel
  //                                  set, GH_CONFIG_DIR isolated.
  //   - non-reviewer + owner OAuth   → owner token wired, lock sentinel
  //     ALSO set (universal), GH_CONFIG_DIR isolated. The lock blocks
  //     `gh pr review` from the github skill while the re-injected user
  //     token lets `git push` / `gh pr create` still attribute commits
  //     to the human.

  it('reviewer resolver returns null + owner has OAuth → spawn env has no GitHub credential, only empty helper at index 0', () => {
    // Simulates: reviewer-role caller; `resolveGithubSpawnToken`
    // returns null (no App installation matched, no bot token).
    // Per the resolver contract, a reviewer-role spawn never sees the
    // owner's per-user OAuth token even though it's on file.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {};
    const tokenToInject: string | null = null;
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // Empty helper present (clears inherited host helper chain) but no
    // working helper appended — `git push` to github.com fails closed.
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
  });

  it('reviewer + inherited GH_TOKEN in env → inherited token scrubbed', () => {
    // Regression test for the blocking finding: buildSpawnEnv clones
    // process.env wholesale, so an operator-set GH_TOKEN survives into
    // the spawn env. applyReviewerSpawnIsolation must delete it before
    // the credential injection step (which is a no-op when tokenToInject
    // is null). End result: no GH_TOKEN in the reviewer spawn at all.
    // Simulates: reviewer-role caller; `resolveGithubSpawnToken` returns
    // null (no App + no bot token) so per-user OAuth never reaches the
    // env.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = { GH_TOKEN: 'ghp_inherited_host_token' };
    const tokenToInject: string | null = null;
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    // Even with no token re-injected, the empty helper still clears
    // the host operator's gh-auth-setup-git helper chain.
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
  });

  it('reviewer + App installation token (simulating resolveGithubSpawnToken) → App token wired into spawn env', () => {
    // After the user-GitHub-tokens rewrite, the reviewer credential is
    // resolved upstream by the async `resolveGithubSpawnToken` (which
    // mints a Reviewer GitHub App installation token via the new policy).
    // Here we simulate that by injecting the token directly — what we
    // exercise is the composition of isolation + credential injection,
    // which must work identically with the resolver's `ghs_…` token.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {};
    const tokenToInject = 'ghs_reviewer_app_installation_token';
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBe('ghs_reviewer_app_installation_token');
    expect(env.GITHUB_TOKEN).toBe('ghs_reviewer_app_installation_token');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    // Two-entry helper layout: empty at 0 clears host helper chain,
    // working App helper at 1 is the only credential source git will
    // try on push.
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
  });

  it('reviewer + App installation token + inherited GH_TOKEN → inherited token overwritten by App token', () => {
    // Defense-in-depth: even if an inherited token is in the env,
    // it is first scrubbed by isolation, then replaced by the App token.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = { GH_TOKEN: 'ghp_inherited_host_token' };
    const tokenToInject = 'ghs_reviewer_app_installation_token';
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBe('ghs_reviewer_app_installation_token');
    expect(env.GITHUB_TOKEN).toBe('ghs_reviewer_app_installation_token');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    // Same two-entry layout as the no-inherited case — defense-in-depth.
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
  });

  it('non-reviewer + owner has OAuth token → user token wired AND lock sentinel set (universal isolation)', () => {
    // Option A (card 1f9c8215-…): isolation now runs for every spawn,
    // including non-reviewer roles. The per-user OAuth must still
    // survive into GH_TOKEN/GITHUB_TOKEN so `git push` / `gh pr create`
    // authenticate as the human, AND the lock sentinel must be set so
    // the github skill's `gh pr review` write path refuses to act
    // under the human identity.
    // Simulates: non-reviewer interactive caller; `resolveGithubSpawnToken`
    // returned the owner's per-user OAuth (App fallback unavailable).
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {};
    const tokenToInject = 'gho_owner_oauth';
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBe('gho_owner_oauth');
    expect(env.GITHUB_TOKEN).toBe('gho_owner_oauth');
    // Universal-lock contract: every spawn carries the lock sentinel
    // regardless of role, so `gh pr review` cannot post under the
    // session owner's account.
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    // Two-entry helper layout: empty at 0 (clears host helper chain),
    // working user-OAuth helper at 1 (so git pushes authenticate as
    // the human at the keyboard).
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_1).not.toContain('gho_owner_oauth');
  });

  it('non-reviewer + inherited GH_TOKEN + user token → inherited token scrubbed, user token re-injected', () => {
    // Regression test for the option-A fix: dev/author/lead spawns
    // historically skipped isolation, so an operator-set GH_TOKEN in
    // process.env survived into the spawn alongside the lock-less env.
    // After option A, isolation runs first (scrubbing the inherited
    // token), then credential injection re-installs the per-user
    // OAuth — net: the spawn sees the user's token, never the
    // operator's leaked token.
    // Simulates: non-reviewer interactive caller (`author`); resolver
    // returned the owner's per-user OAuth.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: 'ghp_inherited_operator_token',
      GITHUB_TOKEN: 'ghp_inherited_operator_token',
    };
    const tokenToInject = 'gho_owner_oauth';
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBe('gho_owner_oauth');
    expect(env.GITHUB_TOKEN).toBe('gho_owner_oauth');
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    // Empty helper at 0 still installed even when the inherited env
    // had no GIT_CONFIG_* — the host helper chain is neutralised so
    // only the appended user-OAuth helper is reachable.
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
  });

  it('non-reviewer + no user token → spawn env carries lock but no GitHub credential', () => {
    // Acceptance corner of option A: when a non-reviewer agent runs in
    // an org with no per-user OAuth on file, the spawn lands with the
    // lock sentinel set, isolation directory wired, and NO GitHub
    // token at all (host `gh auth login` fallback is severed by
    // GH_CONFIG_DIR). The agent loses ad-hoc `gh` access — which is
    // exactly the contract: identity attribution must come from a
    // stored per-user credential, not an ambient host login.
    // Simulates: non-reviewer caller with no per-user OAuth on file and
    // no App installation token available; `resolveGithubSpawnToken`
    // returns null.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {};
    const tokenToInject: string | null = null;
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // Empty helper at 0 still installed (closes host helper chain);
    // no working helper appended because no token was selected.
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
  });

  it('non-reviewer + autonomousOrigin=true + owner OAuth + inherited GH_TOKEN → spawn env has NO GitHub credential (autonomous dispatch lockdown)', () => {
    // Card 395e044c-… end-to-end composition: an autonomous-dispatch
    // session must not carry the org owner's OAuth token into the
    // spawn, even when both (a) the owner has stored credentials and
    // (b) the host process has an inherited GH_TOKEN. The combined
    // effect of `applyReviewerSpawnIsolation` (scrub inherited) +
    // `resolveGithubSpawnToken({autonomousOrigin: true})` returning
    // null + `applyGithubSpawnCredentials(null)` being a no-op leaves
    // the spawn env with NO GH_TOKEN, NO GITHUB_TOKEN, and NO git
    // credential helper. The lock sentinel and GH_CONFIG_DIR are
    // still set so the wrapper guard still fires for `gh pr review`.
    // Simulates the resolver returning null for the autonomous-origin
    // branch (covered directly by `github-spawn-token-resolver.test.ts`).
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: 'ghp_inherited_operator_token',
      GITHUB_TOKEN: 'ghp_inherited_operator_token',
    };
    const tokenToInject: string | null = null;
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(tokenToInject).toBeNull();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // Autonomous-dispatch lockdown: empty helper at 0 (closes host
    // helper chain), no working helper appended → `git push` to
    // github.com fails with "could not read Username", which is the
    // exact closed-fail behavior the lockdown wants.
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
  });

  it('non-reviewer + autonomousOrigin=false + owner OAuth → user token still wired (interactive path unchanged)', () => {
    // Regression guard: the autonomous-dispatch lockdown must not
    // affect interactive (human-driven) sessions. The same role +
    // owner-OAuth combination with autonomousOrigin=false must inject
    // the user token exactly as before option-A's universal isolation
    // contract demands. Simulates the resolver returning the per-user
    // OAuth for an interactive non-reviewer caller.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {};
    const tokenToInject = 'gho_owner_oauth';
    applyReviewerSpawnIsolation(env, cfg);
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(tokenToInject).toBe('gho_owner_oauth');
    expect(env.GH_TOKEN).toBe('gho_owner_oauth');
    expect(env.GITHUB_TOKEN).toBe('gho_owner_oauth');
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    // Two-entry layout: empty at 0, working user-OAuth helper at 1.
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
  });

  it.each([
    { role: 'reviewer', tokenToInject: null },
    { role: 'lead', tokenToInject: 'gho_owner_oauth' },
    { role: 'author', tokenToInject: 'gho_owner_oauth' },
    { role: 'dev', tokenToInject: 'gho_owner_oauth' },
    { role: 'docs', tokenToInject: 'gho_owner_oauth' },
    { role: 'cli-expert', tokenToInject: 'gho_owner_oauth' },
    { role: undefined, tokenToInject: 'gho_owner_oauth' },
  ] as const)(
    'AGENT_HUB_REVIEWER_LOCK=1 is set regardless of role (role=$role)',
    ({ tokenToInject }) => {
      // Acceptance criterion for card 1f9c8215-…: "Unit test asserting
      // AGENT_HUB_REVIEWER_LOCK=1 is in the spawn env regardless of
      // role." This guards against any future refactor that
      // re-introduces a role-gated guard around isolation in chat.ts.
      // We simulate the resolver's role-dependent output (reviewer →
      // null, everyone else → per-user OAuth) and assert the universal
      // lock + isolation contract that follows.
      const cfg = { dataDir: '/var/data/agent-hub' };
      const env: NodeJS.ProcessEnv = {};
      applyReviewerSpawnIsolation(env, cfg);
      applyGithubSpawnCredentials(env, tokenToInject);
      expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
      expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
    },
  );
});

describe('applyReviewerRoleLock', () => {
  // Distinct from applyReviewerSpawnIsolation (universal lock). The
  // role lock is set ONLY for role=reviewer spawns and unlocks the
  // broader denylist enforced by the github skill scripts. Tested
  // end-to-end in default-skills-github-reviewer-role-lock.test.ts.

  it('sets AGENT_HUB_REVIEWER_ROLE_LOCK=1 when role is "reviewer"', () => {
    const env: NodeJS.ProcessEnv = {};
    applyReviewerRoleLock(env, 'reviewer');
    expect(env.AGENT_HUB_REVIEWER_ROLE_LOCK).toBe('1');
  });

  it.each([
    'lead',
    'author',
    'dev',
    'docs',
    'cli-expert',
    undefined,
    '',
    'Reviewer', // case-sensitive: only the literal 'reviewer' engages the lock
    'reviewer-bot',
  ])('does NOT set AGENT_HUB_REVIEWER_ROLE_LOCK when role=%s', (role) => {
    const env: NodeJS.ProcessEnv = {};
    applyReviewerRoleLock(env, role as string | undefined);
    expect(env.AGENT_HUB_REVIEWER_ROLE_LOCK).toBeUndefined();
  });

  it('layers on top of applyReviewerSpawnIsolation without clobbering its env mutations', () => {
    // Real-world call order in chat.ts: isolation runs first (universal
    // lock + scrub + GH_CONFIG_DIR), then the role lock layers a second
    // marker on top. The role lock must not undo any earlier mutation.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = { GH_TOKEN: 'ghp_inherited' };
    applyReviewerSpawnIsolation(env, cfg);
    applyReviewerRoleLock(env, 'reviewer');

    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.AGENT_HUB_REVIEWER_ROLE_LOCK).toBe('1');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBe(resolveReviewerGhConfigDir(cfg));
  });

  it('isolation + role lock + credential injection (reviewer + App installation token) end-to-end env shape', () => {
    // Reviewer spawn with App-installation creds + role lock: token wired,
    // universal lock set, role lock set. After the user-GitHub-tokens
    // rewrite, the reviewer credential is resolved upstream by the async
    // `resolveGithubSpawnToken` (minting a Reviewer GitHub App installation
    // token); here we simulate that by injecting the resolved token directly
    // and pin the composition contract the reviewer-pipeline depends on.
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {};
    const tokenToInject = 'ghs_reviewer_app_installation_token';
    applyReviewerSpawnIsolation(env, cfg);
    applyReviewerRoleLock(env, 'reviewer');
    applyGithubSpawnCredentials(env, tokenToInject);

    expect(env.GH_TOKEN).toBe('ghs_reviewer_app_installation_token');
    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.AGENT_HUB_REVIEWER_ROLE_LOCK).toBe('1');
  });

  it('non-reviewer spawn does NOT carry the role lock even when isolation set the universal lock', () => {
    // The two markers must remain decoupled. A non-reviewer (e.g.
    // lead/author/dev) still gets the universal lock (gh pr review
    // blocked) but NOT the role lock (gh pr create/merge/close remain
    // available for normal dev workflows).
    const cfg = { dataDir: '/var/data/agent-hub' };
    const env: NodeJS.ProcessEnv = {};
    applyReviewerSpawnIsolation(env, cfg);
    applyReviewerRoleLock(env, 'lead');

    expect(env.AGENT_HUB_REVIEWER_LOCK).toBe('1');
    expect(env.AGENT_HUB_REVIEWER_ROLE_LOCK).toBeUndefined();
  });
});
