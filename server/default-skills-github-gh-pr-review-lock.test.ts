/**
 * Verifies the review-disable + create guards in
 * `default-skills/github/scripts/gh-pr.sh`. Agent Hub injects
 * AGENT_HUB_REVIEWER_LOCK=1 into EVERY spawn (not just reviewer-role
 * spawns).
 *
 *   1. `gh pr review` — formal GitHub reviews are disabled outright. The
 *      reviewer is an in-session advisor and emits its APPROVE /
 *      REQUEST_CHANGES verdict in session output, so `cmd_review` always
 *      hard-errors (exit 2) regardless of the lock state.
 * Interactive non-reviewer spawns use per-user OAuth in `GH_TOKEN`, so
 * `gh pr create` is allowed when the token is `gho_` / `ghp_` (ship skill).
 * App installation tokens (`ghs_`) and non-user tokens remain blocked.
 * Reviewer-role spawns still block create via `AGENT_HUB_REVIEWER_ROLE_LOCK`.
 *
 * Other write subcommands (comment, merge, close, ready) carry no
 * identity-attribution risk under the universal lock and must remain
 * available so lead/dev workflows still function. The reviewer-role
 * lock (`AGENT_HUB_REVIEWER_ROLE_LOCK=1`) covers those for reviewers.
 *
 * Notes
 * -----
 * The script sources `_common.sh`, which sourced `require_gh_cli` at
 * top level (hard-exits if `gh` is missing). To avoid coupling this
 * test to whether `gh` is installed in CI, we synthesise a tiny `gh`
 * stub on PATH that prints nothing and exits 0. The lock check fires
 * before any subcommand dispatch reaches the real CLI, so the stub
 * never has to mimic GitHub.
 */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'default-skills', 'github', 'scripts', 'gh-pr.sh');

let stubDir = '';
let stubbedPath = '';

