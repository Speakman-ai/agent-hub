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
import type { PreviewComposeRuntime } from './preview-compose-runtime.js';

/**
 * Minimal runtime contract the `<agenthub:preview>` handler depends on.
 * Both {@link PreviewRuntime} (legacy spawn) and {@link PreviewComposeRuntime}
 * implement this shape, so the dispatch site can hand either one to
 * {@link handlePreviewBlock} without per-runtime branching here.
 *
 * The handler only reads `status` from `getById` and treats `getLogTail`
 * as best-effort (compose returns `[]` until a future enhancement pipes
 * `docker compose logs` through an in-memory ring buffer).
 */
export interface PreviewRuntimeLike {
  startPreview: (
    sessionId: string,
    project: Project,
    worktreePath: string,
  ) => Promise<{ previewId: string; url: string; port: number }>;
  getById: (previewId: string) => { status: 'starting' | 'ready' | 'failed' } | null;
  getLogTail: (previewId: string) => string[];
}
// Compile-time assertion: both production runtimes satisfy
// PreviewRuntimeLike. If a future refactor drops a method, this line
// breaks the build instead of the test suite.
type _AssertCompatible = PreviewRuntime | PreviewComposeRuntime extends PreviewRuntimeLike
  ? true
  : never;

const _previewRuntimeLikeAssertion: _AssertCompatible = true;

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Which side of the application the agent wants previewed.
 *
 * Both targets resolve to the per-session preview runtime
 * (`startPreview` against the worktree). The previous `fullstack`
 * escape hatch (draft PR + PR-env container pool) has been removed
 * along with the rest of the PR-environments subsystem — agents now
 * preview frontend-only changes via the worktree runtime, and any
 * full-stack verification rides the normal PR review flow.
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
export type PreviewEventKind =
  | 'preview'
  | 'preview_unavailable'
  | 'preview_failed'
  /**
   * Emitted (a) once immediately after `runtime.startPreview` returns
   * with an empty `logTail`, then (b) periodically while the runtime is
   * still polling its health check, each time carrying the latest
   * captured stdout/stderr tail. Lets the UI render boot output live
   * instead of waiting for `preview` / `preview_failed`.
   */
  | 'preview_starting'
  | 'preview_stopped'
  /**
   * Per-line log forwarding for a still-running preview process. Emitted
   * by `PreviewRuntime` via its `notifyLog` seam when production wires it
   * to the broadcast bus. Each event carries exactly one line so the
   * client can append without de-duping. Producers must coalesce or
   * drop on backpressure — the runtime fires once per stdout/stderr
   * line and has no built-in throttling.
   */
  | 'preview_log';

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
  /**
   * Navigation intent for the client to resolve via `setCurrentView`.
   * The Agent Hub web app doesn't use URL routing (see
   * `client/src/App.jsx`), so a string URL like `/projects/.../settings/...`
   * never resolves to a real view. `wizard` is the preferred contract:
   * `view` is a `currentView` token (e.g. `preview:<projectId>`) the client
   * passes directly to `setCurrentView`, and `projectId` lets the client
   * switch active project before navigating.
   */
  wizard?: { view: string; projectId: string };
  /**
   * Legacy string URL form. Retained for one release so in-flight events
   * from older servers still render the teach-moment card (with a
   * non-resolving link). New clients should prefer `wizard`.
   * @deprecated Use `wizard` instead.
   */
  wizardUrl?: string;

  // — `kind === 'preview_failed' | 'preview_starting'` payload ——
  /** Short error message — surfaced in the failure card header. */
  error?: string;
  /**
   * First N stdout/stderr lines from the spawn — surfaced in `<pre>`
   * for debugging. Populated on both `preview_starting` (so the user
   * can watch boot output in real time) and `preview_failed` (the
   * snapshot at the moment the runtime gave up).
   */
  logTail?: string[];

  // — `kind === 'preview_log'` payload ————————————
  /** Single stdout/stderr line from a running preview process. */
  line?: string;
  /** Which process inside the group emitted the line. */
  processName?: string;
  /** Which stream the line came from. */
  stream?: 'stdout' | 'stderr';
}

