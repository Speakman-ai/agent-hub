/**
 * Land one validated commit on the default branch for a mainline Autopilot
 * session.
 *
 * Order matters, and each step is a spec invariant
 * (wiki: autopilot-mainline-mode-spec-default-branch-deploy-verification):
 *   1. The slot must be `idle`; otherwise refuse and push nothing.
 *   2. The origin must be the project's own repo (GitHub or Hub-hosted).
 *   3. Move the slot to `pushing` with a compare-and-set, then read the row
 *      back. If the intent did not stick, push nothing.
 *   4. Push exactly `<sha>:refs/heads/<default>`, no tags.
 *   5. Only the destination ref's porcelain line decides the outcome, never
 *      the exit code: a tag or another ref failing must not hide a landed
 *      branch, and a transport error after the remote accepted the ref must
 *      not read as "not pushed".
 */
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { Project } from '../types.js';
import { parseAutopilotSessionConfig } from '../../shared/utils/sessionAutopilot.js';
import type { MainlineSlot } from '../../shared/utils/autopilotMainlineSlot.js';
import { transitionMainlineSlot, type AutopilotRowStmts } from '../session-autopilot-slot.js';
import { assertWorktreeOriginMatchesProject } from './origin-guard.js';
import { readOriginPushUrls } from './branch-facts.js';
import { assertHostedOriginMatchesProject } from './push-and-create-pr-agenthub.js';

const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;

export function defaultBranchRef(defaultBranch: string): string {
  return `refs/heads/${defaultBranch}`;
}

/** argv (after `git`) for the one-ref, no-tags push. */
export function buildDefaultBranchPushArgs(sha: string, defaultBranch: string): string[] {
  return [
    '-c',
    'push.followTags=false',
    'push',
    '--porcelain',
    '--no-follow-tags',
    'origin',
    `${sha}:${defaultBranchRef(defaultBranch)}`,
  ];
}

export type DefaultBranchPushOutcome = 'landed' | 'rejected' | 'unknown';

export interface DefaultBranchPushClassification {
  outcome: DefaultBranchPushOutcome;
  /** The destination ref's porcelain line(s), one per endpoint that reported. */
  line: string | null;
}

type EndpointResult = DefaultBranchPushOutcome | 'missing';

/** One endpoint's destination line, classified. */
function classifyDestinationLine(parts: string[]): DefaultBranchPushOutcome {
  const flag = parts[0];
  if (flag === ' ' || flag === '+' || flag === '*' || flag === '=') return 'landed';
  if (flag === '!') {
    const summary = (parts[2] ?? '').trim();
    return /^\[(?:rejected|remote rejected)\](?:\s|$)/.test(summary) ? 'rejected' : 'unknown';
  }
  return 'unknown';
}

/**
 * Classify a `git push --porcelain` stdout by the destination ref's lines.
 *
 * `git push origin` writes to every push URL of the remote, and porcelain
 * prints one `To <url>` section per endpoint, each with its own ref lines
 * (`<flag>\t<from>:<to>\t<summary>`). A single line is only one endpoint's
 * answer, so the outcome combines all of them:
 * - landed: every endpoint reports ` ` (fast-forward), `+` (forced),
 *   `*` (new ref), or `=` (already there);
 * - rejected: every endpoint refused the ref outright, with `[rejected]`
 *   (git refused before sending, e.g. non-fast-forward) or `[remote rejected]`
 *   (the remote reported `ng`);
 * - unknown: anything else. That covers mixed answers, a missing line or
 *   endpoint, and `!` summaries such as `[remote failure]` (the remote's
 *   status report was lost, possibly after it updated the ref). Only a later
 *   remote check can settle those.
 *
 * `expectedEndpoints` is how many push URLs the remote had; an endpoint that
 * printed nothing counts as unknown.
 */
