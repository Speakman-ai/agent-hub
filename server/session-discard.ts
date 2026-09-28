/**
 * Resolve a session by throwing its worktree changes away.
 *
 * Without this a session with changes could only leave the "changes ready"
 * state by shipping a PR (or being archived). The discard path resets the
 * worktree to the point where the session branch forked from its base,
 * removes untracked files, clears `changes_ready`, and stamps `discarded_at`.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  ActiveTaskRow,
  BroadcastFn,
  KanbanCardRow,
  KanbanEpicRow,
  AppConfig,
  MessageRow,
  Project,
  SessionRow,
  Stmts,
} from './types.js';
import type { SessionWorktreeIo } from './session-env/worktree-io.js';
import { isSessionChatBusy } from './session-chat-busy.js';
import { isSessionShipInFlight } from './session-ship.js';
import { resolveFinalizeGateBase } from './finalize/resolve-base-branch.js';
import { isAgentHubHosted } from './native-pr/host.js';
import { parseGithubRemote } from './github-remote-owner.js';
import { lookupGithubOpenPr, type BranchPrState } from './github-branch-pr.js';
import {
  releaseSessionWorktreeLock,
  tryAcquireSessionWorktreeLock,
} from './session-worktree-lock.js';

export const DISCARD_SYSTEM_MESSAGE =
  'Session changes discarded. The worktree was reset to its base branch and untracked files were removed.';

export type DiscardSessionChangesResult =
  | { ok: true; baseRef: string; baseSha: string; discardedAt: string | null }
  | { ok: false; status: number; error: string; code: string };

type DiscardStmts = Pick<
  Stmts,
  | 'getActiveTask'
  | 'getUnfinishedFinalizeRunForSession'
  | 'getOpenPullRequestByHeadBranch'
  | 'getKanbanCardBySession'
  | 'getKanbanEpic'
  | 'markSessionChangesDiscarded'
  | 'addMessage'
  | 'getMessageById'
  | 'touchSession'
  | 'getSession'
>;

export interface DiscardSessionChangesArgs {
  session: SessionRow;
  project: Pick<Project, 'id' | 'gitHost' | 'githubRepo'>;
  config: Pick<AppConfig, 'personalOAuth'>;
  stmts: DiscardStmts;
  activeProcesses: ReadonlyMap<string, unknown>;
  broadcast: BroadcastFn;
  /** Resolves the worktree seam. Called with the session worktree lock held. */
  getIo: () => Promise<SessionWorktreeIo>;
  /** Replays turns that queued behind the discard. */
  drainQueue?: (sessionId: string) => void;
}

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function refuse(status: number, code: string, error: string): DiscardSessionChangesResult {
  return { ok: false, status, error, code };
}

/**
 * Thrown by any pre-reset check that cannot establish a fact. Discard is
 * destructive, so every check fails closed: the caller turns this into a 409
 * and reset/clean never run.
 */
class DiscardRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type ProbeResult = { kind: 'ok'; stdout: string } | { kind: 'absent' };

/**
 * Run a read-only git probe. Exit 0 is an answer; `absentExit` is the exit
 * code git documents for "the thing you asked about does not exist" (e.g.
 * `rev-parse --verify --quiet` and `symbolic-ref --quiet` exit 1). Any other
 * exit, a signal, or a thrown error is a failed probe, never an answer.
 */
async function probe(
  io: SessionWorktreeIo,
  argv: string[],
  failure: { code: string; what: string; absentExit?: number },
): Promise<ProbeResult> {
  let out: Awaited<ReturnType<SessionWorktreeIo['git']>>;
  try {
    out = await io.git(argv);
  } catch (err) {
    throw new DiscardRefusal(
      failure.code,
      `Could not ${failure.what}: ${(err as Error).message.split('\n')[0]}`,
    );
  }
  if (out.exitCode === 0) return { kind: 'ok', stdout: out.stdout.trim() };
  if (failure.absentExit !== undefined && out.exitCode === failure.absentExit) {
    return { kind: 'absent' };
  }
  const detail = out.stderr.trim().split('\n')[0] || `exit ${String(out.exitCode)}`;
  throw new DiscardRefusal(failure.code, `Could not ${failure.what}: ${detail}`);
}

/** Like {@link probe} with no absent case, and empty output is also a failure. */
async function probeValue(
  io: SessionWorktreeIo,
  argv: string[],
  failure: { code: string; what: string },
): Promise<string> {
  const result = await probe(io, argv, failure);
  if (result.kind !== 'ok' || !result.stdout) {
    throw new DiscardRefusal(failure.code, `Could not ${failure.what}: git printed nothing`);
  }
  return result.stdout;
}

/** A path or file:// origin is a local clone source, not a PR host. */
function isLocalRemote(url: string): boolean {
  return url.startsWith('/') || url.startsWith('file://') || url.startsWith('.');
}

const PR_UNKNOWN = 'pr_state_unknown';

