/**
 * `<agenthub:preview target="fullstack">` handler.
 *
 * The per-session preview runtime (see `preview-runtime.ts` /
 * `preview-block.ts`) boots a worktree-local dev server — perfect for
 * UI-only changes, but it lies for backend or DB changes because the API
 * the client is hitting is whichever copy is running on the dev box.
 *
 * Fullstack target solves this by reusing the existing PR-env container
 * pool: we open a *draft* PR for the session's worktree branch, let the
 * existing webhook-driven dispatcher pick up the PR opened event and
 * spin a per-PR container, then poll the `pool_slots` table until that
 * slot is `busy`. The end-state preview URL follows the same
 * `<previewBaseUrl>/pr-<N>` convention as the regular PR-env path
 * (see `pr-env-builder.ts:229`).
 *
 * No new container code lives here — this module is pure orchestration:
 *   1. Gate on project/global PR-env config.
 *   2. Verify worktree has at least one commit.
 *   3. Resolve the current branch.
 *   4. Push the branch (idempotent — `git push -u origin <branch>`).
 *   5. `gh pr create --draft` (idempotent — if the PR already exists,
 *      `gh pr view --json url,number` resolves it).
 *   6. Poll `pool_slots` for `class='pr_env' AND pr_number=N AND
 *      status='busy'` until ready or timeout.
 *   7. Broadcast a `preview` event with `prUrl` + `prNumber` set so the
 *      chat client can render the "Draft PR #N" chip.
 *
 * Every error path funnels into a `preview_failed` (or
 * `preview_unavailable` for config-level gates) broadcast so the chat
 * UI always gets a final state. The handler is fire-and-forget from
 * chat.ts's perspective; nothing here throws to its caller.
 *
 * Tests: `fullstack-preview.test.ts` covers no-commits, project not
 * configured, happy path, PR-already-exists path, and container
 * never-ready timeout.
 */

import type { BroadcastFn, Project } from '../types.js';
import type {
  PreviewBroadcastEvent,
  PreviewMalformedReason,
  PreviewTask,
} from './preview-block.js';
import { isPrEnvKillSwitchOn } from '../pr-env-killswitch.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: readonly string[], cwd: string) => Promise<RunResult>;

/**
 * Slot-row shape we care about for "is the PR-env ready?". Mirrors a
 * subset of `pool_slots` (see `container-pool/schema.ts`). The handler
 * only reads `status`; everything else is here so tests can assert
 * which row was inspected.
 */
export interface PoolSlotRow {
  slot_id: string;
  class: 'pr_env' | 'scaffold' | 'overflow';
  status: 'free' | 'reserved' | 'busy' | 'draining' | 'failed';
  container_id: string | null;
  pr_number: number | null;
}