export function classifyDefaultBranchPush(
  stdout: string,
  destinationRef: string,
  expectedEndpoints = 1,
): DefaultBranchPushClassification {
  const endpoints: EndpointResult[] = [];
  const lines: string[] = [];
  let current = -1;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('To ')) {
      endpoints.push('missing');
      current = endpoints.length - 1;
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const refspec = parts[1] ?? '';
    const colon = refspec.indexOf(':');
    const to = colon >= 0 ? refspec.slice(colon + 1) : refspec;
    if (to !== destinationRef) continue;
    if (current < 0) {
      endpoints.push('missing');
      current = 0;
    }
    lines.push(line);
    const result = classifyDestinationLine(parts);
    // Two lines for one ref in one section should not happen; if it does,
    // anything but agreement is unknown.
    const prior = endpoints[current];
    endpoints[current] = prior === 'missing' || prior === result ? result : 'unknown';
  }
  while (endpoints.length < expectedEndpoints) endpoints.push('missing');

  const line = lines.length ? lines.join('\n') : null;
  if (endpoints.length === 0) return { outcome: 'unknown', line };
  if (endpoints.every((e) => e === 'landed')) return { outcome: 'landed', line };
  if (endpoints.every((e) => e === 'rejected')) return { outcome: 'rejected', line };
  return { outcome: 'unknown', line };
}