/** Dependencies required to handle a parsed `<agenthub:preview>` block. */
export interface PreviewHandlerDeps {
  /**
   * Runtime constructed at server startup. May be `null` when the runtime
   * isn't wired (e.g. in tests of the chat layer that don't exercise the
   * preview surface) — the handler treats that as `preview_unavailable`.
   *
   * Accepts either the legacy {@link PreviewRuntime} (spawn-based) or the
   * compose-mode {@link PreviewComposeRuntime}. The chat dispatch site
   * decides which to pass based on `project.prEnv.preview.compose.entryService`.
   */
  runtime: PreviewRuntimeLike | null;
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
   * Build the deep-link string URL for the project's preview wizard.
   * Emitted as the legacy `wizardUrl` field on `preview_unavailable`
   * events for one release of backwards compat — new clients should
   * resolve `wizard` (the navigation intent) instead.
   * @deprecated Prefer overriding `buildWizard` for the structured
   *   intent payload. Both are emitted side-by-side during the
   *   deprecation window so older client builds still render the
   *   teach-moment card.
   */
  buildWizardUrl?: (projectId: string) => string;
  /**
   * Build the structured navigation intent for the client to resolve
   * via `setCurrentView`. Defaults to `{ view: 'preview:<projectId>',
   * projectId }`. Tests can inject a fake to assert on the emitted
   * payload without depending on the client's view-router conventions.
   */
  buildWizard?: (projectId: string) => { view: string; projectId: string };
  /**
   * How long to wait for the preview to flip to `ready` before giving
   * up and surfacing `preview_failed`. When omitted, derived from
   * {@link resolvePreviewHandlerReadyTimeoutMs} (compose → 10 min default).
   */
  readyTimeoutMs?: number;
  /** Polling cadence for the ready check. Defaults to 500ms. */
  readyPollIntervalMs?: number;
  /**
   * Minimum gap between successive `preview_starting` re-broadcasts
   * during the ready-poll loop. Defaults to 2000ms so the pane gets a
   * fresh `logTail` snapshot every couple of seconds without flooding
   * the WS bus when the poll cadence is much tighter. Set to 0 (in
   * tests) to fire on every poll.
   */
  startingRebroadcastIntervalMs?: number;
  /** Test seam — milliseconds → resolved Promise. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — clock used to gate the rebroadcast interval. Defaults to `Date.now`. */
  now?: () => number;
}

// ─── Parser ─────────────────────────────────────────────────────────────

const BLOCK_TAG_RE = /<agenthub:preview>\s*([\s\S]*?)\s*<\/agenthub:preview>/;

/**
 * Detect and parse an `<agenthub:preview>` block from `text`. Returns
 * `{ present: false }` when no block is found, or a structured result
 * with a `reason` field when the block is present but malformed.
 *
 * Accepts:
 *   - `target`: `"client"` or `"server"` (case-insensitive, trimmed).
 *     Anything else → `invalid-target`. Missing/empty → `missing-target`.
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

const DEFAULT_READY_TIMEOUT_MS = 120_000;

/** Compose cold-boot budget (prod dump + npm ci + ng serve). Keep in sync with compose runtime default. */
const COMPOSE_PREVIEW_READY_TIMEOUT_MS = 600_000;

/**
 * How long {@link handlePreviewBlock} waits for `runtime.getById` → `ready`.
 * Compose previews use the longer budget; legacy spawn keeps 120s.
 */
