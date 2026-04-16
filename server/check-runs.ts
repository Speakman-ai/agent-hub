/**
 * check-runs.ts — GitHub Check Runs API wrapper.
 *
 * Publishes the Reviewer agent's progress as a first-class GitHub Check Run
 * (the live, timed panel that renders in the PR Checks tab), instead of only
 * as a `pulls/{pr}/reviews` comment. Each Reviewer phase (context → analysis →
 * post) patches the same check run with an updated Markdown checklist so the
 * panel animates like Cursor Bugbot.
 *
 * Requires the GitHub App to hold `checks: write` (see `buildAppManifest`).
 */
import { githubApiRequest, resolveInstallationId } from './github-app.js';
import type { AppConfig, GitHubAppConfig, PrStateConclusion } from './types.js';

export const CHECK_RUN_NAME = 'Agent Hub Reviewer';

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';

export interface CheckRunPhase {
  /** Machine id, e.g. `context`, `analyze`, `post`. */
  key: string;
  /** Human label, e.g. "Gather context". */
  label: string;
  /** `pending` | `in_progress` | `done`. */
  state: 'pending' | 'in_progress' | 'done';
  /**
   * Cumulative elapsed ms from the reviewer dispatch start to the moment this
   * phase transitioned to `done`. NOT the per-phase duration — see the
   * rendered "@30.0s" prefix in `renderProgressSummary` for unambiguous
   * read-out. We intentionally use a single baseline (one `started_at` in
   * `pr_state`) instead of per-phase start columns because the panel only
   * needs to show "this phase finished N seconds in," not "this phase took N
   * seconds." Per-phase durations would require additional schema columns
   * for marginal UX improvement.
   */
  cumulativeMs?: number;
}

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckRunAnnotation[];
}

export interface CreateCheckRunOpts {
  owner: string;
  repo: string;
  headSha: string;
  status?: CheckRunStatus;
  output?: CheckRunOutput;
  detailsUrl?: string;
  externalId?: string;
}

export interface UpdateCheckRunOpts {
  status?: CheckRunStatus;
  conclusion?: PrStateConclusion;
  output?: CheckRunOutput;
  detailsUrl?: string;
  completedAt?: string; // ISO 8601
}

/** Annotations limit per API call (GitHub hard cap). */
export const MAX_ANNOTATIONS_PER_REQUEST = 50;

/**
 * Render the markdown body for the live progress panel.
 *
 * The contract: call with the CURRENT full phase list plus any summary lines,
 * and send the result as `output.summary` on every PATCH. GitHub REPLACES
 * `output.summary` per PATCH (it does not append), which is exactly how
 * Cursor's animated progress works.
 */
export function renderProgressSummary(
  phases: CheckRunPhase[],
  opts: {
    headline?: string;
    footer?: string;
  } = {},
): string {
  const lines: string[] = [];
  if (opts.headline) lines.push(opts.headline, '');

  for (const p of phases) {
    const marker = p.state === 'done' ? '✅' : p.state === 'in_progress' ? '🔄' : '⏳';
    // `@N.Ns` makes it clear this is a checkpoint timestamp from the reviewer
    // start — not the phase's own duration. Avoids the ambiguity flagged in
    // PR #304 review where readers mistook cumulative timing for per-phase.
    const timing =
      p.state === 'done' && typeof p.cumulativeMs === 'number'
        ? ` — @${formatElapsed(p.cumulativeMs)}`
        : p.state === 'in_progress'
          ? ' — running…'
          : '';
    lines.push(`- ${marker} **${p.label}**${timing}`);
  }

  if (opts.footer) {
    lines.push('', opts.footer);
  }
  return lines.join('\n');
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remSec = Math.round(s - m * 60);
  return `${m}m${remSec}s`;
}

export interface CheckRunApiResponse {
  id: number;
  html_url?: string;
  status?: string;
  conclusion?: string | null;
}

/**
 * Returns `{ appId, privateKey, installationId }` or `null` if the App is not
 * configured for this repo owner. Caller uses this to short-circuit without
 * throwing — Check Runs are a best-effort overlay on top of the existing
 * `pulls/{pr}/reviews` path.
 */
export function resolveCheckRunAuth(
  config: AppConfig,
  owner: string,
): { appId: string | number; privateKey: string; installationId: string | number } | null {
  const app = config.githubApp as GitHubAppConfig | undefined | null;
  if (!app?.appId || !app?.privateKey) return null;
  const installationId = resolveInstallationId(app, owner);
  if (!installationId) return null;
  return { appId: app.appId, privateKey: app.privateKey, installationId };
}

/** Slice annotations into ≤MAX per batch (additive across PATCH calls). */
export function chunkAnnotations(
  annotations: CheckRunAnnotation[],
  max: number = MAX_ANNOTATIONS_PER_REQUEST,
): CheckRunAnnotation[][] {
  if (annotations.length === 0) return [];
  const chunks: CheckRunAnnotation[][] = [];
  for (let i = 0; i < annotations.length; i += max) {
    chunks.push(annotations.slice(i, i + max));
  }
  return chunks;
}

