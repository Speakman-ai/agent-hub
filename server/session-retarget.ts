/**
 * Move a session worktree from one target (base) branch to another.
 *
 * Only the session's own commits move: the fork point is the merge-base of
 * HEAD with the OLD target, and `git rebase --onto origin/<new> <fork>`
 * replays `fork..HEAD` onto the new target. A plain `git rebase origin/<new>`
 * would also replay every commit on the old target that the new one lacks
 * (e.g. retargeting from `main` to a release branch drags all of main along).
 *
 * Every entry point first reads the worktree state (`readWorktreeState`) and
 * refuses unless it is clean, on a branch, and has no git operation in
 * progress. That makes the rebase this module starts the only one it can ever
 * abort: an operation the user or agent already had open is never touched.
 * Conflicts abort the Hub's own rebase and are reported so the caller can hand
 * resolution to the agent.
 *
 * A clean git exit is not proof the session's work survived (`rebase` drops
 * merge commits and anything already on the target). So the automatic path
 * only rewrites linear histories, and after rewriting it compares HEAD's tree
 * with the exact expected result, the target plus the session's net change.
 * On any mismatch it restores the original HEAD and hands off instead.
 */

import type { SessionWorktreeIo } from './session-env/worktree-io.js';
import { sessionWorktreeIoFor } from './session-worktree-io.js';
import type { SessionRow } from './types.js';

const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const FETCH_TIMEOUT_MS = 60_000;
const REBASE_TIMEOUT_MS = 120_000;
const FALLBACK_NAME = 'Agent Hub';
const FALLBACK_EMAIL = 'agent-hub@localhost';

/**
 * The Hub collapsed a session history with merge commits into one commit with
 * the identical tree before rebasing (a rebase cannot replay merges, nor edits
 * made inside them). The original history is kept at `backupRef`.
 */
export interface RetargetFlatten {
  originalHead: string;
  backupRef: string;
  mergeCount: number;
}

export type RetargetOutcome =
  /** Nothing to move (same target). */
  | { kind: 'noop'; reason: string }
  /** HEAD now sits on `origin/<toBranch>` with `commits` session commits replayed. */
  | { kind: 'rebased'; commits: number; headSha: string; flattened?: RetargetFlatten }
  /** Uncommitted changes; nothing was touched. */
  | { kind: 'dirty'; targetSha: string; forkSha: string; headSha: string }
  /** A rebase/merge/cherry-pick is already open, or HEAD is detached; nothing was touched. */
  | { kind: 'busy'; reason: string }
  /**
   * The Hub could not prove a faithful replay (merge commits, or the rewritten
   * tree differs from target + session change); HEAD is unchanged.
   */
  | {
      kind: 'unsafe';
      commits: number;
      forkSha: string;
      reason: string;
      targetSha: string;
      headSha: string;
    }
  /** Rebase hit conflicts and was aborted; HEAD is unchanged. */
  | {
      kind: 'conflict';
      commits: number;
      files: string[];
      forkSha: string;
      targetSha: string;
      /** Hand-off HEAD; the flattened commit when `flattened` is set. */
      headSha: string;
      flattened?: RetargetFlatten;
    }
  /** A git step failed before any history was rewritten. */
  | { kind: 'error'; message: string };

const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=5',
};

async function git(
  io: SessionWorktreeIo,
  args: string[],
  timeoutMs = FETCH_TIMEOUT_MS,
  env: Record<string, string> = BASE_ENV,
) {
  const result = await io.git(args, { timeoutMs, env });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.trim(),
    detail: (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '',
  };
}