/**
 * The GitHub `owner/repo` to ask about PRs, or null when the worktree has
 * confirmably no PR host (no `origin`, or a local-path origin).
 */
async function resolveGithubRepo(
  project: DiscardSessionChangesArgs['project'],
  io: SessionWorktreeIo,
): Promise<string | null> {
  const configured = project.githubRepo?.trim();
  if (configured) {
    if (!REPO_SLUG_RE.test(configured)) {
      throw new DiscardRefusal(PR_UNKNOWN, `Invalid githubRepo "${configured}" on the project`);
    }
    return configured;
  }
  // `git remote` exits 0 with an empty list when there are no remotes, so
  // only a successful listing can prove origin is absent.
  const remotes = await probe(io, ['remote'], { code: PR_UNKNOWN, what: 'list git remotes' });
  const names = remotes.kind === 'ok' ? remotes.stdout.split('\n').map((r) => r.trim()) : [];
  if (!names.includes('origin')) return null;
  const url = await probeValue(io, ['remote', 'get-url', 'origin'], {
    code: PR_UNKNOWN,
    what: 'read the origin remote URL',
  });
  if (isLocalRemote(url)) return null;
  const parsed = parseGithubRemote(url);
  if (!parsed) {
    throw new DiscardRefusal(PR_UNKNOWN, 'origin is not a GitHub remote, so PR state is unknown');
  }
  return `${parsed.owner}/${parsed.repo}`;
}

/**
 * Refuse when any branch has, or might have, an open PR. Agent Hub-hosted
 * projects are answered by the native `pull_requests` table; GitHub projects
 * are asked live through `gh`.
 */
async function assertNoOpenPr(
  args: DiscardSessionChangesArgs,
  io: SessionWorktreeIo,
  branches: string[],
): Promise<void> {
  const { project, stmts } = args;
  for (const branch of branches) {
    const native = stmts.getOpenPullRequestByHeadBranch.get(project.id, branch) as
      | { number?: number }
      | undefined;
    if (native) throw openPr(`#${native.number ?? '?'}`);
  }
  if (isAgentHubHosted(project)) return;

  const repo = await resolveGithubRepo(project, io);
  if (!repo) return;
  for (const branch of branches) {
    const pr: BranchPrState = await lookupGithubOpenPr({
      repo,
      branch,
      sessionId: args.session.id,
      config: args.config,
    });
    if (pr.kind === 'open') throw openPr(pr.ref);
    if (pr.kind !== 'none') {
      throw new DiscardRefusal(
        PR_UNKNOWN,
        `Could not confirm that no pull request is open for ${branch} (${pr.reason})`,
      );
    }
  }
}

function openPr(ref: string): DiscardRefusal {
  return new DiscardRefusal(
    'pr_open',
    `A pull request is open for this session's branch (${ref}) — close it before discarding`,
  );
}

/** Every branch name the session's work could be published under. */
async function resolveSessionBranches(
  session: SessionRow,
  io: SessionWorktreeIo,
): Promise<string[]> {
  const head = await probeValue(io, ['rev-parse', '--abbrev-ref', 'HEAD'], {
    code: 'branch_unresolved',
    what: 'read the checked-out branch',
  });
  const branches = new Set(
    [session.worktree_branch, head].filter((b): b is string => !!b && b !== 'HEAD'),
  );
  if (branches.size === 0) {
    throw new DiscardRefusal(
      'branch_unresolved',
      'The worktree is on a detached HEAD and the session has no recorded branch',
    );
  }
  return [...branches];
}

const BASE_UNRESOLVED = 'base_unresolved';

/** Whether `ref` names a commit: true, false when confirmed missing, throws otherwise. */
async function refExists(io: SessionWorktreeIo, ref: string): Promise<boolean> {
  const result = await probe(io, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    code: BASE_UNRESOLVED,
    what: `check for ${ref}`,
    absentExit: 1,
  });
  return result.kind === 'ok';
}

/**
 * The repo default branch: `origin/HEAD` when it is set, else local
 * `main`/`master`. Unlike the shared resolver, a failed probe refuses rather
 * than falling through to a guess.
 */
async function resolveDefaultBranchStrict(io: SessionWorktreeIo): Promise<string> {
  const symbolic = await probe(io, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    code: BASE_UNRESOLVED,
    what: 'read origin/HEAD',
    absentExit: 1,
  });
  if (symbolic.kind === 'ok') {
    const ref = symbolic.stdout.replace('refs/remotes/origin/', '');
    if (ref) return ref;
  }
  for (const candidate of ['main', 'master']) {
    if (await refExists(io, candidate)) return candidate;
  }
  throw new DiscardRefusal(BASE_UNRESOLVED, "Could not determine the session's base branch");
}