export function resolvePreviewHandlerReadyTimeoutMs(
  project: {
    prEnv?: { preview?: { compose?: { entryService?: string; readyTimeoutMs?: number } } };
  },
  composeReadyTimeoutMs: number = COMPOSE_PREVIEW_READY_TIMEOUT_MS,
): number {
  const perProject = project.prEnv?.preview?.compose?.readyTimeoutMs;
  if (typeof perProject === 'number' && Number.isFinite(perProject) && perProject > 0) {
    return perProject;
  }
  if (project.prEnv?.preview?.compose?.entryService) {
    return composeReadyTimeoutMs;
  }
  return DEFAULT_READY_TIMEOUT_MS;
}
const DEFAULT_READY_POLL_INTERVAL_MS = 500;
const DEFAULT_STARTING_REBROADCAST_INTERVAL_MS = 2_000;

/**
 * Default wizard URL builder. Emitted as the legacy `wizardUrl` field on
 * `preview_unavailable` events for backwards compat (one release).
 *
 * The path itself is fictional — the Agent Hub web app doesn't use URL
 * routing, so this string never resolves to a real view. It's kept so
 * older client builds that read `wizardUrl` instead of `wizard` still
 * render the teach-moment card (the CTA link will simply not navigate).
 */
function defaultBuildWizardUrl(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/settings/preview?focus=preview`;
}

/**
 * Default wizard intent builder. Points the client at the per-project
 * Preview view (`preview:<projectId>` — see the sidebar entry in
 * `client/src/components/Sidebar.jsx` and the route in
 * `client/src/App.jsx`), which is what the chat-side CTA lands on.
 */
function defaultBuildWizard(projectId: string): { view: string; projectId: string } {
  return { view: `preview:${projectId}`, projectId };
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
    buildWizard = defaultBuildWizard,
    readyPollIntervalMs = DEFAULT_READY_POLL_INTERVAL_MS,
    startingRebroadcastIntervalMs = DEFAULT_STARTING_REBROADCAST_INTERVAL_MS,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = deps;
  const readyTimeoutMs =
    deps.readyTimeoutMs ??
    resolvePreviewHandlerReadyTimeoutMs(project, COMPOSE_PREVIEW_READY_TIMEOUT_MS);

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
      wizard: buildWizard(project.id),
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
      wizard: buildWizard(project.id),
      wizardUrl: buildWizardUrl(project.id),
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
    return;
  }

  // ── Spawn ───────────────────────────────────────────────────────────
  let previewId = '';
  let port: number;
  let url: string;
  // Immediate feedback — compose boot (clone wait, build) can take minutes
  // before `startPreview` returns and the runtime emits its own starting event.
  broadcast({
    type: 'agenthub_preview',
    kind: 'preview_starting',
    sessionId,
    previewId: '',
    target: task.target,
    route: task.route,
    agentReason: task.reason,
    logTail: ['[preview] Starting…'],
  } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
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

  // ── Broadcast initial `starting` so the pane swaps from the empty
  //    placeholder to the boot-log surface immediately. The runtime is
  //    already polling its health-check budget; this event tells the
  //    UI "we're alive, here's an (empty) log to start filling in".
  const emitStarting = (): void => {
    broadcast({
      type: 'agenthub_preview',
      kind: 'preview_starting',
      sessionId,
      previewId,
      target: task.target,
      route: task.route,
      agentReason: task.reason,
      previewUrl: url,
      port,
      logTail: runtime.getLogTail(previewId),
    } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
  };
  emitStarting();

  // ── Wait for ready ──────────────────────────────────────────────────
  // While we wait, periodically rebroadcast `preview_starting` with the
  // current logTail so the user sees boot output as it arrives — not
  // just on terminal success/failure. Throttled by
  // `startingRebroadcastIntervalMs` so a 500ms poll cadence doesn't
  // saturate the socket.
  const deadline = now() + readyTimeoutMs;
  let lastRebroadcastAt = now();
  let row = runtime.getById(previewId);
  while (row && row.status === 'starting' && now() < deadline) {
    await sleep(readyPollIntervalMs);
    if (now() - lastRebroadcastAt >= startingRebroadcastIntervalMs) {
      lastRebroadcastAt = now();
      emitStarting();
    }
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
    logTail: runtime.getLogTail(previewId),
  } satisfies PreviewBroadcastEvent as unknown as Record<string, unknown>);
}
