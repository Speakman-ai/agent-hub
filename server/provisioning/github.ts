/**
 * GitHub provisioning — create a remote repository for a freshly
 * scaffolded project and push its initial commit using the local `gh`
 * CLI.
 *
 * Plug-in contract with the orchestrator (see `orchestrator.ts`):
 *   - The ProvisioningExecutor returned by `createGithubExecutor` handles
 *     the `mint-token`, `gh-create`, and `gh-push` phase ids. All other
 *     phases delegate to a supplied fallback (default: stub), so this
 *     module can compose with the template executor without either one
 *     knowing about the other.
 *   - Pre-flight (`gh --version`, `gh auth status`) runs at the top of
 *     the gh-create phase. When pre-flight fails, the phase fails with a
 *     structured `GithubProvisioningError` so the orchestrator can emit
 *     a `done.error` with an actionable hint (install gh, run gh auth
 *     login, rename the repo, …) rather than an opaque shell string.
 *
 * Phase → action mapping inside this module:
 *   mint-token   — noop for the local-gh path (`gh auth status`
 *                  already verified in gh-create). Kept so the phase
 *                  sequence stays identical to the GitHub-App
 *                  scaffold-builder path, which mints an installation
 *                  token at this step.
 *   gh-create    — pre-flight + `gh repo create <name> --private|--public
 *                  --source=. --remote=origin` (no --push; we split the
 *                  remote creation from the push so each surfaces as a
 *                  distinct phase event).
 *   gh-push      — create an initial commit iff the tree has none, then
 *                  `git push -u origin HEAD`.
 *
 * The `createGithubRepo` helper composes all three for callers (e.g.
 * ad-hoc scripts) that want to run the whole flow in one call outside
 * the orchestrator.
 *
 * Tests mock the spawner via the `spawn` option — see github.test.ts.
 */

import { spawn as childSpawn } from 'child_process';
import type {
  ExecutorPhaseCtx,
  ExecutorPhaseResult,
  ProvisioningExecutor,
  ProvisioningPhaseId,
  ProvisioningPayload,
} from './orchestrator.js';
import { stubExecutor } from './orchestrator.js';

/** Structured error codes surfaced in `done.error.message` / CLI stderr. */
export type GithubErrorCode =
  | 'GH_NOT_INSTALLED'
  | 'GH_NOT_AUTHENTICATED'
  | 'GH_NAME_TAKEN'
  | 'GH_CREATE_FAILED'
  | 'GIT_COMMIT_FAILED'
  | 'GIT_PUSH_FAILED'
  | 'GH_REMOTE_RESOLVE_FAILED';

export class GithubProvisioningError extends Error {
  readonly code: GithubErrorCode;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(
    code: GithubErrorCode,
    message: string,
    opts: { hint?: string; exitCode?: number } = {},
  ) {
    super(message);
    this.name = 'GithubProvisioningError';
    this.code = code;
    this.hint = opts.hint;
    // Map code → orchestrator exit code bucket (aligned with scaffold.sh
    // so external dashboards can reuse existing dispositions).
    this.exitCode = opts.exitCode ?? (code === 'GIT_COMMIT_FAILED' ? 4 : 5);
  }
}

export interface GithubSpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawner interface. Receives argv + cwd and yields the exit code and
 * captured output. Production path shells out to `gh` / `git`; tests
 * inject a fake that records the command sequence without touching the
 * network or disk.
 */
export type GithubSpawn = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; log: (line: string) => void; timeoutMs: number },
) => Promise<GithubSpawnResult>;

