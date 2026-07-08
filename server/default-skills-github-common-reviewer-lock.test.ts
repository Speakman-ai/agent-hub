/**
 * Verifies the AGENT_HUB_REVIEWER_LOCK gate inside
 * `default-skills/github/scripts/_common.sh::require_gh_token`.
 *
 * Closes the credential-leak path identified in acme/webapp
 * PR #612: when no GH_TOKEN/GITHUB_TOKEN is in the spawn env, the
 * historical fallback was to call `gh auth status` and treat success as
 * proof of authentication. Under the universal isolation contract
 * (PR #896, see spawn-github-credentials.ts), `GH_CONFIG_DIR` is
 * rerouted to a Hub-managed empty dir so `gh auth status` *should*
 * fail there — but if any host-level path bypasses that override (a
 * different `gh` on PATH, a future `gh` that reads a fallback config,
 * etc.), the fallback can silently authenticate as the host operator.
 *
 * The fix: when `AGENT_HUB_REVIEWER_LOCK=1` and no env token is
 * present, hard-fail with exit code 2 BEFORE the `gh auth status`
 * fallback runs. Binary outcome:
 *   - env token present → ok
 *   - lock=1, no env token → fail closed (exit 2 + helpful message)
 *   - lock unset, no env token → falls back to host gh (legacy dev path)
 *
 * The script exits as soon as `require_gh_token` is called for the
 * first time, so we exercise the gate by sourcing `_common.sh` and
 * calling `require_gh_token` directly. We synthesise a fake `gh` stub
 * on PATH so `require_gh_cli` (sourced at the bottom of `_common.sh`)
 * doesn't hard-exit on hosts without a real `gh` install.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMON_SH = path.join(__dirname, 'default-skills', 'github', 'scripts', '_common.sh');

let stubDir = '';
let stubbedPath = '';

beforeAll(() => {
  stubDir = mkdtempSync(path.join(os.tmpdir(), 'gh-common-stub-'));
  const stub = path.join(stubDir, 'gh');
  // Two-mode stub:
  //   - `gh auth status` exits 0 (simulates a host operator who IS
  //     logged in via `gh auth login`). This is the worst-case for the
  //     leak we're testing — without the lock guard, require_gh_token
  //     would return 0 here and let the calling script proceed under
  //     the host identity.
  //   - any other invocation exits 0 silently. require_gh_cli only
  //     needs `command -v gh` to succeed; it doesn't run gh.
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      '# Test-only gh stub. `gh auth status` exits 0 to simulate a',
      '# host operator who is logged in — exactly the leak the lock',
      '# guard prevents from being reachable inside the spawn.',
      'if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(stub, 0o755);
  stubbedPath = `${stubDir}:${process.env.PATH || ''}`;
});

afterAll(() => {
  if (stubDir && existsSync(stubDir)) rmSync(stubDir, { recursive: true, force: true });
});

/**
 * Spawn bash that sources `_common.sh` and calls `require_gh_token`,
 * then echoes a sentinel on success. We use `set +e` because
 * `_common.sh` enables `set -euo pipefail` at the top — we want to
 * observe the exit code from `require_gh_token` itself rather than
 * have the sourcing kill the subshell early.
 */
function runRequireGhToken(env: NodeJS.ProcessEnv) {
  const script = `
    set +e
    source "${COMMON_SH}"
    require_gh_token
    rc=$?
    if [[ $rc -eq 0 ]]; then
      echo "REQUIRE_GH_TOKEN_OK"
    fi
    exit $rc
  `;
  return spawnSync('bash', ['-c', script], {
    env: { ...env, PATH: stubbedPath },
    encoding: 'utf-8',
  });
}

describe('_common.sh require_gh_token — AGENT_HUB_REVIEWER_LOCK gate', () => {
  it('returns 0 when GH_TOKEN is set (lock state irrelevant)', () => {
    const result = runRequireGhToken({
      HOME: os.tmpdir(),
      GH_TOKEN: 'ghp_fake_token_for_test',
      AGENT_HUB_REVIEWER_LOCK: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REQUIRE_GH_TOKEN_OK');
  });

  it('returns 0 when GITHUB_TOKEN is set (lock state irrelevant)', () => {
    const result = runRequireGhToken({
      HOME: os.tmpdir(),
      GITHUB_TOKEN: 'ghp_fake_token_for_test',
      AGENT_HUB_REVIEWER_LOCK: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REQUIRE_GH_TOKEN_OK');
  });

  it('exits 2 when AGENT_HUB_REVIEWER_LOCK=1 and no env token, even if `gh auth status` would succeed', () => {
    // The leak being closed: without the lock guard, require_gh_token
    // would fall through to `gh auth status` (which our stub returns 0
    // for) and let the script authenticate as the host operator. With
    // the guard, the lock short-circuits to exit 2 before the fallback.
    const result = runRequireGhToken({
      HOME: os.tmpdir(),
      AGENT_HUB_REVIEWER_LOCK: '1',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('REQUIRE_GH_TOKEN_OK');
    const stderr = result.stderr || '';
    expect(stderr).toContain('AGENT_HUB_REVIEWER_LOCK=1');
    expect(stderr).toContain('in-session advisor');
  });

  it('falls back to `gh auth status` when AGENT_HUB_REVIEWER_LOCK is unset (legacy dev path)', () => {
    // Outside the lock, the fallback is the historical behavior the
    // script shipped with — preserved so devs running the skill from
    // their own shell (no Hub spawn) can still rely on `gh auth login`.
    const result = runRequireGhToken({
      HOME: os.tmpdir(),
      // Lock deliberately unset.
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REQUIRE_GH_TOKEN_OK');
  });

  it('falls back when AGENT_HUB_REVIEWER_LOCK is set to a non-"1" value (literal-string check)', () => {
    // The guard checks for the exact string "1", matching the value
    // applyReviewerSpawnIsolation writes. Any other value MUST NOT
    // engage the lock — we don't want truthy bash semantics here
    // (e.g. "0", "false", "no") accidentally locking dev shells.
    for (const value of ['0', 'false', 'no', 'true']) {
      const result = runRequireGhToken({
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: value,
      });
      expect(result.status, `lock value=${value}`).toBe(0);
      expect(result.stdout).toContain('REQUIRE_GH_TOKEN_OK');
    }
  });

  it('does not bypass the lock with an empty GH_TOKEN string', () => {
    // Defensive: the guard should treat empty-string tokens as absent
    // (which `[[ -n ]]` already does). The lock then engages and we
    // get the same hard-fail as the no-token case.
    const result = runRequireGhToken({
      HOME: os.tmpdir(),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      AGENT_HUB_REVIEWER_LOCK: '1',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('AGENT_HUB_REVIEWER_LOCK=1');
  });
});
