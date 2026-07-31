// ─── Worktree-failure cause classifier ───────────────────────────────────────
//
// `ensureSessionWorkspace` can fail for a handful of distinct reasons, but the
// failure surface (chat system message + kanban card comment, see
// `worktree-failure.ts`) only ever showed the raw git/stderr line and a generic
// "ask the operator to investigate" footer. That leaves the reporter with the
// exact question this module answers: *why did this happen, and can we prevent
// it?*
//
// `classifyWorktreeFailure` maps a raw error string to a stable cause code plus
// a one-line human explanation and a concrete prevention step. It is a pure
// function (no I/O) so it is trivially testable and can run in the hot failure
// path without side effects.

export type WorktreeFailureCause =
  | 'auth'
  | 'not-a-git-repo'
  | 'network'
  | 'disk-full'
  | 'permissions'
  | 'dependency-install'
  | 'destination-exists'
  | 'concurrent-clone'
  | 'unknown';

export interface WorktreeFailureDiagnosis {
  cause: WorktreeFailureCause;
  /** One-line plain-English explanation of what went wrong. */
  reason: string;
  /** Concrete action that prevents this specific failure from recurring. */
  prevention: string;
}

// Ordering matters: the first matching rule wins, so more-specific/likely
// causes (auth, disk, permissions) are checked before the broad network net.
const RULES: ReadonlyArray<{
  cause: WorktreeFailureCause;
  test: RegExp;
  reason: string;
  prevention: string;
}> = [
  {
    cause: 'auth',
    test: /could not read Username|Authentication failed|HTTP\s+40[13]\b|access denied|expected flush after ref listing|terminal prompts disabled|Repository not found|Permission denied \(publickey\)/i,
    reason: 'GitHub rejected the clone credentials (or none were available).',
    prevention:
      'Connect the session owner’s GitHub account in Settings → GitHub, or make sure their OAuth/PAT actually has access to this repo. SSH remotes are not supported — use the HTTPS URL form.',
  },
  {
    cause: 'disk-full',
    test: /\bENOSPC\b|No space left on device|quota exceeded/i,
    reason: 'The host ran out of disk while cloning the session worktree.',
    prevention:
      'Free disk on the Agent Hub host and prune stale session workspaces (cleanupStaleWorkspaces) before starting new sessions.',
  },
  {
    cause: 'permissions',
    test: /\bEACCES\b|\bEPERM\b|Permission denied(?!\s*\(publickey\))|Operation not permitted/i,
    reason: 'The Hub process could not write the workspace directory (permission denied).',
    prevention:
      'Fix ownership/permissions on the managed workspaces root so the Hub uid can create and remove clones (root-owned leftovers are cleared via forceRemoveWorkspaceTree).',
  },
  {
    cause: 'not-a-git-repo',
    test: /is not a git repo|does not appear to be a git repository|not a valid repository/i,
    reason: 'The project checkout the worktree branches from is not a git repository.',
    prevention:
      'Set the project’s repo URL / GitHub repo (or Agent Hub hosting) so the workspace self-heals by cloning, or point the project cwd at a real git checkout.',
  },
  {
    cause: 'destination-exists',
    test: /destination path .* already exists and is not an empty directory/i,
    reason: 'A previous failed clone left a non-empty directory where the new clone should go.',
    prevention:
      'The zombie directory is normally removed automatically before retry (removeZombieCloneDir); if it persists, clear the stale session workspace by hand.',
  },
  {
    cause: 'concurrent-clone',
    test: /BUG: refs\/files-backend|initial ref transaction called with existing refs/i,
    reason:
      'Another workspace operation wrote refs into the session clone while `git clone` was still running, so git aborted its initial ref transaction.',
    prevention:
      'Workspace setup is serialised per session (withKeyedLock in worktree.ts) and the clone now retries after wiping the partial directory. If this still recurs, check whether a second Agent Hub process shares the same workspaces root.',
  },
  {
    cause: 'dependency-install',
    test: /dependency install|install command failed|npm ERR!|install failed/i,
    reason: 'The clone succeeded but the post-clone dependency install failed.',
    prevention:
      'Fix the project install command / lockfile so `npm ci` (or the configured install) succeeds, then start a new session.',
  },
  {
    cause: 'network',
    test: /RPC failed|HTTP\s+5\d\d|Internal Server Error|expected ['"]?packfile['"]?|early EOF|fetch-pack: unexpected disconnect|index-pack failed|the remote end hung up unexpectedly|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|Connection reset by peer|Connection timed out|Could not resolve host/i,
    reason: 'A transient network error reached GitHub and retries were exhausted.',
    prevention:
      'Check the host’s network egress to github.com (proxy/firewall/DNS). The clone already retried with backoff, so persistent failures point at connectivity, not a blip.',
  },
];

/**
 * Classify a raw worktree-creation error into a stable cause + human-readable
 * reason and prevention hint. Falls back to `unknown` with a generic operator
 * pointer when no rule matches.
 */
export function classifyWorktreeFailure(errorMessage: string): WorktreeFailureDiagnosis {
  const haystack = errorMessage ?? '';
  for (const rule of RULES) {
    if (rule.test.test(haystack)) {
      return { cause: rule.cause, reason: rule.reason, prevention: rule.prevention };
    }
  }
  return {
    cause: 'unknown',
    reason: 'The worktree clone failed for an unrecognised reason.',
    prevention:
      'Check the [worktree-failed] server log line for the full error, then investigate the host git/network/disk state before starting a new session.',
  };
}