export interface FullstackPreviewDeps {
  broadcast: BroadcastFn;
  project: Project;
  /** Worktree directory the session is operating in. */
  worktreePath: string;
  /**
   * Configured `previewBaseUrl` from `pr_env_config` (e.g.
   * `https://preview.example.com`). When empty/whitespace the handler
   * surfaces `preview_unavailable` with `unavailableReason: 'no-pr-env'`
   * because there's no URL to point the iframe at.
   */
  previewBaseUrl: string;
  /**
   * Run a `git ...` invocation in the worktree. Production wires
   * this to `execFile` / `spawn`; tests inject a fake.
   */
  git: CommandRunner;
  /**
   * Run a `gh ...` invocation in the worktree. Production wires this
   * to `execFile('gh', ...)`; tests inject a fake.
   */
  gh: CommandRunner;
  /**
   * Look up a `pool_slots` row by PR number. Returns null when no
   * row exists (i.e. webhook hasn't fired yet). Production wires
   * this to a SQLite SELECT; tests inject a fake.
   */
  getPoolSlotByPrNumber: (prNumber: number) => PoolSlotRow | null;
  /** How long to wait for the slot to flip to `busy`. Default 120s. */
  readyTimeoutMs?: number;
  /** Polling cadence. Default 1s. */
  readyPollIntervalMs?: number;
  /** Test seam — milliseconds → resolved Promise. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Build the deep-link to the preview wizard (see preview-block.ts). */
  buildWizardUrl?: (projectId: string) => string;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 1_000;

function defaultBuildWizardUrl(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/settings/pr-environments`;
}

// ─── URL helpers ────────────────────────────────────────────────────────

/**
 * Mirror of `pr-env-builder.ts`'s URL composition. Inlined to keep
 * fullstack-preview self-contained; the helper there isn't exported.
 */
export function buildPrEnvPreviewUrl(previewBaseUrl: string, prNumber: number): string {
  const base = previewBaseUrl.replace(/\/+$/, '');
  return `${base}/pr-${prNumber}`;
}

// ─── PR resolution ──────────────────────────────────────────────────────

interface ResolvedPr {
  number: number;
  url: string;
}

/**
 * Parse a `gh pr create --draft` output blob to extract the PR URL +
 * number. `gh` typically prints just the URL on success; we also handle
 * the "PR already exists" error message that contains a URL.
 */
function parsePrFromOutput(text: string): ResolvedPr | null {
  const match = text.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (!match) return null;
  return { url: match[0], number: Number.parseInt(match[1], 10) };
}

/**
 * Discover an existing PR for the given branch via `gh pr view`. Used
 * as the idempotent fallback when `gh pr create --draft` fails because
 * a PR is already open against the branch.
 */
async function discoverPrByBranch(
  gh: CommandRunner,
  branch: string,
  cwd: string,
): Promise<ResolvedPr | null> {
  try {
    const { stdout } = await gh(['pr', 'view', branch, '--json', 'url,number,state'], cwd);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as { url?: string; number?: number };
    if (parsed?.url && typeof parsed.number === 'number') {
      return { url: parsed.url, number: parsed.number };
    }
  } catch {
    // gh exits non-zero when no PR exists — treat as "not found".
  }
  return null;
}

// ─── Handler ────────────────────────────────────────────────────────────

/**
 * Boot the fullstack preview path: draft PR + container-pool poll.
 * Never throws — every error path becomes a structured broadcast.
 */
export async function handleFullstackPreviewBlock(
  sessionId: string,
  task: PreviewTask,
  deps: FullstackPreviewDeps,
): Promise<void> {
  const {
    broadcast,
    project,
    worktreePath,
    previewBaseUrl,
    git,
    gh,
    getPoolSlotByPrNumber,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    readyPollIntervalMs = DEFAULT_READY_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    buildWizardUrl = defaultBuildWizardUrl,
  } = deps;

  const baseEvent = {
    type: 'agenthub_preview' as const,
    sessionId,
    target: 'fullstack' as const,
    route: task.route,
    agentReason: task.reason,
  };

  const emit = (
    extra: Partial<PreviewBroadcastEvent> & { kind: PreviewBroadcastEvent['kind'] },
  ): void => {
    broadcast({
      ...baseEvent,
      previewId: '',
      ...extra,
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
  };

  // ── Gate 0: kill switch (epic 88367984) ─────────────────────────────
  // The PR-env container pool is being removed; fullstack preview rides
  // on it so it must short-circuit here. Emit `preview_failed` with a
  // clear directive so the chat UI tells the user to use the
  // frontend-only worktree preview instead.
  if (isPrEnvKillSwitchOn()) {
    emit({
      kind: 'preview_failed',
      error: 'fullstack preview removed; use frontend-only worktree preview',
      logTail: [],
    });
    return;
  }

  // ── Gate 1: project's PR-env config must be enabled ────────────────
  if (!project.prEnv || project.prEnv.enabled !== true) {
    emit({
      kind: 'preview_unavailable',
      unavailableReason: 'no-pr-env',
      wizardUrl: buildWizardUrl(project.id),
    });
    return;
  }

  // ── Gate 2: global PR-env config must have a previewBaseUrl ────────
  // Without it we have no URL to point the user at even if the
  // container does come up.
  if (!previewBaseUrl || !previewBaseUrl.trim()) {
    emit({
      kind: 'preview_unavailable',
      unavailableReason: 'no-pr-env',
      wizardUrl: buildWizardUrl(project.id),
    });
    return;
  }

  // ── Step 1: at least one commit on the current branch ──────────────
  let commitCount = 0;
  try {
    const { stdout } = await git(['rev-list', '--count', 'HEAD'], worktreePath);
    commitCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(commitCount)) commitCount = 0;
  } catch (err) {
    emit({
      kind: 'preview_failed',
      error:
        'Could not count commits on the current branch — is this a git worktree? ' +
        (err instanceof Error ? err.message : String(err)),
      logTail: [],
    });
    return;
  }
  if (commitCount < 1) {
    emit({
      kind: 'preview_failed',
      error: 'Commit before requesting fullstack preview',
      logTail: [],
    });
    return;
  }

  // ── Step 2: resolve current branch name ────────────────────────────
  let branch = '';
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    branch = stdout.trim();
  } catch (err) {
    emit({
      kind: 'preview_failed',
      error:
        'Could not resolve worktree branch name. ' +
        (err instanceof Error ? err.message : String(err)),
      logTail: [],
    });
    return;
  }
  if (!branch || branch === 'HEAD') {
    emit({
      kind: 'preview_failed',
      error: 'Worktree is in a detached HEAD state; cannot push branch.',
      logTail: [],
    });
    return;
  }

  // ── Step 3: push branch (idempotent) ───────────────────────────────
  try {
    await git(['push', '-u', 'origin', branch], worktreePath);
  } catch (err) {
    emit({
      kind: 'preview_failed',
      error:
        'git push failed — could not publish the branch for PR creation. ' +
        (err instanceof Error ? err.message : String(err)),
      logTail: [],
    });
    return;
  }

  // ── Step 4: open the draft PR (idempotent via discover-by-branch) ──
  let pr: ResolvedPr | null = null;
  try {
    const { stdout } = await gh(
      ['pr', 'create', '--draft', '--head', branch, '--fill'],
      worktreePath,
    );
    pr = parsePrFromOutput(stdout);
  } catch (err) {
    // The "already exists" path: gh prints the existing URL in the
    // error message. Try to recover that first; only fall back to
    // `gh pr view --json` if the URL isn't in the error.
    const message = err instanceof Error ? err.message : String(err);
    pr = parsePrFromOutput(message);
    if (!pr) {
      pr = await discoverPrByBranch(gh, branch, worktreePath);
    }
    if (!pr) {
      emit({
        kind: 'preview_failed',
        error:
          'gh pr create --draft failed and no existing PR was found for this branch. ' + message,
        logTail: [],
      });
      return;
    }
  }

  if (!pr) {
    emit({
      kind: 'preview_failed',
      error: 'gh pr create returned no parseable PR URL',
      logTail: [],
    });
    return;
  }

  // ── Step 5: poll pool_slots for the per-PR container ───────────────
  const deadline = Date.now() + readyTimeoutMs;
  let slot: PoolSlotRow | null = null;
  while (Date.now() < deadline) {
    slot = getPoolSlotByPrNumber(pr.number);
    if (slot && slot.status === 'busy') break;
    if (slot && slot.status === 'failed') {
      emit({
        kind: 'preview_failed',
        prUrl: pr.url,
        prNumber: pr.number,
        error: 'PR-env container reached failed state — check pool slot logs',
        logTail: [],
      });
      return;
    }
    await sleep(readyPollIntervalMs);
  }

  if (!slot || slot.status !== 'busy') {
    emit({
      kind: 'preview_failed',
      prUrl: pr.url,
      prNumber: pr.number,
      error: `PR-env container did not reach ready within ${readyTimeoutMs}ms (slot status: ${slot?.status ?? 'no row yet'})`,
      logTail: [],
    });
    return;
  }

  // ── Step 6: emit the ready preview ─────────────────────────────────
  const previewUrl = buildPrEnvPreviewUrl(previewBaseUrl, pr.number);
  const fullUrl =
    task.route && task.route !== '/'
      ? previewUrl + (task.route.startsWith('/') ? task.route : `/${task.route}`)
      : previewUrl;
  emit({
    kind: 'preview',
    previewUrl,
    fullUrl,
    prUrl: pr.url,
    prNumber: pr.number,
  });
}

// ─── Re-exports for chat.ts dispatch convenience ────────────────────────

export type { PreviewMalformedReason };
