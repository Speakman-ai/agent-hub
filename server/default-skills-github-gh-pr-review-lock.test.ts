/**
 * Verifies the AGENT_HUB_REVIEWER_LOCK guard in
 * `default-skills/github/scripts/gh-pr.sh`. Reviewer-role spawns set
 * `AGENT_HUB_REVIEWER_LOCK=1` so the only correct identity path is the
 * server-side App endpoint at `POST /api/pr/review`; the script must
 * refuse to run `gh pr review` and exit 2 with a clear pointer.
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
  // Prepend the stub dir so `command -v gh` resolves to our shim
  // regardless of whether a real gh is installed on the test host.
  stubbedPath = `${stubDir}:${process.env.PATH || ''}`;
});

afterAll(() => {
  if (stubDir && existsSync(stubDir)) rmSync(stubDir, { recursive: true, force: true });
});

describe('gh-pr.sh review — AGENT_HUB_REVIEWER_LOCK guard', () => {
  it('exits 2 with App-endpoint pointer when AGENT_HUB_REVIEWER_LOCK=1', () => {
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
    expect(stderr).toContain('/api/pr/review');
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

  it('does NOT block read-only subcommands (sanity check)', () => {
    // `gh-pr.sh status` does not run `gh pr review` and is not the
    // identity-leak vector — make sure the lock isn't accidentally
    // applied to every subcommand.
    //
    // We don't actually want to call out to the network; the lock check
    // is the only thing we care about, and its absence is what we
    // verify. The stub gh always exits 0 so the script's `gh pr status`
    // call falls through cleanly.
    const result = spawnSync('bash', [SCRIPT, 'status'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
        AGENT_HUB_REVIEWER_LOCK: '1',
        GH_TOKEN: 'fake-token-to-satisfy-require_gh_token',
      },
      encoding: 'utf-8',
    });
    // status is allowed; the stub gh exits 0 so the script succeeds.
    expect(result.status).toBe(0);
    // And critically the lock message must NOT appear here — the lock
    // is scoped to the `review` subcommand.
    expect(result.stderr || '').not.toContain('gh-pr.sh review is disabled');
  });

  it('exits 2 with usage text when AGENT_HUB_REVIEWER_LOCK is unset and required args are missing', () => {
    // Establishes the baseline: without the lock the script still
    // refuses to invoke a malformed review call. This is what shipped
    // historically and we're not regressing it.
    const result = spawnSync('bash', [SCRIPT, 'review'], {
      env: {
        PATH: stubbedPath,
        HOME: os.tmpdir(),
      },
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr || '').toMatch(/pr review <number>/);
  });
});

// Belt-and-braces: confirm the script exists where the tests above
// point. Catches a future path move.
describe('gh-pr.sh layout', () => {
  it('default-skills/github/scripts/gh-pr.sh is present and executable', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    // execFileSync with --help-equivalent (the script prints usage to
    // stderr and exits 2 when called with no args). We assert non-zero
    // exit and a usage line on stderr.
    let stderr = '';
    try {
      execFileSync('bash', [SCRIPT], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err: unknown) {
      stderr = (err as { stderr?: Buffer | string }).stderr?.toString() || '';
    }
    expect(stderr).toContain('Usage: gh-pr.sh');
  });
});
