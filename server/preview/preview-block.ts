/**
 * `<agenthub:preview>` block parser + handler.
 *
 * Wires the per-session preview runtime (see `preview-runtime.ts`) into
 * the chat protocol. An agent emits a fenced block at the end of its
 * turn to request a live preview of the current worktree:
 *
 *     <agenthub:preview>
 *     {"target":"client","route":"/projects/agent-hub/board",
 *      "reason":"Show new card-blocker badge"}
 *     </agenthub:preview>
 *
 * Parsing follows the same shape as `<agenthub:close-card>` and
 * `<handoff>` — XML-style tag whose body is JSON. We reuse
 * {@link extractJsonFromTagBody} so the same fence/blockquote/control-char
 * permissiveness applies. Each typed field is validated explicitly so
 * malformed payloads produce a structured `reason` for the chat UI to
 * render rather than a silent no-op.
 *
 * The handler is the *only* code path that boots a preview from chat;
 * `chat.ts` calls {@link handlePreviewBlock} after the stream closes.
 * Outcomes are surfaced as broadcast events so the client renders
 * either a live iframe attachment, a "preview not configured" teach
 * moment, or a boot-failure card with a log tail. The chat flow itself
 * never blocks on the preview — boot is async and fire-and-forget from
 * the post-stream hook's perspective.
 */

import type { BroadcastFn, Project } from '../types.js';
import { extractJsonFromTagBody } from '../action-block-parsing.js';
import type { PreviewRuntime } from './preview-runtime.js';

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Which side of the application the agent wants previewed.
 *
 * For now both targets resolve to the same per-session runtime — the
 * field is captured for future divergence (e.g. proxying API calls
 * differently for `target=server`) and to give the client a hint when
 * rendering the route chip.
 */
export type PreviewTarget = 'client' | 'server';

export interface PreviewTask {
  target: PreviewTarget;
  /** Path to navigate to inside the preview (e.g. `/projects/agent-hub/board`). */
  route: string;
  /** Optional human-facing reason rendered alongside the iframe. */
  reason?: string;
}

export type PreviewMalformedReason =
  | 'invalid-json'
  | 'not-object'
  | 'missing-target'
  | 'invalid-target'
  | 'missing-route'
  | 'invalid-route';

export interface PreviewDetectionResult {
  present: boolean;
  task: PreviewTask | null;
  reason: PreviewMalformedReason | null;
  rawBody: string | null;
}

/**
 * The shape of broadcast events the handler emits. Mirrors the existing
 * `agenthub_attachment` channel naming so the client's WS dispatch only
 * needs one new branch.
 */
export type PreviewEventKind = 'preview' | 'preview_unavailable' | 'preview_failed';

export interface PreviewBroadcastEvent {
  type: 'agenthub_preview';
  kind: PreviewEventKind;
  sessionId: string;
  /** Always present; may be empty string when an event predates a runtime call. */
  previewId: string;
  /** Original user-facing reason from the agent's block (if any). */
  agentReason?: string;
  /** Convenience copy of the requested route — clients echo this in a chip. */
  route?: string;
  target?: PreviewTarget;

  // — `kind === 'preview'` payload ——————————————
  previewUrl?: string;
  fullUrl?: string;
  port?: number;
  screenshotPath?: string | null;

  // — `kind === 'preview_unavailable'` payload ——
  /** Sub-reason: project has no `prEnv` block, or its `preview.enabled` is false. */
  unavailableReason?: 'no-pr-env' | 'preview-disabled';
  /** Deep link to the project settings wizard so the user can enable preview. */
  wizardUrl?: string;

  // — `kind === 'preview_failed'` payload ——————
  /** Short error message — surfaced in the failure card header. */
  error?: string;
  /** First N stdout/stderr lines from the spawn — surfaced in <pre> for debugging. */
  logTail?: string[];
}