async function resolveBaseBranch(
  stmts: DiscardStmts,
  session: SessionRow,
  io: SessionWorktreeIo,
): Promise<string> {
  const card = stmts.getKanbanCardBySession.get(session.id) as KanbanCardRow | undefined;
  const gate = resolveFinalizeGateBase({
    card,
    worktreePath: session.worktree_path,
    getEpic: (epicId) => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
  });
  if (gate.kind === 'explicit') return gate.baseBranch;
  if (gate.kind === 'unresolved') {
    throw new DiscardRefusal(BASE_UNRESOLVED, "The linked card's PR base branch is invalid");
  }
  return resolveDefaultBranchStrict(io);
}

/**
 * The commit the session branch forked from. Prefers `origin/<base>` and
 * falls back to the local branch only when the remote-tracking ref is
 * confirmed missing, never because a probe failed.
 */
async function resolveForkPoint(
  io: SessionWorktreeIo,
  baseBranch: string,
): Promise<{ ref: string; sha: string }> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    if (!(await refExists(io, ref))) continue;
    // Exit 1 here means no common ancestor, which is also a refusal.
    const sha = await probeValue(io, ['merge-base', 'HEAD', ref], {
      code: BASE_UNRESOLVED,
      what: `find where the session branch forked from ${ref}`,
    });
    return { ref, sha };
  }
  throw new DiscardRefusal(BASE_UNRESOLVED, `Base branch ${baseBranch} does not exist locally`);
}

/**
 * Takes the session worktree lock before anything else and holds it through
 * reset/clean. Turn starts, multi-agent rounds, Finalize kickoff, branch
 * switches and ship all contend on the same lock (ship checks it directly),
 * so nothing can start writing to the worktree between these checks and the
 * reset.
 */
export async function discardSessionChanges(
  args: DiscardSessionChangesArgs,
): Promise<DiscardSessionChangesResult> {
  const { session } = args;
  const sessionId = session.id;

  if (!session.worktree_path) {
    return refuse(400, 'no_worktree', 'Session has no worktree — nothing to discard');
  }
  if (!tryAcquireSessionWorktreeLock(sessionId, 'discard')) {
    return refuse(
      409,
      'session_busy',
      'Another operation is using this session worktree — try again when it finishes',
    );
  }
  try {
    return await discardWithLockHeld(args);
  } catch (err) {
    if (err instanceof DiscardRefusal) return refuse(409, err.code, err.message);
    throw err;
  } finally {
    releaseSessionWorktreeLock(sessionId, 'discard');
    if (args.drainQueue) setImmediate(() => args.drainQueue?.(sessionId));
  }
}

async function discardWithLockHeld(
  args: DiscardSessionChangesArgs,
): Promise<DiscardSessionChangesResult> {
  const { session, stmts, activeProcesses, broadcast } = args;
  const sessionId = session.id;

  const activeTask = stmts.getActiveTask.get(sessionId) as ActiveTaskRow | undefined;
  if (isSessionChatBusy(sessionId, activeProcesses, activeTask)) {
    return refuse(
      409,
      'session_running',
      'Session is still running — wait for the turn to finish before discarding changes',
    );
  }
  if (isSessionShipInFlight(sessionId)) {
    return refuse(409, 'ship_in_progress', 'A PR is being created for this session');
  }
  if (stmts.getUnfinishedFinalizeRunForSession.get(sessionId)) {
    return refuse(
      409,
      'finalize_in_flight',
      'Finalize Code Changes is in progress for this session — cancel it before discarding',
    );
  }

  const io = await args.getIo();
  const branches = await resolveSessionBranches(session, io);
  await assertNoOpenPr(args, io, branches);
  const baseBranch = await resolveBaseBranch(stmts, session, io);
  const fork = await resolveForkPoint(io, baseBranch);

  await io.git(['reset', '--hard', fork.sha], { throwOnNonZero: true });
  // -fd, not -fdx: ignored files (node_modules, build output) are not
  // session changes and reinstalling them would cost the next turn minutes.
  await io.git(['clean', '-fd'], { throwOnNonZero: true });

  stmts.markSessionChangesDiscarded.run(sessionId);
  const discardedAt =
    (stmts.getSession.get(sessionId) as SessionRow | undefined)?.discarded_at ?? null;

  const msgId = uuidv4();
  const metadata = JSON.stringify({
    kind: 'changes_discarded',
    baseRef: fork.ref,
    baseSha: fork.sha,
  });
  try {
    stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      DISCARD_SYSTEM_MESSAGE,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
    stmts.touchSession.run(sessionId);
    const inserted = stmts.getMessageById.get(msgId) as MessageRow | undefined;
    if (inserted) broadcast({ type: 'message', message: inserted });
  } catch (err) {
    console.error('[session-discard] Failed to persist system message:', (err as Error).message);
  }

  broadcast({
    type: 'changes_discarded',
    sessionId,
    agentId: session.agent_id,
    discardedAt,
  });

  return { ok: true, baseRef: fork.ref, baseSha: fork.sha, discardedAt };
}