async function refExists(io: SessionWorktreeIo, ref: string): Promise<boolean> {
  return (await git(io, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok;
}

const IN_PROGRESS_MARKERS = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
] as const;

export interface WorktreeState {
  /** Branch HEAD points at, or null when detached. */
  branch: string | null;
  /** Git operation already in progress (a paused interactive rebase can look clean). */
  operation: (typeof IN_PROGRESS_MARKERS)[number][1] | null;
  dirty: boolean;
}

/** Read what the worktree is in the middle of, without changing anything. */
export async function readWorktreeState(
  io: SessionWorktreeIo,
): Promise<WorktreeState | { error: string }> {
  const status = await git(io, ['status', '--porcelain']);
  if (!status.ok) return { error: `git status failed: ${status.detail}` };
  let operation: WorktreeState['operation'] = null;
  for (const [marker, name] of IN_PROGRESS_MARKERS) {
    const gitPath = await git(io, ['rev-parse', '--git-path', marker]);
    if (!gitPath.ok) return { error: `git rev-parse failed: ${gitPath.detail}` };
    const probe = await io.exec(`test -e ${shellQuote(gitPath.stdout)}`, {
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (probe.exitCode === 0) {
      operation = name;
      break;
    }
    // `test -e` exits 1 for "absent"; anything else means the probe itself
    // failed, which must not read as "no operation open".
    if (probe.exitCode !== 1) {
      return { error: `Could not check for an open ${name} (exit ${String(probe.exitCode)})` };
    }
  }
  const head = await git(io, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return { branch: head.ok && head.stdout ? head.stdout : null, operation, dirty: !!status.stdout };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Reflog subjects of HEAD moves that created a commit on this branch: new
 * commits and amends, rebase/cherry-pick replays, true merges, and the Hub's
 * own flatten. Checkouts, `rebase (start)` (the onto commit), fast-forwards
 * and resets only move HEAD onto existing commits.
 */
const SESSION_CREATED_RE =
  /^(commit( \([^)]*\))?:|rebase( -i)? \((pick|continue|squash|fixup|reword|edit)\)|cherry-pick:)|: Merge made by/;

/**
 * Commits this worktree created, from HEAD's reflog (session worktrees are
 * pinned to one branch, so that is the session branch's own history). Null
 * when the reflog cannot be read.
 */
async function sessionCreatedCommits(io: SessionWorktreeIo): Promise<Set<string> | null> {
  const log = await git(io, ['reflog', 'show', '--format=%H%x09%gs', 'HEAD']);
  if (!log.ok) return null;
  const created = new Set<string>();
  for (const line of log.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const subject = line.slice(tab + 1);
    if (SESSION_CREATED_RE.test(subject) && !/Fast-forward/.test(subject)) {
      created.add(line.slice(0, tab));
    }
  }
  return created;
}

/**
 * The upstream content the session's work is built on, as one commit.
 *
 * A session's work is not a range below a single fork once it merges
 * upstream in: it is HEAD's content minus the upstream content it absorbed,
 * and that baseline can sit on a side parent. It is derived from the
 * session's own history, not from where the old base points now (the old
 * base can move forward, or absorb the session's commits):
 *  - work commits are those this worktree created (reflog) or that are not on
 *    the old base (inherited branch work, or an unreadable/empty reflog);
 *  - walking from HEAD through work commits along every parent, each
 *    non-work commit reached is upstream; their maximal element
 *    (`merge-base --independent`) is the baseline.
 * Several independent maximal upstream commits (the session merged unrelated
 * upstream lines) have no single baseline, so that is refused.
 */
async function sessionBaseline(
  io: SessionWorktreeIo,
  fromRef: string,
): Promise<{ sha: string } | { error: string } | { ambiguous: string }> {
  const created = await sessionCreatedCommits(io);
  if (!created) return { error: 'Could not read the worktree reflog to locate the session fork' };
  const offBase = await git(io, ['rev-list', 'HEAD', `^${fromRef}`]);
  if (!offBase.ok) return { error: `git rev-list failed: ${offBase.detail}` };
  const offBaseSet = new Set(offBase.stdout.split('\n').filter(Boolean));
  const work = (sha: string) => created.has(sha) || offBaseSet.has(sha);

  const head = await git(io, ['rev-parse', 'HEAD']);
  if (!head.ok || !head.stdout) return { error: `git rev-parse failed: ${head.detail}` };
  const upstream = new Set<string>();
  const seen = new Set<string>();
  const stack = [head.stdout];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (seen.size > 20_000) return { error: 'Session history is too long to locate its fork' };
    if (!work(sha)) {
      upstream.add(sha);
      continue;
    }
    const parents = await git(io, ['rev-list', '--parents', '-n', '1', sha]);
    if (!parents.ok) return { error: `git rev-list failed: ${parents.detail}` };
    stack.push(...parents.stdout.split(/\s+/).slice(1).filter(Boolean));
  }
  if (upstream.size === 0) {
    return { error: 'The session history reaches the repository root; no upstream baseline' };
  }
  let baseline: string;
  if (upstream.size === 1) {
    baseline = [...upstream][0]!;
  } else {
    const independent = await git(io, ['merge-base', '--independent', ...upstream]);
    if (!independent.ok) return { error: `git merge-base failed: ${independent.detail}` };
    const maximal = independent.stdout.split('\n').filter(Boolean);
    if (maximal.length !== 1) {
      return {
        ambiguous:
          `the session history merges ${maximal.length} independent upstream lines, so it has no single ` +
          'baseline to move from',
      };
    }
    baseline = maximal[0]!;
  }

  // The model "session work = HEAD minus the baseline" is valid only while
  // the baseline's history holds none of the session's own commits. If
  // upstream absorbed a session commit and the session then merged or rebased
  // onto a descendant of it, that commit sits below the baseline and would be
  // subtracted out with the upstream content; after a forward rebase it is not
  // even reachable from HEAD's walk. So every commit this worktree created is
  // checked against the baseline, visited or not. Commits left dangling by a
  // rewrite cannot be ancestors of the baseline, so they never match.
  const absorbed: string[] = [];
  const candidates = [...created].filter((sha) => sha !== baseline);
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i + 8);
    const results = await Promise.all(
      batch.map((sha) => git(io, ['merge-base', '--is-ancestor', sha, baseline])),
    );
    results.forEach((res, k) => {
      if (res.ok) absorbed.push(batch[k]!);
    });
  }
  if (absorbed.length > 0) {
    const shas = absorbed;
    const subjects = await git(io, ['log', '--no-walk', '--format=%h %s', ...shas]);
    return {
      ambiguous:
        `upstream commit ${baseline.slice(0, 12)} already contains session work ` +
        `(${subjects.ok ? subjects.stdout.split('\n').join('; ') : shas.map((x) => x.slice(0, 12)).join(', ')}), ` +
        'so the Hub cannot separate it from upstream changes. Cherry-pick the session commits onto the target ' +
        'by hand, or start a new session on the target branch',
    };
  }
  return { sha: baseline };
}

async function fetchBranch(
  io: SessionWorktreeIo,
  branch: string,
): Promise<{ ok: boolean; detail: string }> {
  return git(io, [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}

async function mergeBase(io: SessionWorktreeIo, ref: string): Promise<string | null> {
  const res = await git(io, ['merge-base', 'HEAD', ref]);
  return res.ok && res.stdout ? res.stdout : null;
}

/** Identity for the rewritten commits when the clone has none configured. */
async function committerEnv(io: SessionWorktreeIo): Promise<Record<string, string>> {
  const env = { ...BASE_ENV };
  if (!(await git(io, ['config', 'user.name'])).stdout) env.GIT_COMMITTER_NAME = FALLBACK_NAME;
  if (!(await git(io, ['config', 'user.email'])).stdout) env.GIT_COMMITTER_EMAIL = FALLBACK_EMAIL;
  return env;
}

/** Author + committer identity for commits the Hub creates itself. */
function identityEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    GIT_AUTHOR_NAME: env.GIT_COMMITTER_NAME ?? FALLBACK_NAME,
    GIT_AUTHOR_EMAIL: env.GIT_COMMITTER_EMAIL ?? FALLBACK_EMAIL,
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME ?? FALLBACK_NAME,
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL ?? FALLBACK_EMAIL,
  };
}

/**
 * Normalize a merge-containing session range for a rebase: one commit on
 * `forkSha` with exactly `oldHead`'s tree, so no content can be lost (the
 * tree is copied, not replayed). The original history stays at a backup ref.
 * Returns the new commit, or an error string; the branch is not moved here.
 */
async function flattenSessionRange(
  io: SessionWorktreeIo,
  args: { forkSha: string; oldHead: string; toBranch: string; env: Record<string, string> },
): Promise<{ sha: string; backupRef: string } | { error: string }> {
  const subjects = await git(io, [
    'log',
    '--reverse',
    '--format=- %s',
    `${args.forkSha}..${args.oldHead}`,
  ]);
  const message =
    `Session changes, flattened to retarget onto ${args.toBranch}\n\n` +
    'Combined from:\n' +
    (subjects.ok ? subjects.stdout : '');
  const commit = await git(
    io,
    ['commit-tree', `${args.oldHead}^{tree}`, '-p', args.forkSha, '-m', message],
    FETCH_TIMEOUT_MS,
    identityEnv(args.env),
  );
  if (!commit.ok || !commit.stdout) return { error: `git commit-tree failed: ${commit.detail}` };
  const backupRef = `refs/agent-hub/pre-flatten/${args.oldHead.slice(0, 12)}`;
  const backup = await git(io, ['update-ref', backupRef, args.oldHead]);
  if (!backup.ok) return { error: `git update-ref failed: ${backup.detail}` };
  return { sha: commit.stdout, backupRef };
}

/**
 * Tree the retarget must produce: `toRef` plus the session's net change
 * (`forkSha` → `oldHead`), merged 3-way with `forkSha` as the base. Two
 * throwaway commits parented on the fork pin that merge base (git 2.38's
 * `merge-tree --write-tree` has no `--merge-base`). Null when that merge
 * conflicts or git fails, which the caller treats as unproven.
 */
async function expectedRetargetTree(
  io: SessionWorktreeIo,
  args: { forkSha: string; oldHead: string; toRef: string; env: Record<string, string> },
): Promise<string | null> {
  const env = identityEnv(args.env);
  const synth = async (rev: string) => {
    const res = await git(
      io,
      ['commit-tree', `${rev}^{tree}`, '-p', args.forkSha, '-m', 'retarget check'],
      FETCH_TIMEOUT_MS,
      env,
    );
    return res.ok && res.stdout ? res.stdout : null;
  };
  const [session, target] = await Promise.all([synth(args.oldHead), synth(args.toRef)]);
  if (!session || !target) return null;
  const merged = await git(io, ['merge-tree', '--write-tree', target, session], REBASE_TIMEOUT_MS);
  if (!merged.ok) return null;
  return merged.stdout.split('\n')[0]?.trim() || null;
}

export async function retargetSessionWorktree(
  io: SessionWorktreeIo,
  opts: {
    fromBranch: string;
    toBranch: string;
    /**
     * Retry of a recorded retarget: reuse its fork point instead of deriving
     * one from the live old base (which a rewritten HEAD no longer reflects),
     * and require the recorded hand-off HEAD to still be an ancestor of HEAD.
     */
    recorded?: { forkSha: string; headSha: string };
  },
): Promise<RetargetOutcome> {
  const { fromBranch, toBranch, recorded } = opts;
  if (!SAFE_BRANCH_RE.test(fromBranch) || !SAFE_BRANCH_RE.test(toBranch)) {
    return { kind: 'error', message: 'Unsafe branch name' };
  }
  if (fromBranch === toBranch) return { kind: 'noop', reason: 'target unchanged' };

  const state = await readWorktreeState(io);
  if ('error' in state) return { kind: 'error', message: state.error };
  if (state.operation) {
    return { kind: 'busy', reason: `A ${state.operation} is already in progress in the worktree` };
  }
  if (!state.branch) return { kind: 'busy', reason: 'HEAD is detached' };

  // A retry works from the recorded fork; the old branch is only consulted
  // (best effort) to spot upstream merged in since the hand-off.
  const [, toFetch] = await Promise.all([fetchBranch(io, fromBranch), fetchBranch(io, toBranch)]);
  const fromRef = `origin/${fromBranch}`;
  const toRef = `origin/${toBranch}`;
  // The new target must be fetched fresh: a leftover tracking ref for a
  // deleted or unreachable branch would rewrite history onto a stale tip.
  if (!toFetch.ok) {
    return {
      kind: 'error',
      message: `Could not fetch ${toBranch} from origin: ${toFetch.detail || 'fetch failed'}`,
    };
  }
  if (!(await refExists(io, toRef))) {
    return { kind: 'error', message: `Branch ${toBranch} was not found on origin` };
  }
  // The old target only locates the fork point, so a cached ref is enough
  // (it may have been deleted on origin after the session forked from it).
  if (!recorded && !(await refExists(io, fromRef))) {
    return { kind: 'error', message: `Previous target ${fromBranch} was not found on origin` };
  }
  const toTip = await git(io, ['rev-parse', `${toRef}^{commit}`]);
  if (!toTip.ok || !toTip.stdout) {
    return { kind: 'error', message: `Could not resolve ${toRef}: ${toTip.detail}` };
  }
  const targetSha = toTip.stdout;

  const oldHeadRes = await git(io, ['rev-parse', 'HEAD']);
  if (!oldHeadRes.ok || !oldHeadRes.stdout) {
    return { kind: 'error', message: `git rev-parse failed: ${oldHeadRes.detail}` };
  }
  const oldHead = oldHeadRes.stdout;

  let forkSha: string | null;
  if (recorded) {
    const check = await recordedRetargetUsable(io, recorded);
    if (check !== true) return { kind: 'busy', reason: check };
    forkSha = recorded.forkSha;
    // Upstream merged into the session after the hand-off sits above the
    // recorded fork and would ride along. Re-derive the baseline (same model
    // and validity check as a first retarget) and move up to it when it has
    // advanced past the recorded fork. The old base is optional here: if it
    // is gone, nothing can have been merged from it that we could detect.
    if (await refExists(io, fromRef)) {
      const baseline = await sessionBaseline(io, fromRef);
      if ('error' in baseline) return { kind: 'error', message: baseline.error };
      if ('ambiguous' in baseline) return { kind: 'busy', reason: baseline.ambiguous };
      if (baseline.sha !== forkSha) {
        const advanced = await git(io, ['merge-base', '--is-ancestor', forkSha, baseline.sha]);
        if (advanced.ok) forkSha = baseline.sha;
      }
    }
  } else {
    forkSha = await mergeBase(io, fromRef);
    if (!forkSha) {
      // Network clones are shallow; deepen the two refs involved once and retry.
      await git(io, ['fetch', '--no-tags', '--deepen=512', 'origin', fromBranch, toBranch]);
      forkSha = await mergeBase(io, fromRef);
    }
  }
  if (!forkSha) {
    return { kind: 'error', message: `Could not find where the session forked from ${fromBranch}` };
  }
  if (!recorded) {
    // The merge-base above only guarantees the history is deep enough; the
    // replay base is the session's own upstream baseline.
    const baseline = await sessionBaseline(io, fromRef);
    if ('error' in baseline) return { kind: 'error', message: baseline.error };
    if ('ambiguous' in baseline) return { kind: 'busy', reason: baseline.ambiguous };
    forkSha = baseline.sha;
  }
  if (state.dirty) return { kind: 'dirty', targetSha, forkSha, headSha: oldHead };

  const count = await git(io, ['rev-list', '--count', `${forkSha}..HEAD`]);
  let commits = Number.parseInt(count.stdout, 10) || 0;
  const merges = await git(io, ['rev-list', '--merges', '--count', `${forkSha}..HEAD`]);
  if (!merges.ok) return { kind: 'error', message: `git rev-list failed: ${merges.detail}` };
  const mergeCount = Number.parseInt(merges.stdout, 10) || 0;

  const env = await committerEnv(io);
  const expectedTree = await expectedRetargetTree(io, {
    forkSha,
    oldHead,
    toRef: targetSha,
    env,
  });

  // Every failure after this point puts the branch back exactly where it was.
  const restoreOriginal = async (why: string): Promise<RetargetOutcome | null> => {
    const restore = await git(io, ['reset', '--hard', oldHead], REBASE_TIMEOUT_MS, env);
    return restore.ok
      ? null
      : {
          kind: 'error',
          message: `${why}, and restoring ${oldHead.slice(0, 12)} failed: ${restore.detail}`,
        };
  };

  // A rebase cannot replay merges (or edits made inside them), so the Hub
  // flattens them itself rather than asking anyone to rewrite history by hand.
  let flattened: RetargetFlatten | undefined;
  if (mergeCount > 0) {
    const flat = await flattenSessionRange(io, { forkSha, oldHead, toBranch, env });
    if ('error' in flat) return { kind: 'error', message: flat.error };
    // Same tree as HEAD on a clean worktree: moving the branch loses nothing.
    // The reflog message marks the flattened commit as session-created, so a
    // later fork lookup walks past it like any other session commit.
    const move = await git(
      io,
      ['update-ref', '-m', 'commit (agent-hub flatten): retarget', 'HEAD', flat.sha, oldHead],
      REBASE_TIMEOUT_MS,
      env,
    );
    if (move.ok) await git(io, ['reset', '-q', '--hard', 'HEAD'], REBASE_TIMEOUT_MS, env);
    if (!move.ok) {
      return (
        (await restoreOriginal(`moving to the flattened commit failed: ${move.detail}`)) ?? {
          kind: 'error',
          message: `moving to the flattened commit failed: ${move.detail}`,
        }
      );
    }
    flattened = { originalHead: oldHead, backupRef: flat.backupRef, mergeCount };
    commits = 1;
  }
  const workingHead = flattened ? (await git(io, ['rev-parse', 'HEAD'])).stdout : oldHead;

  const rebase = await git(io, ['rebase', '--onto', targetSha, forkSha], REBASE_TIMEOUT_MS, env);
  if (rebase.ok) {
    const [head, tree] = await Promise.all([
      git(io, ['rev-parse', 'HEAD']),
      git(io, ['rev-parse', 'HEAD^{tree}']),
    ]);
    if (expectedTree && tree.ok && tree.stdout === expectedTree) {
      return {
        kind: 'rebased',
        commits,
        headSha: head.stdout,
        ...(flattened ? { flattened } : {}),
      };
    }
    const reason = 'the rebased tree did not match the target plus the session changes';
    return (
      (await restoreOriginal(reason)) ?? {
        kind: 'unsafe',
        commits,
        forkSha,
        reason,
        targetSha,
        headSha: oldHead,
      }
    );
  }

  const unmerged = await git(io, ['diff', '--name-only', '--diff-filter=U']);
  const files = unmerged.stdout ? unmerged.stdout.split('\n').filter(Boolean) : [];
  // No operation was open before this call, so a rebase in progress now is
  // the one started above. If git refused to start one, there is nothing to undo.
  const after = await readWorktreeState(io);
  if (!('error' in after) && after.operation === 'rebase') {
    const abort = await git(io, ['rebase', '--abort'], REBASE_TIMEOUT_MS, env);
    if (!abort.ok) {
      return { kind: 'error', message: `git rebase --abort failed: ${abort.detail}` };
    }
  }
  if (files.length === 0) {
    const message = `git rebase failed: ${rebase.detail}`;
    return (await restoreOriginal(message)) ?? { kind: 'error', message };
  }
  // The hand-off starts from the (linear) working head, flattened or not, so
  // the agent's procedure and the recorded move always describe the same range.
  return {
    kind: 'conflict',
    commits,
    files,
    forkSha,
    targetSha,
    headSha: workingHead,
    ...(flattened ? { flattened } : {}),
  };
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

/** `patch-id commit` pairs for the non-merge commits in `revs`. */
async function patchIds(
  io: SessionWorktreeIo,
  revs: string[],
): Promise<Map<string, string> | null> {
  const res = await io.exec(
    `git log -p --no-merges --format='commit %H' ${revs.map(shellQuote).join(' ')} | git patch-id --stable`,
    { timeoutMs: REBASE_TIMEOUT_MS },
  );
  if (res.exitCode !== 0) return null;
  const ids = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const [patchId, commit] = line.trim().split(/\s+/);
    if (patchId && commit) ids.set(commit, patchId);
  }
  return ids;
}

/**
 * True only when the retarget recorded as (`targetSha`, `forkSha`) is provably
 * finished:
 *  1. HEAD contains the pinned target tip, and
 *  2. none of the old-base commits the session inherited (`forkSha ^targetSha`)
 *     reached HEAD past that tip, neither literally nor as a rewritten copy
 *     with the same patch-id (a plain `git rebase origin/<target>` produces
 *     exactly those copies).
 * "No old-base-only commits" alone is not enough: when the target descends
 * from the old base, a session that never moved satisfies it. An open
 * operation, a missing record, or any git failure answers false so callers
 * keep the pending base.
 */
export async function isRetargetComplete(
  io: SessionWorktreeIo,
  opts: { targetSha: string | null | undefined; forkSha: string | null | undefined },
): Promise<boolean> {
  const targetSha = opts.targetSha?.trim() ?? '';
  const forkSha = opts.forkSha?.trim() ?? '';
  if (!SHA_RE.test(targetSha) || !SHA_RE.test(forkSha)) return false;
  // Mid-rebase HEAD is a partial replay; it says nothing about completion.
  const state = await readWorktreeState(io);
  if ('error' in state || state.operation) return false;
  if (!(await refExists(io, targetSha)) || !(await refExists(io, forkSha))) return false;
  const contains = await git(io, ['merge-base', '--is-ancestor', targetSha, 'HEAD']);
  if (!contains.ok) return false;

  const inheritedRes = await git(io, ['rev-list', forkSha, `^${targetSha}`]);
  if (!inheritedRes.ok) return false;
  const inherited = inheritedRes.stdout.split('\n').filter(Boolean);
  if (inherited.length === 0) return true;
  const movedRes = await git(io, ['rev-list', 'HEAD', `^${targetSha}`]);
  if (!movedRes.ok) return false;
  const moved = new Set(movedRes.stdout.split('\n').filter(Boolean));
  if (inherited.some((sha) => moved.has(sha))) return false;
  if (moved.size === 0) return true;
  const [inheritedIds, movedIds] = await Promise.all([
    patchIds(io, [forkSha, `^${targetSha}`]),
    patchIds(io, ['HEAD', `^${targetSha}`]),
  ]);
  if (!inheritedIds || !movedIds) return false;
  const inheritedPatches = new Set(inheritedIds.values());
  return ![...movedIds.values()].some((id) => inheritedPatches.has(id));
}

/**
 * The exact move a pending retarget needs, as recorded at hand-off. Every
 * consumer (automatic retry, agent prompts, completion check) works from
 * these SHAs, never from live branch names: the old branch can move after
 * the hand-off (even absorb the session's own commits), and a fork point
 * re-derived from it would silently drop work from the replay.
 */
export interface RetargetMove {
  /** Pinned target tip the session commits must land on. */
  targetSha: string;
  /** Session fork point with the old base; `forkSha..HEAD` is the session's work. */
  forkSha: string;
  /** HEAD at hand-off; must stay an ancestor of HEAD (append-only) until the move. */
  headSha: string;
}

/**
 * The one procedure that finishes a retarget, shared by every prompt so the
 * guidance never diverges. It enforces the same preconditions as the
 * automatic retry before rewriting (history only appended since hand-off, no
 * merge commits in the session range), then replays exactly the recorded
 * range onto the pinned tip, and ends with a range-diff over that range.
 */
export function retargetRebaseCommands(move: RetargetMove): string[] {
  const { targetSha, forkSha, headSha } = move;
  // One chain: any failed check stops it before the rebase, and the exit
  // status says so. ORIG_HEAD (set by the rebase) survives
  // `git rebase --continue` in a fresh shell, unlike a shell variable.
  return [
    `git merge-base --is-ancestor ${headSha} HEAD \\`,
    `  && test -z "$(git rev-list --merges ${forkSha}..HEAD)" \\`,
    `  && git rebase --onto ${targetSha} ${forkSha} \\`,
    `  && git range-diff ${forkSha}..ORIG_HEAD ${targetSha}..HEAD`,
  ];
}

function retargetGuidance(move: RetargetMove): string[] {
  return [
    `After a conflict, finish with \`git rebase --continue\`, then verify with \`git range-diff ${move.forkSha}..ORIG_HEAD ${move.targetSha}..HEAD\`: every session commit, changed only by conflict fixes.`,
    'If the chain stops before rebasing, do not rewrite history to get past it. Stop and ask the user to select the target branch again in the branch picker: the Hub re-checks the history and normalizes it (including flattening merge commits) itself.',
    `- ancestry check failed: the branch was rewritten since the hand-off (\`git reset --hard ${move.headSha}\` restores the hand-off state).`,
    '- merge check failed: merge commits were added after the hand-off.',
    '',
    `The fork \`${move.forkSha.slice(0, 12)}\` and target \`${move.targetSha.slice(0, 12)}\` are pinned on purpose: do not recompute them from the branches, which may have moved.`,
  ];
}

/** Prompt for the agent turn that finishes a retarget the Hub could not. */
export function buildRetargetAgentPrompt(args: {
  fromBranch: string;
  toBranch: string;
  outcome: Extract<RetargetOutcome, { kind: 'conflict' } | { kind: 'dirty' } | { kind: 'unsafe' }>;
}): string {
  const { fromBranch, toBranch, outcome } = args;
  const move: RetargetMove = {
    targetSha: outcome.targetSha,
    forkSha: outcome.forkSha,
    headSha: outcome.headSha,
  };
  const lines = [
    `The user changed this session's target branch from \`${fromBranch}\` to \`${toBranch}\`. ` +
      `Your PR will now be opened against \`${toBranch}\`, so the session commits ` +
      `(\`${move.forkSha.slice(0, 12)}..HEAD\`) must move onto \`${toBranch}\` at \`${move.targetSha.slice(0, 12)}\`.`,
    '',
  ];
  if ('flattened' in outcome && outcome.flattened) {
    lines.push(
      `The session history had ${outcome.flattened.mergeCount} merge commit(s), which a rebase cannot replay, so the Hub combined the session commits into one commit with the identical tree. The original history is kept at \`${outcome.flattened.backupRef}\`.`,
      '',
    );
  }
  if (outcome.kind === 'dirty') {
    lines.push(
      'The Hub did not rebase because the worktree has uncommitted changes. Commit them on top of the current branch first (do not stash them away or reset), then:',
    );
  } else if (outcome.kind === 'unsafe') {
    lines.push(
      `The Hub did not rebase automatically because ${outcome.reason}. The worktree is unchanged. Move it yourself:`,
    );
  } else {
    lines.push(
      `The Hub tried \`git rebase --onto ${move.targetSha.slice(0, 12)} ${move.forkSha.slice(0, 12)}\` and hit conflicts in:`,
      ...outcome.files.map((f) => `- \`${f}\``),
      '',
      'The rebase was aborted, so the worktree is unchanged. Redo it and resolve the conflicts:',
    );
  }
  lines.push(
    '',
    '```',
    ...retargetRebaseCommands(move),
    '```',
    '',
    ...retargetGuidance(move),
    '',
    `A plain \`git rebase origin/${toBranch}\` would also pull in commits from \`${fromBranch}\`. ` +
      'Resolve each conflict keeping the intent of the session commits, `git add` the files, `git rebase --continue`, and re-run the tests you touched. ' +
      'Stay on the current branch and do not push.',
  );
  return lines.join('\n');
}

/**
 * Per-turn reminder of the session's chosen target branch. While a retarget
 * is unfinished (`pending`), a plain rebase would replay old-base commits, so
 * the reminder repeats the recorded procedure instead. A record without its
 * SHAs cannot be completed safely by hand, so it asks for a re-selection.
 */
export function buildSessionTargetPromptNote(
  target: string,
  pending?: ({ fromBranch: string } & Partial<Record<keyof RetargetMove, string | null>>) | null,
): string {
  if (pending?.fromBranch && pending.fromBranch !== target) {
    const head =
      `\n\n[target branch, REBASE PENDING] This session targets \`${target}\`, but its commits ` +
      `still sit on \`${pending.fromBranch}\`.`;
    const { targetSha, forkSha, headSha } = pending;
    if (!targetSha || !forkSha || !headSha) {
      return (
        `${head} The move is not recorded completely, so do not rebase by hand: ask the user to ` +
        `select \`${target}\` again in the branch picker.`
      );
    }
    const move = { targetSha, forkSha, headSha };
    return (
      `${head} Finish the move (resolve conflicts, then \`git rebase --continue\`):\n` +
      '```\n' +
      retargetRebaseCommands(move).join('\n') +
      '\n```\n' +
      retargetGuidance(move).join('\n') +
      `\nDo not run a plain \`git rebase origin/${target}\` until this is done: ` +
      `it would replay \`${pending.fromBranch}\` commits.`
    );
  }
  return (
    `\n\n[target branch] This session targets \`${target}\`: Finalize rebases onto ` +
    `\`origin/${target}\` and opens the PR against it. When you rebase, use ` +
    `\`git fetch origin ${target} && git rebase origin/${target}\`, not any other branch this ` +
    'session targeted earlier. A rebase drops merge commits, so flatten any first ' +
    '(`git rev-list --merges` lists them).'
  );
}

/**
 * Whether a recorded retarget can be retried from its recorded fork: true, or
 * the reason it cannot. Usable only while the hand-off HEAD is still an
 * ancestor of HEAD (the agent appended commits, e.g. committing a dirty tree)
 * and the fork is still below HEAD. A rewritten history (a plain rebase, a
 * reset) fails this, and no fork point derived from it can be trusted.
 */
async function recordedRetargetUsable(
  io: SessionWorktreeIo,
  recorded: { forkSha: string; headSha: string },
): Promise<true | string> {
  if (!SHA_RE.test(recorded.forkSha) || !SHA_RE.test(recorded.headSha)) {
    return 'the pending retarget record is incomplete';
  }
  for (const sha of [recorded.headSha, recorded.forkSha]) {
    const res = await git(io, ['merge-base', '--is-ancestor', sha, 'HEAD']);
    if (!res.ok) {
      return (
        `the branch history was rewritten since the retarget was handed off and does not complete it. ` +
        `Finish the \`git rebase --onto\` from the hand-off, or restore with ` +
        `\`git reset --hard ${recorded.headSha.slice(0, 12)}\`, then retry`
      );
    }
  }
  return true;
}

export interface PendingRetargetRecord {
  fromBranch: string;
  targetSha: string | null;
  forkSha: string | null;
  headSha: string | null;
}

export type RetargetPlan =
  /** Refuse without changing anything (target or record). */
  | { kind: 'refuse'; status: 409 | 502; error: string }
  /** HEAD already sits on `fromBranch === toBranch`: store the target, clear any record. */
  | { kind: 'unchanged'; fromBranch: string }
  /** Run {@link retargetSessionWorktree}. `recorded` is set for a retry. */
  | {
      kind: 'rewrite';
      fromBranch: string;
      recorded?: { forkSha: string; headSha: string };
    };

/**
 * The single decision for a target change on a provisioned worktree. Order is
 * the contract: the worktree precondition first (no open operation, on a
 * branch), so no path, including switching back to the original base, can
 * clear or rewrite anything while git is mid-operation. Then the pending
 * record, if any, is the only source of truth: a finished one is retired, an
 * unfinished one is retried from its recorded fork or refused, never
 * re-derived from the live worktree.
 */
export async function planRetarget(
  io: SessionWorktreeIo,
  args: {
    effectiveTarget: string;
    toBranch: string;
    pending: PendingRetargetRecord | null;
  },
): Promise<{ plan: RetargetPlan; pendingFinished: boolean }> {
  const state = await readWorktreeState(io);
  if ('error' in state) {
    return { plan: { kind: 'refuse', status: 502, error: state.error }, pendingFinished: false };
  }
  if (state.operation || !state.branch) {
    const reason = state.operation
      ? `a ${state.operation} is already in progress in the worktree`
      : 'HEAD is detached';
    return {
      plan: { kind: 'refuse', status: 409, error: `Cannot change the target branch: ${reason}` },
      pendingFinished: false,
    };
  }

  const pending = args.pending?.fromBranch ? args.pending : null;
  let pendingFinished = false;
  if (pending) {
    pendingFinished = await isRetargetComplete(io, {
      targetSha: pending.targetSha,
      forkSha: pending.forkSha,
    });
  }
  if (!pending || pendingFinished) {
    const fromBranch = args.effectiveTarget;
    return {
      plan:
        fromBranch === args.toBranch
          ? { kind: 'unchanged', fromBranch }
          : { kind: 'rewrite', fromBranch },
      pendingFinished,
    };
  }

  const recorded = { forkSha: pending.forkSha ?? '', headSha: pending.headSha ?? '' };
  const usable = await recordedRetargetUsable(io, recorded);
  if (usable !== true) {
    return {
      plan: { kind: 'refuse', status: 409, error: `Cannot change the target branch: ${usable}` },
      pendingFinished: false,
    };
  }
  // HEAD still extends the hand-off HEAD, which sat on the old base.
  if (pending.fromBranch === args.toBranch) {
    return { plan: { kind: 'unchanged', fromBranch: pending.fromBranch }, pendingFinished: false };
  }
  return {
    plan: { kind: 'rewrite', fromBranch: pending.fromBranch, recorded },
    pendingFinished: false,
  };
}

/**
 * The base a session's commits still sit on when an earlier retarget is
 * unfinished, or null when there is none. Clears the record (via `clear`)
 * only once {@link isRetargetComplete} proves the move happened, so every
 * caller sees the same answer without its own bookkeeping.
 */
export async function pendingRetargetBase(args: {
  pendingFrom: string | null | undefined;
  pendingToSha: string | null | undefined;
  pendingForkSha: string | null | undefined;
  io: SessionWorktreeIo;
  clear: () => void;
}): Promise<string | null> {
  const pendingFrom = args.pendingFrom?.trim() || null;
  if (!pendingFrom) return null;
  if (
    await isRetargetComplete(args.io, {
      targetSha: args.pendingToSha,
      forkSha: args.pendingForkSha,
    })
  ) {
    args.clear();
    return null;
  }
  return pendingFrom;
}

type RetargetSessionFields = Pick<
  SessionRow,
  'id' | 'pr_base_pending_from' | 'pr_base_pending_to_sha' | 'pr_base_pending_fork_sha'
> & {
  worktree_path?: string | null;
};

/**
 * Re-check a recorded pending retarget before a gate reads it. Returns the
 * session with the record cleared (and persisted via `clear`) when the move
 * is proven finished; otherwise unchanged, so `resolveFinalizeGateBase` keeps
 * failing closed. Errors leave it pending.
 */
export async function settleSessionRetarget<S extends RetargetSessionFields>(args: {
  session: S;
  io?: SessionWorktreeIo;
  clear: () => void;
}): Promise<S> {
  const { session } = args;
  if (!session.pr_base_pending_from?.trim() || !session.worktree_path) return session;
  try {
    const io = args.io ?? (await sessionWorktreeIoFor(session.id, session.worktree_path));
    const still = await pendingRetargetBase({
      pendingFrom: session.pr_base_pending_from,
      pendingToSha: session.pr_base_pending_to_sha,
      pendingForkSha: session.pr_base_pending_fork_sha,
      io,
      clear: args.clear,
    });
    return still
      ? session
      : {
          ...session,
          pr_base_pending_from: null,
          pr_base_pending_to_sha: null,
          pr_base_pending_fork_sha: null,
        };
  } catch {
    return session;
  }
}

/**
 * The per-turn target note for a chat turn, or '' for none. Sessions that
 * never touched the picker get nothing (their prompt already names the base).
 * Once the target was changed (`pr_base_target_changed`), every turn restates
 * the effective target, so clearing an override back to the card/epic or repo
 * default also reaches a resumed engine that was told about the old target.
 */
export function sessionTargetNoteFor(args: {
  session: Pick<
    SessionRow,
    | 'pr_base_branch'
    | 'pr_base_target_changed'
    | 'pr_base_pending_to_sha'
    | 'pr_base_pending_fork_sha'
    | 'pr_base_pending_head_sha'
  >;
  /** session target -> card -> epic -> repo default, already resolved. */
  effectiveTarget: string | null;
  pendingFrom: string | null;
}): string {
  const { session, effectiveTarget, pendingFrom } = args;
  const changed = Number(session.pr_base_target_changed ?? 0) === 1;
  const target = pendingFrom || changed ? effectiveTarget : session.pr_base_branch?.trim() || null;
  if (!target) return '';
  return buildSessionTargetPromptNote(
    target,
    pendingFrom
      ? {
          fromBranch: pendingFrom,
          targetSha: session.pr_base_pending_to_sha ?? null,
          forkSha: session.pr_base_pending_fork_sha ?? null,
          headSha: session.pr_base_pending_head_sha ?? null,
        }
      : null,
  );
}
