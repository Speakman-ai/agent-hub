/**
 * worktree-session-clone-pat.test.ts
 *
 * Tests the PAT-credential injection paths added to `ensureSessionWorkspace`:
 *
 *   - Stored GitHub PAT is forwarded as `-c http.…extraheader` args when the
 *     project remote is a github-https URL.
 *   - No auth args are forwarded when the user has no stored PAT.
 *   - No auth args leak to non-github-https remotes even when a PAT exists.
 *   - Legacy embedded installation tokens (x-access-token:…@github.com) are
 *     stripped from the clone URL before git sees it so the session clone's
 *     `.git/config` never contains a token.
 *   - Embedded tokens are redacted from error messages via the double-pass
 *     `redactToken` chain in the catch block.
 *
 * Strategy: mock `child_process.execFile` so no real git network I/O happens,
 * mock `./skill-credentials-github.js` to control PAT availability, and
 * inspect the recorded git argv to assert on the above behaviours.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';
import type { SessionRow } from './types.js';

// ── Config mock ──────────────────────────────────────────────────────────────
vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp', githubApp: null },
}));

// ── GitHub App mock (no installation token available in these tests) ─────────
vi.mock('./github-app.js', () => ({
  getInstallationToken: vi.fn(async () => null),
  resolveInstallationId: vi.fn(async () => null),
}));

// ── skill-credentials-github mock ────────────────────────────────────────────
// We re-implement `gitAuthArgsForGithubPat` faithfully here so tests don't
// depend on an import of the real module (which might pull in orgs DB). The
// `resolveUserGithubToken` helper is mocked synchronously-resolving so tests
// can drive token availability without standing up the OAuth refresh path
// or the user_skill_credentials table.
const mockGetGithubPatForUser = vi.fn((_userId?: string | null): string | null => null);

vi.mock('./skill-credentials-github.js', () => ({
  getGithubPatForUser: (userId?: string | null) => mockGetGithubPatForUser(userId),
  // Test-side resolver mirrors the production precedence: OAuth lookup is
  // skipped (no oauthCredentials path under test), so this reduces to the
  // PAT lookup the existing assertions rely on.
  resolveUserGithubToken: async (
    userId: string | null | undefined,
    _opts: unknown,
  ): Promise<string | null> => {
    if (!userId) return null;
    return mockGetGithubPatForUser(userId);
  },
  gitAuthArgsForGithubPat: (token: string | null | undefined): string[] => {
    if (!token) return [];
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    return ['-c', `http.https://github.com/.extraheader=Authorization: basic ${basic}`];
  },
}));

// `worktree.ts` now also imports `resolveOAuthAppCredentials` from
// `./spawn-github-credentials.js` to thread OAuth client creds into the
// resolver. The function only inspects two fields on the config object;
// stub it to return null (no OAuth App configured in tests) so the
// resolver short-circuits to the PAT path the mock above controls.
vi.mock('./spawn-github-credentials.js', () => ({
  resolveOAuthAppCredentials: () => null,
}));

// ── child_process.execFile intercept ─────────────────────────────────────────
// Recorded git calls: each entry is { args, opts } for one execFile call.
type GitCallRecord = { args: string[]; opts: Record<string, unknown> };
const recorded: { calls: GitCallRecord[] } = { calls: [] };

// Controls the remote URL that `git remote get-url origin` returns.
let currentRemoteUrl = '';

// When true the next `git clone` call will reject with the given message.
let cloneFailMessage: string | null = null;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const stubExecFile = (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
  ): void => {
    recorded.calls.push({ args: [...args], opts });

    // Simulate predictable responses for the commands worktree.ts issues.
    if (args.includes('rev-parse') && args.includes('--git-dir')) {
      // isGitRepo → report a valid git repo
      setImmediate(() => cb(null, { stdout: '.git', stderr: '' }));
      return;
    }
    if (args.includes('remote') && args.includes('get-url')) {
      // getRemoteUrl → return the configured test URL
      setImmediate(() => cb(null, { stdout: currentRemoteUrl, stderr: '' }));
      return;
    }
    if (args.includes('clone')) {
      if (cloneFailMessage !== null) {
        const msg = cloneFailMessage;
        setImmediate(() => cb(new Error(msg), { stdout: '', stderr: msg }));
        return;
      }
    }

    // All other git operations (checkout, config, fetch, …) succeed silently.
    setImmediate(() => cb(null, { stdout: '', stderr: '' }));
  };
  return { ...actual, execFile: stubExecFile };
});

// ── Module under test (imported after all mocks are set up) ──────────────────
const { ensureSessionWorkspace, removeWorkspace } = await import('./worktree.js');

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeSession(id: string, ownerId: string | null = null): SessionRow {
  return {
    id,
    agent_id: 'agent-1',
    name: 'test session',
    engine: 'claude',
    model: 'claude-sonnet-4-20250514',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: null,
    worktree_branch: null,
    git_worktree_detected: 0,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    owner_user_id: ownerId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
}

function uniqueSessionId(): string {
  return `sess${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('ensureSessionWorkspace — PAT credential injection', () => {
  let sourceDir: string;
  let createdWorkspace: string | null = null;

  beforeEach(() => {
    recorded.calls = [];
    cloneFailMessage = null;
    mockGetGithubPatForUser.mockReturnValue(null);
    currentRemoteUrl = '';

    // Create a minimal source directory so `ensureWorkspaceDir` can derive a
    // workspace slug from it. No git repo content needed — all git calls are
    // intercepted by the stub above.
    sourceDir = path.join(
      os.tmpdir(),
      `wt-pat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(sourceDir, { recursive: true });
    createdWorkspace = null;
  });

  afterEach(() => {
    if (createdWorkspace) {
      removeWorkspace(createdWorkspace);
    }
    // Clean up the workspace parent dir created under ~/.agent-hub/workspaces
    try {
      const wsParent = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(sourceDir));
      if (existsSync(wsParent)) {
        rmSync(wsParent, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    if (existsSync(sourceDir)) {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  // ── PAT injection into clone args ─────────────────────────────────────────

  it('forwards PAT auth args (-c extraheader) into git clone for github-https remotes', async () => {
    const USER_PAT = 'ghp_testPAT_abcde12345';
    mockGetGithubPatForUser.mockReturnValue(USER_PAT);
    currentRemoteUrl = 'https://github.com/owner/repo.git';

    const persist = vi.fn();
    const ws = await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      persist,
    );
    createdWorkspace = ws;

    const cloneCall = recorded.calls.find((c) => c.args.includes('clone'));
    expect(cloneCall, 'expected a git clone call').toBeDefined();

    // Auth args must appear before 'clone' in the argv.
    const args = cloneCall!.args;
    expect(args[0]).toBe('-c');
    expect(args[1]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=Authorization: basic /);

    // Decode the base64 payload and verify it carries the PAT.
    const b64 = args[1].split('Authorization: basic ')[1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(`x-access-token:${USER_PAT}`);
  });

  it('consults getGithubPatForUser with the session owner_user_id', async () => {
    currentRemoteUrl = 'https://github.com/owner/repo.git';
    const persist = vi.fn();

    const ws = await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-42'),
      sourceDir,
      'agent-1',
      persist,
    );
    createdWorkspace = ws;

    expect(mockGetGithubPatForUser).toHaveBeenCalledWith('user-42');
  });

  // ── No PAT passthrough ────────────────────────────────────────────────────

  it('passes no auth args to git clone when user has no stored PAT', async () => {
    // mockGetGithubPatForUser already returns null from beforeEach
    currentRemoteUrl = 'https://github.com/owner/repo.git';

    const persist = vi.fn();
    const ws = await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      persist,
    );
    createdWorkspace = ws;

    const cloneCall = recorded.calls.find((c) => c.args.includes('clone'));
    expect(cloneCall, 'expected a git clone call').toBeDefined();

    expect(cloneCall!.args).not.toContain('-c');
    expect(cloneCall!.args.join(' ')).not.toContain('extraheader');
  });

  // ── Non-github-https no-leak ──────────────────────────────────────────────

  it('does not forward auth args for non-github-https remotes even when user has a PAT', async () => {
    const USER_PAT = 'ghp_leak_guard_9999';
    mockGetGithubPatForUser.mockReturnValue(USER_PAT);
    currentRemoteUrl = 'https://gitlab.com/owner/repo.git'; // non-github

    const persist = vi.fn();
    const ws = await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      persist,
    );
    createdWorkspace = ws;

    const cloneCall = recorded.calls.find((c) => c.args.includes('clone'));
    expect(cloneCall, 'expected a git clone call').toBeDefined();

    // No auth args must reach non-github remotes.
    expect(cloneCall!.args).not.toContain('-c');
    const b64Pat = Buffer.from(`x-access-token:${USER_PAT}`).toString('base64');
    expect(cloneCall!.args.join(' ')).not.toContain(b64Pat);
  });

  // ── cloneSourceUrl canonicalization ──────────────────────────────────────

  it('strips embedded installation token from remote URL before cloning', async () => {
    const EMBEDDED_TOKEN = 'ghs_install_token_MUST_NOT_REACH_GIT';
    currentRemoteUrl = `https://x-access-token:${EMBEDDED_TOKEN}@github.com/owner/repo.git`;
    mockGetGithubPatForUser.mockReturnValue(null);

    const persist = vi.fn();
    const ws = await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      persist,
    );
    createdWorkspace = ws;

    const cloneCall = recorded.calls.find((c) => c.args.includes('clone'));
    expect(cloneCall, 'expected a git clone call').toBeDefined();

    const cloneArgStr = cloneCall!.args.join(' ');
    // The embedded token must NEVER appear in the git clone argv.
    expect(cloneArgStr).not.toContain(EMBEDDED_TOKEN);
    // But the canonical github.com owner/repo URL must be present.
    expect(cloneArgStr).toContain('https://github.com/owner/repo.git');
  });

  it('passes a clean github-https URL through when there is no embedded token', async () => {
    currentRemoteUrl = 'https://github.com/owner/clean-repo.git';
    mockGetGithubPatForUser.mockReturnValue(null);

    const persist = vi.fn();
    const ws = await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      persist,
    );
    createdWorkspace = ws;

    const cloneCall = recorded.calls.find((c) => c.args.includes('clone'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.args.join(' ')).toContain('https://github.com/owner/clean-repo.git');
  });

  // ── Error redaction ───────────────────────────────────────────────────────

  it('redacts an embedded installation token from error messages on clone failure', async () => {
    const EMBEDDED_TOKEN = 'ghs_embed_SECRET_redact_me_xyz';
    currentRemoteUrl = `https://x-access-token:${EMBEDDED_TOKEN}@github.com/owner/repo.git`;
    mockGetGithubPatForUser.mockReturnValue(null);

    // Make git clone fail with a message that echoes back the raw URL
    // (simulating git outputting the token-bearing URL in its error).
    cloneFailMessage = `fatal: repository 'https://x-access-token:${EMBEDDED_TOKEN}@github.com/owner/repo.git' not found`;

    const onFailure = vi.fn();
    const persist = vi.fn();
    await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      persist,
      undefined,
      onFailure,
    );

    // onFailure must have been called (clone failed → fallback to projectCwd)
    expect(onFailure).toHaveBeenCalledOnce();
    const surfacedMessage: string = onFailure.mock.calls[0][1];

    // The embedded token must NEVER appear in the surfaced error message.
    expect(surfacedMessage).not.toContain(EMBEDDED_TOKEN);
  });

  it('redacts the user PAT from error messages on clone failure', async () => {
    const USER_PAT = 'ghp_user_PAT_MUST_NOT_LEAK_abc123';
    mockGetGithubPatForUser.mockReturnValue(USER_PAT);
    currentRemoteUrl = 'https://github.com/owner/private-repo.git';

    // Simulate git returning an error that (hypothetically) echoes the PAT.
    cloneFailMessage = `fatal: authentication failed for 'https://x-access-token:${USER_PAT}@github.com/owner/private-repo.git'`;

    const onFailure = vi.fn();
    await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      vi.fn(),
      undefined,
      onFailure,
    );

    expect(onFailure).toHaveBeenCalledOnce();
    const surfacedMessage: string = onFailure.mock.calls[0][1];
    expect(surfacedMessage).not.toContain(USER_PAT);
  });

  // Production-incident regression (2026-05-14 17:16:40). When the user's
  // stored OAuth token has no access to the target repo, GitHub returns
  // 403 and node's `execFile` builds a `Command failed: …` error string
  // that echoes the full argv — including the `-c http.<host>.extraheader=
  // Authorization: basic <BASE64>` arg synthesized by
  // `gitAuthArgsForGithubPat`. The secret in that echo is the
  // base64-encoded `x-access-token:<TOKEN>` form, NOT the raw token, so
  // the value-based `redactToken` pass cannot find it. Before the
  // shape-based `redactAuthHeader` helper was layered into every clone /
  // fetch catch site in `worktree.ts` (#991), a live `gho_` user OAuth
  // token landed in `console.error` and the WebSocket `onFailure`
  // payload. This integration test exercises the full
  // `ensureSessionWorkspace` path with the real-world argv echo + GitHub
  // 403 body so any future regression of the layered redaction shows up
  // here, not in production logs.
  it('redacts the base64 Authorization header from real-world argv-echo errors', async () => {
    const USER_PAT = 'gho_REAL_user_oauth_token_MUST_NOT_LEAK_xyz';
    mockGetGithubPatForUser.mockReturnValue(USER_PAT);
    currentRemoteUrl = 'https://github.com/Speakman-ai/agent-hub.git';

    const basicPayload = Buffer.from(`x-access-token:${USER_PAT}`, 'utf8').toString('base64');
    // Shape matches the actual 17:16:40 production failure: `Command
    // failed: git -c http.…extraheader=Authorization: basic <BASE64>
    // clone …` followed by the GitHub 403 body.
    cloneFailMessage =
      `Command failed: git -c http.https://github.com/.extraheader=Authorization: basic ${basicPayload} ` +
      `clone --depth 1 --quiet https://github.com/Speakman-ai/agent-hub.git ` +
      `/home/node/.agent-hub/workspaces/agent-hub/session-test\n` +
      `remote: Write access to repository not granted.\n` +
      `fatal: unable to access 'https://github.com/Speakman-ai/agent-hub.git/': ` +
      `The requested URL returned error: 403`;

    const onFailure = vi.fn();
    await ensureSessionWorkspace(
      makeSession(uniqueSessionId(), 'user-1'),
      sourceDir,
      'agent-1',
      vi.fn(),
      undefined,
      onFailure,
    );

    expect(onFailure).toHaveBeenCalledOnce();
    const surfacedMessage: string = onFailure.mock.calls[0][1];

    // Neither the raw token nor its base64-wrapped form may survive.
    expect(surfacedMessage).not.toContain(USER_PAT);
    expect(surfacedMessage).not.toContain(basicPayload);
    // The redacted header shape should appear instead so operators
    // still see WHERE the leak would have been.
    expect(surfacedMessage).toContain('Authorization: basic ***');
    // Diagnostic context — the GitHub 403 — must still surface.
    expect(surfacedMessage).toContain('Write access to repository not granted');
    expect(surfacedMessage).toContain('returned error: 403');
  });
});