export async function createCheckRun(
  config: AppConfig,
  opts: CreateCheckRunOpts,
): Promise<CheckRunApiResponse | null> {
  const auth = resolveCheckRunAuth(config, opts.owner);
  if (!auth) return null;

  const body: Record<string, unknown> = {
    name: CHECK_RUN_NAME,
    head_sha: opts.headSha,
    status: opts.status || 'queued',
  };
  if (opts.output) body.output = opts.output;
  if (opts.detailsUrl) body.details_url = opts.detailsUrl;
  if (opts.externalId) body.external_id = opts.externalId;

  const data = (await githubApiRequest(`/repos/${opts.owner}/${opts.repo}/check-runs`, {
    method: 'POST',
    body,
    ...auth,
  })) as unknown as CheckRunApiResponse;
  return data;
}

export async function updateCheckRun(
  config: AppConfig,
  owner: string,
  repo: string,
  checkRunId: number,
  opts: UpdateCheckRunOpts,
): Promise<CheckRunApiResponse | null> {
  const auth = resolveCheckRunAuth(config, owner);
  if (!auth) return null;

  const body: Record<string, unknown> = {};
  if (opts.status) body.status = opts.status;
  if (opts.conclusion) body.conclusion = opts.conclusion;
  if (opts.output) body.output = opts.output;
  if (opts.detailsUrl) body.details_url = opts.detailsUrl;
  if (opts.completedAt) body.completed_at = opts.completedAt;

  const data = (await githubApiRequest(`/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
    method: 'PATCH',
    body,
    ...auth,
  })) as unknown as CheckRunApiResponse;
  return data;
}

/**
 * Completion convenience: PATCH `status=completed` with the final conclusion,
 * timestamp, and summary. Non-blocking issues → `neutral`; clean → `success`;
 * must-fix → `action_required`.
 */
export async function completeCheckRun(
  config: AppConfig,
  owner: string,
  repo: string,
  checkRunId: number,
  conclusion: PrStateConclusion,
  output?: CheckRunOutput,
): Promise<CheckRunApiResponse | null> {
  return updateCheckRun(config, owner, repo, checkRunId, {
    status: 'completed',
    conclusion,
    output,
    completedAt: new Date().toISOString(),
  });
}

/**
 * Map the Reviewer's GitHub review event to a Check Run conclusion.
 * - APPROVE → success (clean review)
 * - COMMENT → neutral (found issues, non-blocking)
 * - REQUEST_CHANGES → action_required (must address before merge)
 */
export function reviewEventToConclusion(
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
): PrStateConclusion {
  switch (event) {
    case 'APPROVE':
      return 'success';
    case 'REQUEST_CHANGES':
      return 'action_required';
    case 'COMMENT':
    default:
      return 'neutral';
  }
}

/** The default phase list used by the Reviewer dispatch pipeline. */
export const DEFAULT_REVIEWER_PHASES: CheckRunPhase[] = [
  { key: 'queue', label: 'Reviewer scheduled (debounce)', state: 'pending' },
  { key: 'context', label: 'Gather PR context', state: 'pending' },
  { key: 'analyze', label: 'Analyze diff and files', state: 'pending' },
  { key: 'post', label: 'Post formal review', state: 'pending' },
];

/**
 * Advance the phase list so a given `key` is marked `in_progress` and all
 * previous phases become `done`. Returns a NEW array (non-mutating) and fills
 * `cumulativeMs` for phases transitioning from pending/in_progress → done.
 *
 * Note: `cumulativeMs` is the checkpoint timestamp (now - startedAt), NOT the
 * per-phase duration. The render path prefixes it with "@" to make that
 * explicit (e.g. "✅ Gather context — @12.0s"). See `CheckRunPhase.cumulativeMs`.
 */
export function advancePhase(
  phases: CheckRunPhase[],
  key: string,
  now: number,
  startedAt: number,
): CheckRunPhase[] {
  let reached = false;
  return phases.map((p) => {
    if (reached) return { ...p, state: 'pending' };
    if (p.key === key) {
      reached = true;
      return { ...p, state: 'in_progress' };
    }
    return {
      ...p,
      state: 'done',
      cumulativeMs: p.cumulativeMs ?? Math.max(0, now - startedAt),
    };
  });
}

/**
 * Finalize the phase list: every phase marked `done` with `cumulativeMs`
 * filled. Like `advancePhase`, the value is the checkpoint timestamp from the
 * reviewer start, not per-phase duration.
 */
export function finalizePhases(
  phases: CheckRunPhase[],
  now: number,
  startedAt: number,
): CheckRunPhase[] {
  return phases.map((p) => ({
    ...p,
    state: 'done',
    cumulativeMs: p.cumulativeMs ?? Math.max(0, now - startedAt),
  }));
}

/**
 * Parse a SQLite timestamp string into ms since epoch, treating it as UTC even
 * when the SQLite default `datetime('now')` format (no `T`, no `Z`) is used.
 *
 * V8's `Date` parser treats `YYYY-MM-DD HH:MM:SS` as LOCAL time — so on a
 * non-UTC host, every elapsed-time computation against a `pr_state.started_at`
 * stored with the legacy format would be off by the host's UTC offset. New
 * rows use `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` which parses correctly
 * everywhere, but this helper keeps the JS side defensive against legacy data
 * and any future writers that forget the `Z`.
 *
 * Returns `null` for nullish/empty/unparseable input so callers can fall back
 * to a sensible default (typically `Date.now()`).
 */
export function parseSqliteTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  // Already ISO with timezone — fast path.
  if (/[Tt].*([Zz]|[+-]\d{2}:?\d{2})$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  // Legacy `YYYY-MM-DD HH:MM:SS[.fff]` — treat as UTC by reformatting.
  const normalized = value.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}