/** Dependencies required to handle a parsed `<agenthub:preview>` block. */
export interface PreviewHandlerDeps {
  /**
   * Runtime constructed at server startup. May be `null` when the runtime
   * isn't wired (e.g. in tests of the chat layer that don't exercise the
   * preview surface) — the handler treats that as `preview_unavailable`.
   */
  runtime: PreviewRuntime | null;
  broadcast: BroadcastFn;
  project: Project;
  /** Worktree path for the session. Required by `runtime.startPreview`. */
  worktreePath: string;
  /**
   * Optional Playwright-driven screenshotter. Returns the path the
   * screenshot was written to (under `uploadsDir`) or null when capture
   * failed. Failure is non-fatal — the iframe still renders.
   */
  takeScreenshot?: (url: string) => Promise<string | null>;
  /**
   * Build the deep-link to the project's PR-env / preview wizard. Tests
   * inject a fake builder so we don't depend on the client's router.
   */
  buildWizardUrl?: (projectId: string) => string;
  /**
   * How long to wait for the preview to flip to `ready` before giving
   * up and surfacing `preview_failed`. Defaults to 30s — matches the
   * runtime's own health-check budget.
   */
  readyTimeoutMs?: number;
  /** Polling cadence for the ready check. Defaults to 500ms. */
  readyPollIntervalMs?: number;
  /** Test seam — milliseconds → resolved Promise. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

// ─── Parser ─────────────────────────────────────────────────────────────

const BLOCK_TAG_RE = /<agenthub:preview>\s*([\s\S]*?)\s*<\/agenthub:preview>/;

/**
 * Detect and parse an `<agenthub:preview>` block from `text`. Returns
 * `{ present: false }` when no block is found, or a structured result
 * with a `reason` field when the block is present but malformed.
 *
 * Accepts:
 *   - `target`: `"client"` or `"server"` (case-insensitive, trimmed). Anything
 *     else → `invalid-target`. Missing/empty → `missing-target`.
 *   - `route`: must be a non-empty string starting with `/`. Missing →
 *     `missing-route`; bad shape → `invalid-route`.
 *   - `reason`: optional string. Other types (number, object, …) are dropped
 *     silently so the rest of the payload still validates.
 *
 * Only the first block in `text` is considered (consistent with
 * `detectCloseCardBlock` and `detectHandoffBlock`).
 */
export function detectPreviewBlock(text: string): PreviewDetectionResult {
  if (typeof text !== 'string') {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const match = text.match(BLOCK_TAG_RE);
  if (!match) return { present: false, task: null, reason: null, rawBody: null };

  const rawBody = match[1] ?? '';
  const normalized = extractJsonFromTagBody(rawBody);
  let parsed: unknown;
  try {
    parsed = normalized === null ? JSON.parse(rawBody) : JSON.parse(normalized);
  } catch {
    return { present: true, task: null, reason: 'invalid-json', rawBody };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, task: null, reason: 'not-object', rawBody };
  }
  const obj = parsed as Record<string, unknown>;

  // target — required, normalized to lowercase
  const rawTarget = typeof obj.target === 'string' ? obj.target.trim().toLowerCase() : '';
  if (!rawTarget) return { present: true, task: null, reason: 'missing-target', rawBody };
  let target: PreviewTarget;
  if (rawTarget === 'client') target = 'client';
  else if (rawTarget === 'server') target = 'server';
  else return { present: true, task: null, reason: 'invalid-target', rawBody };

  // route — required, must start with `/`
  if (typeof obj.route !== 'string') {
    return { present: true, task: null, reason: 'missing-route', rawBody };
  }
  const route = obj.route.trim();
  if (!route) return { present: true, task: null, reason: 'missing-route', rawBody };
  if (!route.startsWith('/')) {
    return { present: true, task: null, reason: 'invalid-route', rawBody };
  }

  // reason — optional, only kept when it's a non-empty string
  const reasonRaw = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  const task: PreviewTask = reasonRaw ? { target, route, reason: reasonRaw } : { target, route };
  return { present: true, task, reason: null, rawBody };
}

export function parsePreviewBlock(text: string): PreviewTask | null {
  return detectPreviewBlock(text).task;
}

export function describePreviewReason(reason: PreviewMalformedReason): string {
  switch (reason) {
    case 'invalid-json':
      return 'Preview block contains invalid JSON';
    case 'not-object':
      return 'Preview block payload is not a JSON object';
    case 'missing-target':
      return 'Preview block is missing the "target" field';
    case 'invalid-target':
      return 'Preview block has an invalid "target" — expected "client" or "server"';
    case 'missing-route':
      return 'Preview block is missing the "route" field';
    case 'invalid-route':
      return 'Preview block "route" must start with "/"';
    default:
      return 'Preview block could not be parsed';
  }
}

// ─── Handler ────────────────────────────────────────────────────────────

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 500;

/**
 * Default wizard URL builder. Points at the per-project PR-env settings page
 * (which owns the preview sub-config). Production callers may override this
 * to point at a dedicated preview wizard once card 4 lands.
 */
function defaultBuildWizardUrl(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/settings/pr-environments`;
}

/**
 * Boot a preview, await `ready`, snap a screenshot, and broadcast the
 * resulting attachment. This is the workhorse called from `chat.ts`'s
 * post-stream hook. Never throws — all error paths funnel into a
 * `preview_failed` broadcast so the chat UI always gets a final state.
 *
 * Outcome matrix:
 *   - Project has no `prEnv.preview.enabled === true` → `preview_unavailable`
 *     with a wizard deep-link. Nothing is spawned.
 *   - `runtime` is null (wiring incomplete) → `preview_unavailable` with
 *     `unavailableReason: 'no-pr-env'`. Nothing is spawned.
 *   - `startPreview` throws → `preview_failed` with the error message.
 *   - Status flips to `failed` while we wait → `preview_failed` with the
 *     captured log tail.
 *   - Ready timeout elapses without `ready` → `preview_failed`.
 *   - Status flips to `ready` → `preview` with iframe URL + screenshot path.
 */
export async function handlePreviewBlock(
  sessionId: string,
  task: PreviewTask,
  deps: PreviewHandlerDeps,
): Promise<void> {
  const {
    runtime,
    broadcast,
    project,
    worktreePath,
    takeScreenshot,
    buildWizardUrl = defaultBuildWizardUrl,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    readyPollIntervalMs = DEFAULT_READY_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = deps;

  // ── Gate 1: project has a preview config? ───────────────────────────
  const previewCfg = project.prEnv?.preview;
  if (!project.prEnv || !previewCfg || previewCfg.enabled !== true) {
    broadcast({
      type: 'agenthub_preview',
      kind: 'preview_unavailable',
      sessionId,
      previewId: '',
      target: task.target,
      route: task.route,
      agentReason: task.reason,
      unavailableReason: !project.prEnv ? 'no-pr-env' : 'preview-disabled',
      wizardUrl: buildWizardUrl(project.id),
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
    return;
  }

  // ── Gate 2: runtime wired? ──────────────────────────────────────────
  if (!runtime) {
    broadcast({
      type: 'agenthub_preview',
      kind: 'preview_unavailable',
      sessionId,
      previewId: '',
      target: task.target,
      route: task.route,
      agentReason: task.reason,
      unavailableReason: 'no-pr-env',
      wizardUrl: buildWizardUrl(project.id),
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
    return;
  }

  // ── Spawn ───────────────────────────────────────────────────────────
  let previewId = '';
  let port: number;
  let url: string;
  try {
    const result = await runtime.startPreview(sessionId, project, worktreePath);
    previewId = result.previewId;
    port = result.port;
    url = result.url;
  } catch (err) {
    broadcast({
      type: 'agenthub_preview',
      kind: 'preview_failed',
      sessionId,
      previewId: '',
      target: task.target,
      route: task.route,
      agentReason: task.reason,
      error: err instanceof Error ? err.message : String(err),
      logTail: [],
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
    return;
  }

  // ── Wait for ready ──────────────────────────────────────────────────
  const deadline = Date.now() + readyTimeoutMs;
  let row = runtime.getById(previewId);
  while (row && row.status === 'starting' && Date.now() < deadline) {
    await sleep(readyPollIntervalMs);
    row = runtime.getById(previewId);
  }

  if (!row || row.status === 'failed') {
    broadcast({
      type: 'agenthub_preview',
      kind: 'preview_failed',
      sessionId,
      previewId,
      target: task.target,
      route: task.route,
      agentReason: task.reason,
      error: !row ? 'preview row vanished before ready' : 'preview boot failed',
      logTail: runtime.getLogTail(previewId),
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
    return;
  }

  if (row.status === 'starting') {
    // Timed out waiting — leave the row in place so the reaper / next
    // touch can still flip it to ready, but tell the user we gave up.
    broadcast({
      type: 'agenthub_preview',
      kind: 'preview_failed',
      sessionId,
      previewId,
      target: task.target,
      route: task.route,
      agentReason: task.reason,
      error: `preview did not reach ready within ${readyTimeoutMs}ms`,
      logTail: runtime.getLogTail(previewId),
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
    return;
  }

  // ── Ready: take screenshot + broadcast ──────────────────────────────
  const fullUrl = url + (task.route.startsWith('/') ? task.route : `/${task.route}`);
  let screenshotPath: string | null = null;
  if (takeScreenshot) {
    try {
      screenshotPath = await takeScreenshot(fullUrl);
    } catch {
      // Screenshot failure is non-fatal — the iframe still renders.
      screenshotPath = null;
    }
  }

  broadcast({
    type: 'agenthub_preview',
    kind: 'preview',
    sessionId,
    previewId,
    target: task.target,
    route: task.route,
    agentReason: task.reason,
    previewUrl: url,
    fullUrl,
    port,
    screenshotPath,
  } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
}