/** Real spawner — pipes stdout/stderr line-by-line into `log`. */
export const defaultGithubSpawn: GithubSpawn = (command, args, { cwd, log, timeoutMs }) => {
  return new Promise((resolve) => {
    log(`$ ${command} ${args.join(' ')}`);

    let child;
    try {
      child = childSpawn(command, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      // Synchronous spawn failure (typically ENOENT on Windows shims).
      // Surface as exit code -1 with the message on stderr so callers
      // classify it as GH_NOT_INSTALLED when the binary is `gh`.
      const msg = (err as Error)?.message ?? 'spawn failed';
      log(`[github] spawn error: ${msg}`);
      resolve({ exitCode: -1, signal: null, stdout: '', stderr: msg });
      return;
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      log(`[github] timed out after ${timeoutMs}ms — killing`);
      child.kill('SIGKILL');
    }, timeoutMs);

    const pipe = (stream: NodeJS.ReadableStream, buf: 'stdout' | 'stderr'): void => {
      let residual = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        if (buf === 'stdout') stdout += chunk;
        else stderr += chunk;
        residual += chunk;
        let idx = residual.indexOf('\n');
        while (idx >= 0) {
          log(residual.slice(0, idx));
          residual = residual.slice(idx + 1);
          idx = residual.indexOf('\n');
        }
      });
      stream.on('end', () => {
        if (residual.length > 0) log(residual);
      });
    };

    if (child.stdout) pipe(child.stdout, 'stdout');
    if (child.stderr) pipe(child.stderr, 'stderr');

    child.on('error', (err) => {
      // ENOENT fires here when `gh` / `git` aren't on PATH.
      log(`[github] spawn error: ${err.message}`);
      stderr += err.message;
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
};

export type RepoVisibility = 'public' | 'private' | 'internal';

export interface CreateGithubRepoOptions {
  /** Repo name (owner is inferred from the authed gh user/org). */
  name: string;
  /** Questionnaire value — `idk` / null default to `private`. */
  visibility?: string | null;
  /** Working directory — must already be a git repo (git-init phase ran). */
  cwd: string;
  /** Log sink — usually the orchestrator's `ctx.log`. */
  emit: (line: string) => void;
  /** Override the spawner (tests). */
  spawn?: GithubSpawn;
  /** Per-command timeout in ms (default 60s). */
  commandTimeoutMs?: number;
}

export interface CreateGithubRepoResult {
  repoUrl: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Normalize visibility from the adaptive-questionnaire payload.
 *
 * The questionnaire lets users answer `"idk"` (lean on the agent's
 * default). Spec: that routes to `private` — opt-in is safer than
 * opt-out for accidental public repos.
 */
export function resolveVisibility(raw: string | null | undefined): RepoVisibility {
  if (raw === 'public') return 'public';
  if (raw === 'internal') return 'internal';
  // 'private', 'idk', null, undefined, or anything unexpected → private.
  return 'private';
}

/** Pattern list for classifying `gh repo create` stderr as a name-taken error. */
const NAME_TAKEN_PATTERNS: readonly RegExp[] = [
  /name already exists/i,
  /repository.*already exists/i,
  /HTTP 422/,
];

function classifyCreateError(stderr: string, exitCode: number | null): GithubProvisioningError {
  if (NAME_TAKEN_PATTERNS.some((re) => re.test(stderr))) {
    return new GithubProvisioningError(
      'GH_NAME_TAKEN',
      'A repository with that name already exists on your GitHub account',
      { hint: 'Pick a different project name or delete the existing repo.', exitCode: 5 },
    );
  }
  return new GithubProvisioningError(
    'GH_CREATE_FAILED',
    `gh repo create failed${exitCode != null ? ` (exit ${exitCode})` : ''}${
      stderr ? `: ${stderr.trim().slice(-400)}` : ''
    }`,
    { hint: 'See the log above for the gh CLI output.', exitCode: 5 },
  );
}

/** Pre-flight: gh on PATH? authenticated? */
async function runPreflight(
  cwd: string,
  spawn: GithubSpawn,
  emit: (line: string) => void,
  timeoutMs: number,
): Promise<void> {
  const version = await spawn('gh', ['--version'], { cwd, log: emit, timeoutMs });
  if (version.exitCode !== 0) {
    throw new GithubProvisioningError(
      'GH_NOT_INSTALLED',
      'gh CLI is not installed or not on PATH',
      {
        hint: 'Install the GitHub CLI from https://cli.github.com/ and ensure `gh` is on PATH.',
        exitCode: 5,
      },
    );
  }

  const auth = await spawn('gh', ['auth', 'status'], { cwd, log: emit, timeoutMs });
  if (auth.exitCode !== 0) {
    throw new GithubProvisioningError('GH_NOT_AUTHENTICATED', 'gh CLI is not authenticated', {
      hint: 'Run `gh auth login` and try provisioning again.',
      exitCode: 5,
    });
  }
}

/** gh-create step: create empty remote + wire origin. */
async function runGhRepoCreate(opts: {
  name: string;
  visibility: RepoVisibility;
  cwd: string;
  spawn: GithubSpawn;
  emit: (line: string) => void;
  timeoutMs: number;
}): Promise<CreateGithubRepoResult> {
  const { name, visibility, cwd, spawn, emit, timeoutMs } = opts;
  const args = ['repo', 'create', name, `--${visibility}`, '--source=.', '--remote=origin'];
  const result = await spawn('gh', args, { cwd, log: emit, timeoutMs });
  if (result.exitCode !== 0) {
    throw classifyCreateError(result.stderr, result.exitCode);
  }

  // Prefer parsing the URL gh prints to stdout — it's already
  // normalized to https://github.com/<owner>/<repo>. Fall back to
  // `git remote get-url` if stdout is quiet (older gh builds).
  const stdoutUrl = extractRepoUrl(result.stdout);
  if (stdoutUrl) return { repoUrl: stdoutUrl };

  const remote = await spawn('git', ['remote', 'get-url', 'origin'], {
    cwd,
    log: emit,
    timeoutMs,
  });
  if (remote.exitCode !== 0) {
    throw new GithubProvisioningError(
      'GH_REMOTE_RESOLVE_FAILED',
      'repo created but `git remote get-url origin` failed; unable to resolve repoUrl',
      { hint: 'Open the workspace and inspect `git remote -v`.', exitCode: 5 },
    );
  }
  const repoUrl = normalizeRemoteUrl(remote.stdout.trim());
  if (!repoUrl) {
    throw new GithubProvisioningError(
      'GH_REMOTE_RESOLVE_FAILED',
      `unrecognised origin URL: ${remote.stdout.trim()}`,
      { exitCode: 5 },
    );
  }
  return { repoUrl };
}

/** Pull an https://github.com/... URL out of a stdout blob. */
function extractRepoUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/github\.com\/[^\s]+/);
  if (!match) return null;
  return match[0].replace(/\.git$/, '').replace(/[)\].,]+$/, '');
}