export interface GitRunResult {
  /** Null when git was killed, timed out, or never spawned. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type DefaultBranchGitRunner = (
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv | undefined },
) => Promise<GitRunResult>;

/** Runs git and returns its output whatever the exit; never throws. */
export const runGitCapturingOutput: DefaultBranchGitRunner = (argv, opts) =>
  new Promise((resolve) => {
    execFile(
      'git',
      argv,
      { cwd: opts.cwd, env: opts.env, timeout: PUSH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errOut = String(stderr ?? '');
        if (!err) return resolve({ exitCode: 0, stdout: out, stderr: errOut });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        const exitCode = typeof e.code === 'number' && !e.killed ? e.code : null;
        resolve({
          exitCode,
          stdout: out,
          stderr: errOut || (typeof e.message === 'string' ? e.message : ''),
        });
      },
    );
  });

export type MainlineOriginGuard = (args: {
  project: Pick<Project, 'id' | 'cwd' | 'githubRepo' | 'repoUrl' | 'gitHost'>;
  worktreePath: string;
  env: NodeJS.ProcessEnv | undefined;
}) => Promise<void>;

/**
 * The worktree's origin must be this project's repo, on either host, and
 * must have exactly one push URL. With several, one `git push` lands on some
 * endpoints and not others, and no single result says whether the default
 * branch moved.
 */
export const assertMainlineOrigin: MainlineOriginGuard = async ({ project, worktreePath, env }) => {
  if (project.gitHost === 'agenthub') {
    await assertHostedOriginMatchesProject(project.id, worktreePath);
  } else {
    await assertWorktreeOriginMatchesProject(project, worktreePath, env);
  }
  const urls = await readOriginPushUrls(worktreePath, env);
  if (urls.length !== 1) {
    throw new Error(
      `default-branch push refused: origin has ${urls.length} push URLs; ` +
        `a mainline push needs exactly one so its result is unambiguous.`,
    );
  }
};

export type MainlinePushRefusal =
  | 'not_mainline'
  | 'slot_busy'
  | 'slot_write_failed'
  | 'origin_refused';

export type MainlinePushResult =
  | { kind: 'refused'; reason: MainlinePushRefusal; message: string; slot: MainlineSlot | null }
  | {
      kind: DefaultBranchPushOutcome;
      attemptId: string;
      line: string | null;
      detail: string;
      /** Whether the slot write for the outcome went through. */
      slotRecorded: boolean;
    };

function readMainlineSlot(stmts: AutopilotRowStmts, sessionId: string): MainlineSlot | null {
  const row = stmts.getSession.get(sessionId) as
    | { autopilot_session_config?: string | null }
    | undefined;
  const cfg = parseAutopilotSessionConfig(row?.autopilot_session_config ?? null);
  if (!cfg || cfg.target !== 'mainline' || !cfg.mainline) return null;
  return cfg.mainline.slot;
}

function describeGitResult(result: GitRunResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('\n');
  const code = result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`;
  return text ? `${code}: ${text}` : code;
}

export async function pushValidatedCommitToDefaultBranch(args: {
  stmts: AutopilotRowStmts;
  sessionId: string;
  project: Pick<Project, 'id' | 'cwd' | 'githubRepo' | 'repoUrl' | 'gitHost'>;
  worktreePath: string;
  sha: string;
  defaultBranch: string;
  env: NodeJS.ProcessEnv | undefined;
  git?: DefaultBranchGitRunner;
  guardOrigin?: MainlineOriginGuard;
  mintAttemptId?: () => string;
  log?: (message: string) => void;
}): Promise<MainlinePushResult> {
  const { stmts, sessionId, project, worktreePath, sha, defaultBranch, env } = args;
  const git = args.git ?? runGitCapturingOutput;
  const guardOrigin = args.guardOrigin ?? assertMainlineOrigin;
  const log = args.log ?? ((m: string) => console.warn(m));

  const before = readMainlineSlot(stmts, sessionId);
  if (!before) {
    return {
      kind: 'refused',
      reason: 'not_mainline',
      message: 'This session is not a default-branch Autopilot session.',
      slot: null,
    };
  }
  if (before.phase !== 'idle') {
    return {
      kind: 'refused',
      reason: 'slot_busy',
      message: `The previous landing is still ${before.phase}; this push waits until it finishes.`,
      slot: before,
    };
  }

  try {
    await guardOrigin({ project, worktreePath, env });
  } catch (err) {
    return {
      kind: 'refused',
      reason: 'origin_refused',
      message: err instanceof Error ? err.message : String(err),
      slot: before,
    };
  }

  const attemptId = (args.mintAttemptId ?? uuidv4)();
  const begin = transitionMainlineSlot({
    stmts,
    sessionId,
    expect: { phase: 'idle', attemptId: null },
    event: { type: 'begin_push', attemptId, sha },
  });
  if (!begin.wrote) {
    const busy = begin.reason === 'stale' && begin.slot !== null && begin.slot.phase !== 'idle';
    return {
      kind: 'refused',
      reason: busy ? 'slot_busy' : 'slot_write_failed',
      message: busy
        ? `The previous landing is still ${begin.slot!.phase}; this push waits until it finishes.`
        : `Could not record the push intent (${begin.reason}); nothing was pushed.`,
      slot: begin.slot,
    };
  }

  // Prove the intent is durable before touching the remote.
  const stored = readMainlineSlot(stmts, sessionId);
  if (
    !stored ||
    stored.phase !== 'pushing' ||
    stored.attemptId !== attemptId ||
    stored.sha !== sha
  ) {
    return {
      kind: 'refused',
      reason: 'slot_write_failed',
      message: 'The push intent did not persist; nothing was pushed.',
      slot: stored,
    };
  }

  const destination = defaultBranchRef(defaultBranch);
  let result: GitRunResult;
  try {
    result = await git(buildDefaultBranchPushArgs(sha, defaultBranch), {
      cwd: worktreePath,
      env,
    });
  } catch (err) {
    result = {
      exitCode: null,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
  const { outcome, line } = classifyDefaultBranchPush(result.stdout, destination);
  const detail = line ?? describeGitResult(result);

  const event =
    outcome === 'landed'
      ? ({ type: 'push_landed' } as const)
      : outcome === 'rejected'
        ? ({ type: 'push_rejected' } as const)
        : ({ type: 'push_unknown' } as const);
  const recorded = transitionMainlineSlot({
    stmts,
    sessionId,
    expect: { phase: 'pushing', attemptId },
    event,
  });
  if (!recorded.wrote) {
    // The slot moved under us (or the row is unreadable). Leave it: a stored
    // `pushing` slot is swept to `uncertain` and checked against the remote.
    log(
      `[finalize-mainline] session=${sessionId} attempt=${attemptId} push ${outcome} but the slot ` +
        `write was refused (${recorded.reason})`,
    );
  }
  return { kind: outcome, attemptId, line, detail, slotRecorded: recorded.wrote };
}
