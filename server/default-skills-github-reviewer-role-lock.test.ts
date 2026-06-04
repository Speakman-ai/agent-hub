/**
 * Verifies the AGENT_HUB_REVIEWER_ROLE_LOCK guard (card 1cb9b461-…).
 *
 * Distinct from AGENT_HUB_REVIEWER_LOCK (universal, blocks only
 * `gh pr review`). The role lock is set ONLY for role=reviewer spawns
 * by `applyReviewerRoleLock` and adds defense-in-depth: a much broader
 * write surface is denied so that even if a future change leaks a
 * GitHub token into the reviewer spawn env, the credential cannot be
 * used to forge commits or open PRs (the failure mode documented in
 * mcsteen/surveytracker PR #622).
 *
 * Surfaces under test:
 *
 *   gh-pr.sh create  / merge / close / ready  → denied  (subcommand-level)
 *   gh-pr.sh review                           → denied  (already covered
 *                                                       by the universal
 *                                                       lock test)
 *   gh-pr.sh comment / view / diff / list /   → allowed
 *            status / checks / checkout
 *
 *   gh api graphql --method POST              → denied
 *   gh api repos/o/r/contents/x --method PUT  → denied
 *   gh api repos/o/r/issues --method POST     → denied
 *   gh api repos/o/r/pulls/N/reviews -X POST  → denied (formal reviews are
 *                                                       not posted to GitHub)
 *   gh api repos/o/r/issues/N/comments POST   → allowed
 *   gh api repos/o/r/pulls (GET)              → allowed
 *
 * The script sources `_common.sh`, which calls `require_gh_cli` at
 * top level. We synthesise a `gh` stub on PATH so the source step
 * doesn't hard-exit on hosts without a real `gh` install.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, 'default-skills', 'github', 'scripts');
const GH_PR_SH = path.join(SCRIPTS_DIR, 'gh-pr.sh');
const COMMON_SH = path.join(SCRIPTS_DIR, '_common.sh');

let stubDir = '';
let stubbedPath = '';

beforeAll(() => {
  stubDir = mkdtempSync(path.join(os.tmpdir(), 'gh-role-lock-stub-'));
  const stub = path.join(stubDir, 'gh');
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      '# Test stub. Records the arg list to stderr (prefixed STUB_GH:)',
      '# so allowed-path tests can assert the call actually reached',
      '# the wrapper, then exit 0.',
      'echo "STUB_GH: $*" >&2',
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

function runGhPr(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [GH_PR_SH, ...args], {
    env: {
      PATH: stubbedPath,
      HOME: os.tmpdir(),
      AGENT_HUB_REVIEWER_ROLE_LOCK: '1',
      // The universal lock is always set under the role lock too — that
      // matches the real chat.ts call order. We deliberately keep both
      // in scope so this test exercises the layered guards together.
      AGENT_HUB_REVIEWER_LOCK: '1',
      GH_TOKEN: 'fake-token-to-satisfy-require_gh_token',
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

function runGhApi(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  // Source _common.sh and invoke gh_api so the allowlist check fires.
  const script = `
    set +e
    source "${COMMON_SH}"
    gh_api ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}
    exit $?
  `;
  return spawnSync('bash', ['-c', script], {
    env: {
      PATH: stubbedPath,
      HOME: os.tmpdir(),
      AGENT_HUB_REVIEWER_ROLE_LOCK: '1',
      AGENT_HUB_REVIEWER_LOCK: '1',
      GH_TOKEN: 'fake-token-to-satisfy-require_gh_token',
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

describe('gh-pr.sh — AGENT_HUB_REVIEWER_ROLE_LOCK subcommand denylist', () => {
  const DENIED_SUBCMDS: Array<[string, string[]]> = [
    ['create', ['create', '--title', 'test pr']],
    ['merge', ['merge', '1', '--squash']],
    ['close', ['close', '1']],
    ['ready', ['ready', '1']],
  ];

  for (const [name, args] of DENIED_SUBCMDS) {
    it(`denies ${name} under AGENT_HUB_REVIEWER_ROLE_LOCK=1`, () => {
      const result = runGhPr(args);
      expect(result.status).toBe(2);
      const stderr = result.stderr || '';
      expect(stderr).toContain(`gh-pr.sh ${name}`);
      expect(stderr).toContain('forbidden in reviewer-role spawns');
      // The stub gh must NEVER be reached for a denied subcommand —
      // the lock fires before any gh invocation.
      expect(stderr).not.toContain('STUB_GH:');
    });
  }

  // comment is intentionally NOT denied: PR conversation comments are a
  // legitimate review activity and the underlying API path
  // (POST /repos/o/r/issues/N/comments) is in the gh_api allowlist.
  it('does NOT deny gh-pr.sh comment under the role lock', () => {
    const result = runGhPr(['comment', '1', '--body', 'note from reviewer']);
    // Assert only the absence of the role-lock message — exit-code
    // semantics on the comment path are influenced by a pre-existing
    // `_require_arg` artifact in _common.sh (the function returns the
    // exit of `[[ -z "$value" ]]` which fires set -e even on the
    // success branch). That's tracked separately; the role-lock
    // contract here is that comment is not in the denylist.
    expect(result.stderr || '').not.toContain('forbidden in reviewer-role spawns');
  });

  for (const sub of ['view', 'diff', 'list', 'status', 'checks', 'checkout']) {
    it(`does NOT deny read-only subcommand '${sub}' under the role lock`, () => {
      const args =
        sub === 'view' || sub === 'diff' || sub === 'checks' || sub === 'checkout'
          ? [sub, '1']
          : [sub];
      const result = runGhPr(args);
      expect(result.stderr || '').not.toContain('forbidden in reviewer-role spawns');
    });
  }

  it('review is still blocked (disabled outright in cmd_review)', () => {
    const result = runGhPr(['review', '1', '--approve']);
    // cmd_review hard-errors regardless of any lock — formal reviews are
    // not posted to GitHub; the reviewer emits its verdict in-session.
    expect(result.status).toBe(2);
    expect(result.stderr || '').toMatch(
      /gh-pr\.sh review is disabled|forbidden in reviewer-role spawns/,
    );
  });
});

describe('gh_api — AGENT_HUB_REVIEWER_ROLE_LOCK write allowlist', () => {
  it('allows GET on any repos/* path', () => {
    const result = runGhApi(['/repos/owner/repo/pulls']);
    expect(result.status).toBe(0);
    // Stub gh was invoked.
    expect(result.stderr || '').toContain('STUB_GH:');
  });

  it('denies POST /repos/<owner>/<repo>/pulls/<n>/reviews (formal reviews not posted to GitHub)', () => {
    const result = runGhApi([
      '/repos/owner/repo/pulls/42/reviews',
      '--method',
      'POST',
      '-f',
      'event=APPROVE',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
    expect(result.stderr || '').not.toContain('STUB_GH:');
  });

  it('allows POST /repos/<owner>/<repo>/issues/<n>/comments (PR conversation)', () => {
    const result = runGhApi([
      '/repos/owner/repo/issues/42/comments',
      '--method',
      'POST',
      '-f',
      'body=hello',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr || '').toContain('STUB_GH:');
    expect(result.stderr || '').not.toContain('forbidden in reviewer-role spawns');
  });

  it('denies PUT /repos/<owner>/<repo>/contents/<path> (commit forge attempt)', () => {
    const result = runGhApi([
      '/repos/owner/repo/contents/dangerous.txt',
      '--method',
      'PUT',
      '-f',
      'message=oops',
      '-f',
      'content=Zm9v',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
    expect(result.stderr || '').not.toContain('STUB_GH:');
  });

  it('denies POST /repos/<owner>/<repo>/pulls (open-PR attempt)', () => {
    const result = runGhApi(['/repos/owner/repo/pulls', '--method', 'POST']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
    expect(result.stderr || '').not.toContain('STUB_GH:');
  });

  it('denies PATCH /repos/<owner>/<repo>/pulls/<n> (PR edit)', () => {
    const result = runGhApi(['/repos/owner/repo/pulls/1', '--method', 'PATCH']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
  });

  it('denies DELETE on any path under the lock', () => {
    const result = runGhApi(['/repos/owner/repo/branches/main', '--method', 'DELETE']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
  });

  it('denies graphql wholesale (gh api graphql defaults to POST and bodies are free-form)', () => {
    const result = runGhApi(['graphql', '-f', 'query=mutation { x }']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('gh api graphql');
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
  });

  it('denies graphql even for read queries (the wrapper cannot tell read from mutation)', () => {
    const result = runGhApi(['graphql', '-f', 'query={viewer{login}}']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('gh api graphql');
  });

  it('honors -X as a short flag for --method', () => {
    const result = runGhApi(['/repos/owner/repo/pulls', '-X', 'POST']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
  });

  it('case-insensitive method match (post vs POST)', () => {
    const result = runGhApi(['/repos/owner/repo/pulls', '--method', 'post']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
  });

  it('does nothing when the role lock is unset (legacy / non-reviewer path)', () => {
    const result = runGhApi(['/repos/owner/repo/pulls', '--method', 'POST'], {
      AGENT_HUB_REVIEWER_ROLE_LOCK: '',
      AGENT_HUB_REVIEWER_LOCK: '',
    });
    expect(result.status).toBe(0);
    expect(result.stderr || '').toContain('STUB_GH:');
    expect(result.stderr || '').not.toContain('forbidden in reviewer-role spawns');
  });

  it('refuses a write even with a non-standard path that does not match allowlist exactly', () => {
    // Defense against pattern erosion: a path that has 'reviews' as a
    // substring but is not the formal-review path must still be denied.
    const result = runGhApi(['/repos/owner/repo/pulls/42/reviews/99', '--method', 'POST']);
    expect(result.status).toBe(2);
    expect(result.stderr || '').toContain('forbidden in reviewer-role spawns');
  });
});

describe('AGENT_HUB_REVIEWER_ROLE_LOCK literal-string semantics', () => {
  it('does not engage when value is set to a non-"1" string (no truthy-bash semantics)', () => {
    for (const value of ['0', 'false', 'no', 'true']) {
      const result = runGhPr(['create', '--title', 'pr'], {
        AGENT_HUB_REVIEWER_ROLE_LOCK: value,
        AGENT_HUB_REVIEWER_LOCK: '',
      });
      // The role lock must NOT fire — its message must be absent.
      expect(result.stderr || '', `value=${value}`).not.toContain(
        'forbidden in reviewer-role spawns',
      );
    }
  });
});