/** Normalize either SSH or HTTPS origin URLs to https://github.com/<owner>/<repo>. */
function normalizeRemoteUrl(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('git@github.com:')) {
    const tail = raw.replace(/^git@github\.com:/, '').replace(/\.git$/, '');
    return `https://github.com/${tail}`;
  }
  if (raw.startsWith('https://github.com/')) {
    return raw.replace(/\.git$/, '');
  }
  return null;
}

/** gh-push step: initial commit if needed, then `git push -u origin HEAD`. */
async function runGhPush(opts: {
  cwd: string;
  spawn: GithubSpawn;
  emit: (line: string) => void;
  timeoutMs: number;
}): Promise<void> {
  const { cwd, spawn, emit, timeoutMs } = opts;

  // Is there any existing commit?
  const head = await spawn('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    log: emit,
    timeoutMs,
  });
  if (head.exitCode !== 0) {
    // No commits yet — stage everything and create the scaffold commit.
    emit('[github] no commits found — creating initial scaffold commit');
    const add = await spawn('git', ['add', '.'], { cwd, log: emit, timeoutMs });
    if (add.exitCode !== 0) {
      throw new GithubProvisioningError(
        'GIT_COMMIT_FAILED',
        `git add failed (exit ${add.exitCode ?? -1}): ${add.stderr.trim().slice(-200)}`,
        { exitCode: 4 },
      );
    }
    const commit = await spawn('git', ['commit', '-m', 'Initial scaffold by Agent Hub'], {
      cwd,
      log: emit,
      timeoutMs,
    });
    if (commit.exitCode !== 0) {
      throw new GithubProvisioningError(
        'GIT_COMMIT_FAILED',
        `git commit failed (exit ${commit.exitCode ?? -1}): ${commit.stderr.trim().slice(-200)}`,
        { exitCode: 4 },
      );
    }
  }

  const push = await spawn('git', ['push', '-u', 'origin', 'HEAD'], {
    cwd,
    log: emit,
    timeoutMs,
  });
  if (push.exitCode !== 0) {
    throw new GithubProvisioningError(
      'GIT_PUSH_FAILED',
      `git push failed (exit ${push.exitCode ?? -1}): ${push.stderr.trim().slice(-400)}`,
      { hint: 'Inspect `git remote -v` in the workspace.', exitCode: 5 },
    );
  }
}

/**
 * Full create-and-push flow. Intended for ad-hoc callers (scripts,
 * one-shot UI actions). The orchestrator uses `createGithubExecutor`
 * below so each phase surfaces as a distinct event.
 */
export async function createGithubRepo(
  opts: CreateGithubRepoOptions,
): Promise<CreateGithubRepoResult> {
  const spawn = opts.spawn ?? defaultGithubSpawn;
  const timeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const visibility = resolveVisibility(opts.visibility);

  await runPreflight(opts.cwd, spawn, opts.emit, timeoutMs);
  const { repoUrl } = await runGhRepoCreate({
    name: opts.name,
    visibility,
    cwd: opts.cwd,
    spawn,
    emit: opts.emit,
    timeoutMs,
  });
  await runGhPush({ cwd: opts.cwd, spawn, emit: opts.emit, timeoutMs });
  return { repoUrl };
}