beforeAll(() => {
  stubDir = mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
  const stub = path.join(stubDir, 'gh');
  // A no-op gh stub satisfies `require_gh_cli` when _common.sh is
  // sourced. It must NEVER be reached for the actual review subcommand
  // path under test — the lock check exits before that.
  writeFileSync(stub, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  chmodSync(stub, 0o755);
  const curlStub = path.join(stubDir, 'curl');
  writeFileSync(
    curlStub,
    [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    */api/projects/*)',
      '      printf "%s" "$AGENT_HUB_TEST_PROJECT_JSON"',
      '      exit "${AGENT_HUB_TEST_CURL_STATUS:-0}"',
      '      ;;',
      '  esac',
      'done',
      'exit 1',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(curlStub, 0o755);
  // Prepend the stub dir so `command -v gh` resolves to our shim
  // regardless of whether a real gh is installed on the test host.
  stubbedPath = `${stubDir}:${process.env.PATH || ''}`;
});

afterAll(() => {
  if (stubDir && existsSync(stubDir)) rmSync(stubDir, { recursive: true, force: true });
});

function makeGitRepoWithOrigin(remoteUrl: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gh-pr-repo-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('gh-pr.sh review — disabled (in-session advisor)', () => {
  it('exits 2 with the in-session advisor message when AGENT_HUB_REVIEWER_LOCK=1', () => {
    const result = spawnSync('bash', [SCRIPT, 'review', '123', '--approve'], {
      env: {
        // Minimal env: PATH (gh stub) + the lock sentinel only.
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: '1',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    const stderr = result.stderr || '';
    expect(stderr).toContain('gh-pr.sh review is disabled');
    expect(stderr).toContain('in-session advisor');
    // No GitHub posting path is advertised anymore.
    expect(stderr).not.toContain('/api/pr/review');
    // Reviewer agents must not see a misleading `gh` invocation succeed.
    expect(result.stdout).not.toContain('Approved PR');
  });

  it('exits 2 with the same message regardless of subflag', () => {
    for (const flags of [
      ['review', '5', '--request-changes', '--body', 'fix x'],
      ['review', '5', '--comment', '--body', 'note'],
    ]) {
      const result = spawnSync('bash', [SCRIPT, ...flags], {
        env: {
          PATH: stubbedPath,
          HOME: os.tmpdir(),
          AGENT_HUB_REVIEWER_LOCK: '1',
        },
        encoding: 'utf-8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr || '').toContain('gh-pr.sh review is disabled');
    }
  });

  it('exits 2 even when the universal lock is unset (review is disabled outright)', () => {
    const result = spawnSync('bash', [SCRIPT, 'review', '7', '--approve'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        GH_TOKEN: 'gho_fake-user-oauth',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('gh-pr.sh review is disabled');
    expect(result.stdout).not.toContain('Approved PR');
  });

  it('does NOT block read-only subcommands (sanity check)', () => {
    // Read-only subcommands (view, diff, list, status, checks, checkout)
    // are not the identity-leak vector — make sure the lock isn't
    // accidentally applied to every subcommand. We do NOT assert on the
    // stub's exit code: the stub `gh` always exits 0 regardless of args,
    // which would be a stub artefact rather than a real `gh pr status`
    // signal. The intent here is "the lock guard is not on the
    // read-only path" — that's expressed by the absence of the lock
    // message on stderr.
    const result = spawnSync('bash', [SCRIPT, 'status'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: '1',
        GH_TOKEN: 'fake-token-to-satisfy-require_gh_token',
      },
      encoding: 'utf-8',
    });
    // The lock message must NOT appear here — the lock is scoped to
    // write subcommands.
    expect(result.stderr || '').not.toContain('is disabled inside Agent Hub reviewer sessions');
  });

  // The `review` subcommand must refuse under the lock.
  it('blocks the review subcommand under AGENT_HUB_REVIEWER_LOCK=1', () => {
    const result = spawnSync('bash', [SCRIPT, 'review', '1', '--approve'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: '1',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    const stderr = result.stderr || '';
    expect(stderr).toContain('gh-pr.sh review is disabled');
    expect(stderr).toContain('in-session advisor');
  });

  // Regression: create/comment/merge/close/ready remain available under
  // AGENT_HUB_REVIEWER_LOCK=1 for interactive dev spawns with user OAuth.
  // The reviewer-role lock covers create for reviewer spawns separately.
  const NON_LOCKED_WRITE_SUBCOMMANDS: Array<[string, string[]]> = [
    ['comment', ['comment', '1', '--body', 'note']],
    ['merge', ['merge', '1', '--squash']],
    ['close', ['close', '1']],
    ['ready', ['ready', '1']],
  ];

  for (const [name, args] of NON_LOCKED_WRITE_SUBCOMMANDS) {
    it(`does NOT block ${name} under AGENT_HUB_REVIEWER_LOCK=1`, () => {
      const result = spawnSync('bash', [SCRIPT, ...args], {
        env: {
          PATH: stubbedPath,
          HOME: os.tmpdir(),
          AGENT_HUB_REVIEWER_LOCK: '1',
          GH_TOKEN: 'gho_fake-user-oauth',
        },
        encoding: 'utf-8',
      });
      // The lock messages must NOT appear — the universal lock only covers `review`.
      expect(result.stderr || '').not.toContain('is disabled in Agent Hub spawns');
    });
  }

  it('allows create under AGENT_HUB_REVIEWER_LOCK=1 with per-user OAuth (gho_)', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'test pr'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: '1',
        GH_TOKEN: 'gho_fake-user-oauth',
      },
      encoding: 'utf-8',
    });
    expect(result.stderr || '').not.toContain('gh-pr.sh create is disabled');
    expect(result.status).not.toBe(2);
  });

  it('blocks create when the target repo differs from the Agent Hub project repo', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'cross repo pr'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        PROJECT_ID: 'mcs-field',
        AGENT_HUB_URL: 'http://agent-hub.test',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_TEST_PROJECT_JSON: '{"githubRepo":"mcsteen/mcs-field"}',
        GH_REPO: 'mcsteen/surveytracker',
        GH_TOKEN: 'gho_fake-user-oauth',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    const stderr = result.stderr || '';
    expect(stderr).toContain('cross-repo PR creation is not allowed');
    expect(stderr).toContain('mcsteen/mcs-field');
    expect(stderr).toContain('mcsteen/surveytracker');
    expect(stderr).toContain('Agent Hub ticket in the target project instead');
  });

  it('allows create when the target repo matches the Agent Hub project repo case-insensitively', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'same repo pr'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        PROJECT_ID: 'mcs-field',
        AGENT_HUB_URL: 'http://agent-hub.test',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_TEST_PROJECT_JSON: '{"githubRepo":"McSteen/MCS-Field"}',
        GH_REPO: 'mcsteen/mcs-field',
        GH_TOKEN: 'gho_fake-user-oauth',
      },
      encoding: 'utf-8',
    });
    expect(result.stderr || '').not.toContain('cross-repo PR creation is not allowed');
    expect(result.status).not.toBe(2);
  });

  it.each([
    ['ssh URL', 'ssh://git@github.com/mcsteen/mcs-field.git'],
    ['https URL with userinfo', 'https://user@github.com/mcsteen/mcs-field.git'],
  ])('allows create when origin is a matching GitHub %s', (_label, remoteUrl) => {
    const cwd = makeGitRepoWithOrigin(remoteUrl);
    try {
      const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'same repo pr'], {
        cwd,
        env: {
          PATH: stubbedPath,
          HOME: os.tmpdir(),
          PROJECT_ID: 'mcs-field',
          AGENT_HUB_URL: 'http://agent-hub.test',
          AGENT_HUB_API_KEY: 'test-key',
          AGENT_HUB_TEST_PROJECT_JSON: '{"githubRepo":"mcsteen/mcs-field"}',
          GH_TOKEN: 'gho_fake-user-oauth',
        },
        encoding: 'utf-8',
      });
      expect(result.stderr || '').not.toContain('cross-repo PR creation is not allowed');
      expect(result.status).not.toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks create when project repo is configured but target repo cannot be resolved', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'unknown repo pr'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        PROJECT_ID: 'mcs-field',
        AGENT_HUB_URL: 'http://agent-hub.test',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_TEST_PROJECT_JSON: '{"githubRepo":"mcsteen/mcs-field"}',
        GH_TOKEN: 'gho_fake-user-oauth',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('cannot determine the target GitHub repo');
    expect(result.stderr || '').toContain('create an Agent Hub ticket in that repo');
  });

  it('blocks create when the Agent Hub project lookup fails', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'unverified repo pr'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        PROJECT_ID: 'mcs-field',
        AGENT_HUB_URL: 'http://agent-hub.test',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_TEST_PROJECT_JSON: '{"error":"unauthorized"}',
        AGENT_HUB_TEST_CURL_STATUS: '1',
        GH_REPO: 'mcsteen/surveytracker',
        GH_TOKEN: 'gho_fake-user-oauth',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('could not verify the Agent Hub project repo');
  });

  it('blocks create when the Agent Hub project response is invalid JSON', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'invalid project json'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        PROJECT_ID: 'mcs-field',
        AGENT_HUB_URL: 'http://agent-hub.test',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_TEST_PROJECT_JSON: 'not json',
        GH_REPO: 'mcsteen/surveytracker',
        GH_TOKEN: 'gho_fake-user-oauth',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('could not verify the Agent Hub project repo');
  });

  it('blocks create under AGENT_HUB_REVIEWER_LOCK=1 with App installation token (ghs_)', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'test pr'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: '1',
        GH_TOKEN: 'ghs_fake-app-installation-token',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('gh-pr.sh create is disabled');
  });

  it('blocks create under AGENT_HUB_REVIEWER_LOCK=1 without per-user OAuth', () => {
    const result = spawnSync('bash', [SCRIPT, 'create', '--title', 'test pr'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: '1',
        GH_TOKEN: 'fake-token-to-satisfy-require_gh_token',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('gh-pr.sh create is disabled');
  });

  it('exits 2 with the advisor message when AGENT_HUB_REVIEWER_LOCK is unset and no args are passed', () => {
    // Without the lock the review subcommand is still disabled outright —
    // it no longer reaches arg parsing, so `gh-pr.sh review` with no args
    // prints the in-session advisor message rather than usage text.
    const result = spawnSync('bash', [SCRIPT, 'review'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('gh-pr.sh review is disabled');
  });
});

// Belt-and-braces: confirm the script exists where the tests above
// point. Catches a future path move.
describe('gh-pr.sh layout', () => {
  it('default-skills/github/scripts/gh-pr.sh is present and executable', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    // The script prints usage to stderr and exits 2 when called with no
    // args — but `_common.sh` calls `require_gh_cli` at source time, which
    // hard-exits with "gh CLI not found" BEFORE arg parsing if `gh` isn't on
    // PATH. Run with the same `gh` stub the other tests use so this assertion
    // is hermetic (passes whether or not the host has gh installed — e.g. the
    // Finalize DinD runner has no gh, unlike GitHub Actions runners).
    let stderr = '';
    try {
      execFileSync('bash', [SCRIPT], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: stubbedPath, HOME: os.tmpdir() },
      });
    } catch (err: unknown) {
      stderr = (err as { stderr?: Buffer | string }).stderr?.toString() || '';
    }
    // gh-pr.sh sources _common.sh, which runs `require_gh_cli` at load time
    // and hard-exits with "gh CLI not found on PATH" when the GitHub CLI is
    // absent. On CI runners without `gh` installed (e.g. the Finalize DinD
    // image) that prerequisite message is the expected stderr; when `gh` IS
    // present the no-arg invocation falls through to the dispatcher usage
    // banner. Either output proves the script exists, is executable, and
    // runs — which is all this layout/path-move guard cares about.
    expect(stderr).toMatch(/Usage: gh-pr\.sh|gh CLI not found on PATH/);
  });
});