// ------------------------------------------------------------------
// Executor wiring
// ------------------------------------------------------------------

export interface GithubExecutorOptions {
  /** Resolve the workspace for a given projectId (same contract as the template executor). */
  resolveWorkspace: (projectId: string | null) => string;
  /** Override the spawner (tests). */
  spawn?: GithubSpawn;
  /** Per-command timeout in ms. */
  commandTimeoutMs?: number;
  /** Executor invoked for phases this module doesn't handle. Default: stub. */
  fallback?: ProvisioningExecutor;
}

function resolveRepoName(payload: ProvisioningPayload, fallback: string | null): string {
  if (typeof payload.name === 'string' && payload.name.trim() && payload.name !== 'idk') {
    return payload.name.trim();
  }
  if (fallback && fallback.trim()) return fallback;
  return 'new-project';
}

function toPhaseResultFromError(err: unknown, phase: ProvisioningPhaseId): ExecutorPhaseResult {
  if (err instanceof GithubProvisioningError) {
    return {
      status: 'failed',
      message: `${phase} failed: ${err.code}`,
      error: {
        code: err.exitCode,
        message: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
      },
    };
  }
  const msg = (err as Error)?.message ?? 'unknown github provisioning error';
  return {
    status: 'failed',
    message: `${phase} threw`,
    error: { code: 5, message: msg },
  };
}

/**
 * Build an executor that implements the GitHub phases of the
 * orchestrator sequence. Compose with the template executor via the
 * `fallback` option so one executor covers the whole pipeline:
 *
 *   const github = createGithubExecutor({
 *     resolveWorkspace,
 *     fallback: createTemplateExecutor({ resolveWorkspace }),
 *   });
 *   startProvisioningJob({ ..., executor: github });
 */
export function createGithubExecutor(opts: GithubExecutorOptions): ProvisioningExecutor {
  const {
    resolveWorkspace,
    spawn = defaultGithubSpawn,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    fallback = stubExecutor,
  } = opts;

  // gh-create → gh-push need to share the resolved repoUrl so the
  // orchestrator's terminal `done.repoUrl` is populated regardless of
  // which phase reports it. Keyed by jobId and cleared when gh-push
  // runs (or on a fresh gh-create for the same job, defensively).
  const jobState = new Map<string, { repoUrl: string }>();

  return {
    async runPhase(
      phase: ProvisioningPhaseId,
      ctx: ExecutorPhaseCtx,
    ): Promise<ExecutorPhaseResult> {
      if (phase === 'mint-token') {
        // Local-gh path relies on `gh auth status` (run inside gh-create).
        // We keep this phase visible in the event stream for parity with
        // the GitHub-App container path but do no real work here.
        ctx.log('[github] mint-token: using local `gh` auth (no installation token required)');
        return { status: 'ok', message: 'Using local gh CLI auth' };
      }

      if (phase === 'gh-create') {
        jobState.delete(ctx.jobId);
        const cwd = resolveWorkspace(ctx.projectId);
        const name = resolveRepoName(ctx.payload, ctx.projectId);
        const visibility = resolveVisibility(
          typeof ctx.payload.visibility === 'string' ? ctx.payload.visibility : null,
        );
        try {
          await runPreflight(cwd, spawn, ctx.log, commandTimeoutMs);
          const { repoUrl } = await runGhRepoCreate({
            name,
            visibility,
            cwd,
            spawn,
            emit: ctx.log,
            timeoutMs: commandTimeoutMs,
          });
          jobState.set(ctx.jobId, { repoUrl });
          return {
            status: 'ok',
            message: `Created ${repoUrl}`,
            repoUrl,
          };
        } catch (err: unknown) {
          return toPhaseResultFromError(err, phase);
        }
      }

      if (phase === 'gh-push') {
        const cwd = resolveWorkspace(ctx.projectId);
        try {
          await runGhPush({
            cwd,
            spawn,
            emit: ctx.log,
            timeoutMs: commandTimeoutMs,
          });
          const cached = jobState.get(ctx.jobId);
          jobState.delete(ctx.jobId);
          return {
            status: 'ok',
            message: 'Initial commit pushed',
            ...(cached ? { repoUrl: cached.repoUrl } : {}),
          };
        } catch (err: unknown) {
          return toPhaseResultFromError(err, phase);
        }
      }

      return fallback.runPhase(phase, ctx);
    },
  };
}
