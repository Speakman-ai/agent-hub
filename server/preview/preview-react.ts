/**
 * preview-react.ts — host-mediated `tool: preview` ReAct actions.
 *
 * Lets an agent OBSERVE (state / logs / screenshot) and DRIVE (navigate by
 * route, click, type, scroll, wait, read_page, extract) the preview —
 * managed dev server — that a human already started for
 * the agent's own session.
 *
 * Invariants:
 * - **Lifecycle stays human-only.** There is intentionally no start/stop op —
 *   preview boot remains `POST /api/sessions/:id/preview/start` from the chat
 *   toolbar. A session with no running preview gets a clear "not running"
 *   observation (hostExit 2), never a boot.
 * - **Origin-pinned egress.** The agent's regular `browser` tool blocks
 *   loopback targets (SSRF policy), so previews on `localhost:<port>` are
 *   unreachable from it. The preview drive browser session relaxes that block
 *   for exactly ONE origin — the session's own preview origin — via
 *   `BrowserNavigationPolicyOpts.allowOrigins`. Navigation input is a `route`
 *   (path), never a URL, so the agent cannot point this tool anywhere else.
 *   The pin is enforced at REQUEST time by a persistent CDP document guard
 *   (off-origin main-frame requests are failed before they egress — covers
 *   click/type-driven navigations, form submits, client-side redirects, and
 *   redirect hops) and re-checked post-op by `guardEscape`, which reverts to
 *   the preview root and withholds any captured content.
 * - **Own session only.** The preview group is resolved from the chat session
 *   id; there is no way to address another session's preview.
 */

import type { BrowserSessionOptions } from '../browser.js';
import { closeBrowserSession, DEFAULT_TIMEOUT_MS } from '../browser.js';
import type { V3 } from '@browserbasehq/stagehand';
import {
  browserClick,
  browserExtract,
  browserNavigate,
  browserReadPage,
  browserScreenshot,
  browserScroll,
  browserType,
  browserWaitFixed,
  getOrCreateBrowserSessionForChat,
  installPersistentDocumentNavigationGuard,
  shrinkBrowserToolResultForMarkdown,
  BROWSER_SCREENSHOT_BASE64_MAX_CHARS,
  BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS,
  type BrowserReActStepOutcome,
  type BrowserToolResult,
} from '../browser-tools.js';
import type { BrowserNavigationPolicyOpts } from '../browser-navigation-url.js';
import { clipUtf8StringToMaxBytes } from '../utf8-clip.js';

// ─── Ops ─────────────────────────────────────────────────────────

/** Single source of truth for ReAct `tool: preview` operations (keep in sync with parseReActBlock). */
export const PREVIEW_REACT_OPS = [
  'state',
  'logs',
  'screenshot',
  'navigate',
  'click',
  'type',
  'scroll',
  'wait',
  'read_page',
  'extract',
  'close',
] as const;

export type PreviewReActOp = (typeof PREVIEW_REACT_OPS)[number];

export const PREVIEW_REACT_OP_SET: ReadonlySet<string> = new Set(PREVIEW_REACT_OPS);

/**
 * Ops that need a server-side Chromium pointed at the preview. Gated behind
 * the same `browserToolsEnabled` flag as the regular `browser` tool so an
 * operator who turned Chromium off for an agent doesn't get it back via the
 * preview tool. `state` / `logs` are plain DB/log reads and are always on.
 */
export const PREVIEW_DRIVE_OPS: ReadonlySet<string> = new Set([
  'screenshot',
  'navigate',
  'click',
  'type',
  'scroll',
  'wait',
  'read_page',
  'extract',
  'close',
]);

export const PREVIEW_LOGS_DEFAULT_TAIL = 200;
export const PREVIEW_LOGS_MAX_TAIL = 1000;
/** Byte cap for the log fence injected into continuation markdown. */
export const PREVIEW_LOGS_MARKDOWN_MAX_BYTES = 48_000;

// ─── Inputs / deps ───────────────────────────────────────────────

/** Fields parsed from `<agenthub:react>` preview actions (see chat.ts). */
export interface PreviewReActActionInput {
  op: string;
  /** navigate — path within the preview app; must start with `/`. */
  route?: string;
  /** logs — number of tail lines (default 200, max 1000). */
  tail?: number;
  target?: string;
  text?: string;
  instruction?: string;
  schema?: Record<string, unknown>;
  direction?: string;
  condition?: string;
}

/**
 * Structural minimum of a preview group row the tool reads.
 */
export interface PreviewReactRow {
  id: string;
  status: string;
  url: string;
  port: number;
  started_at: string;
  last_active_at: string;
}

/**
 * Structural subset of the dev-server runtime used here (test seam).
 */
export interface PreviewRuntimeForReact {
  getActiveBySessionId(sessionId: string): PreviewReactRow | null;
  getLogTail(groupId: string): string[];
  touchPreview(groupId: string): void;
  /**
   * `sessionId` resolves the session's own dial host — required for a
   * container-routed env, which answers on its own address rather than
   * anywhere on the Hub's host.
   */
  serverReachableUrlForPort(port: number, sessionId?: string): string;
}

export interface PreviewReActDeps {
  /** Null when the dev-server runtime is not wired (some tests). */
  runtime: PreviewRuntimeForReact | null;
  /** Agent/project browser tuning (viewport, timeout) for the drive session. */
  launchOpts?: BrowserSessionOptions;
}

/**
 * Pick the runtime serving `chatSessionId`'s preview. Compose and
 * dev-server share the backing table but own disjoint row sets, so at
 * most one runtime has an active group for a session — ownership is
 * resolved eagerly, right here, and the winner is returned as-is (a
 * plain runtime, no stateful wrapper to misuse across sessions or call
 * out of order). When no runtime owns an active group, the first wired
 * runtime is returned so `runPreviewReActStep`'s own
 * `getActiveBySessionId` probe yields the standard "no preview running"
 * outcome. Nulls (unwired runtimes) are skipped; all-null collapses to
 * `null`, which the step reports as "runtime unavailable".
 */
export function resolvePreviewReactRuntime(
  chatSessionId: string,
  runtimes: ReadonlyArray<PreviewRuntimeForReact | null | undefined>,
): PreviewRuntimeForReact | null {
  const live = runtimes.filter((r): r is PreviewRuntimeForReact => r != null);
  if (live.length === 0) return null;
  return live.find((rt) => rt.getActiveBySessionId(chatSessionId) != null) ?? live[0];
}

/** Stable browser-registry id for a session's preview drive browser. */
export function previewBrowserSessionId(chatSessionId: string): string {
  return `preview:${chatSessionId}`;
}

// ─── Request-time origin pin (persistent CDP document guard) ─────

interface PreviewDocumentGuardEntry {
  /** Identity of the live BrowserSession the guard was installed on. */
  sessionObj: unknown;
  origin: string;
  installed: boolean;
  uninstall: () => Promise<void>;
}

const previewDocumentGuards = new Map<string, PreviewDocumentGuardEntry>();

/**
 * Install (or refresh) the persistent document-request guard pinning the
 * drive browser's page to the preview origin. The guard fails any main-frame
 * document request that leaves the origin BEFORE it egresses — covering
 * click/type-driven navigations, form submits, client-side redirects, and
 * redirect hops, none of which pass through `browserNavigate`'s per-goto
 * interception. Re-installs when the underlying browser session was
 * relaunched or the preview origin changed (e.g. the human restarted the
 * preview on a new port). Returns whether request-time interception is
 * active; when false (CDP unavailable), the caller's post-op `guardEscape`
 * checks are the only enforcement.
 */
async function ensurePreviewOriginDocumentGuard(
  browserSessionId: string,
  sessionObj: unknown,
  sh: V3,
  origin: string,
): Promise<boolean> {
  const existing = previewDocumentGuards.get(browserSessionId);
  if (existing && existing.sessionObj === sessionObj && existing.origin === origin) {
    return existing.installed;
  }
  if (existing) {
    await existing.uninstall().catch(() => {});
    previewDocumentGuards.delete(browserSessionId);
  }
  const res = await installPersistentDocumentNavigationGuard(sh, (url) => isOnOrigin(url, origin));
  previewDocumentGuards.set(browserSessionId, {
    sessionObj,
    origin,
    installed: res.installed,
    uninstall: res.uninstall,
  });
  return res.installed;
}

/** Uninstall + forget the request guard (drive browser closing). */
async function releasePreviewDocumentGuard(browserSessionId: string): Promise<void> {
  const entry = previewDocumentGuards.get(browserSessionId);
  if (!entry) return;
  previewDocumentGuards.delete(browserSessionId);
  await entry.uninstall().catch(() => {});
}

export function __resetPreviewDocumentGuardsForTests(): void {
  previewDocumentGuards.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────

function outcome(
  markdown: string,
  hostExit: number,
  hostDetail: string,
  summary: string,
  extra?: Partial<NonNullable<BrowserReActStepOutcome['ui']>>,
): BrowserReActStepOutcome {
  return {
    markdown,
    hostExit,
    hostDetail,
    ui: { summary, ...(extra ?? {}) },
  };
}

function fmtResult(r: BrowserToolResult, title: string): string {
  const display = shrinkBrowserToolResultForMarkdown(r);
  return [`## ${title}`, '', '```json', JSON.stringify(display, null, 2), '```'].join('\n');
}

function asV3(stagehand: unknown): V3 {
  return stagehand as V3;
}

function activePage(sh: V3) {
  let page = sh.context.activePage();
  if (!page) page = sh.context.pages()[0];
  if (!page) throw new Error('No active browser page');
  return page;
}

function currentPageUrl(sh: V3): string | null {
  try {
    return activePage(sh).url();
  } catch {
    return null;
  }
}

function isOnOrigin(pageUrl: string | null, origin: string): boolean {
  if (!pageUrl) return false;
  try {
    return new URL(pageUrl).origin === origin;
  } catch {
    return false;
  }
}

const NO_PREVIEW_MARKDOWN = [
  '## Preview tool',
  '',
  'No preview is running for this session. Preview boot is human-only — ask the',
  'user to press **Start preview** in the chat toolbar (first boot can take',
  'several minutes), then retry this action once the pane shows **Ready**.',
].join('\n');

// ─── Main entry ──────────────────────────────────────────────────

/**
 * Run one `tool: preview` action for `chatSessionId`. Mirrors the
 * {@link BrowserReActStepOutcome} contract used by the `browser` tool so the
 * chat dispatcher can treat both uniformly. Never throws for expected states
 * (no preview, not ready, bad op) — those return hostExit 1/2 with markdown
 * the model can act on.
 */
export async function runPreviewReActStep(
  chatSessionId: string,
  input: PreviewReActActionInput,
  deps: PreviewReActDeps,
): Promise<BrowserReActStepOutcome> {
  const opRaw = typeof input.op === 'string' ? input.op.trim().toLowerCase() : '';
  if (!opRaw || !PREVIEW_REACT_OP_SET.has(opRaw)) {
    return outcome(
      `## Preview tool error\nUnsupported or missing op "${opRaw}"`,
      1,
      'bad_op',
      'Unsupported preview action',
      { errorLine: opRaw ? `Unknown op "${opRaw}"` : 'Missing preview op' },
    );
  }
  const op = opRaw as PreviewReActOp;

  if (!deps.runtime) {
    return outcome(
      '## Preview tool\nNo preview runtime is available on this server, so preview observations cannot be served.',
      2,
      'runtime_unwired',
      'Preview runtime unavailable',
    );
  }
  const runtime = deps.runtime;

  const row = runtime.getActiveBySessionId(chatSessionId);
  if (!row) {
    return outcome(NO_PREVIEW_MARKDOWN, 2, 'no_preview', 'No preview running');
  }

  // Reads that work regardless of status ────────────────────────
  if (op === 'state') {
    const state = {
      status: row.status,
      url: row.url || null,
      port: row.port || null,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
    };
    runtime.touchPreview(row.id);
    return outcome(
      ['## Preview: state', '', '```json', JSON.stringify(state, null, 2), '```'].join('\n'),
      0,
      `state:${row.status}`,
      `Preview is ${row.status}`,
    );
  }

  if (op === 'logs') {
    const tailRaw =
      typeof input.tail === 'number' && Number.isFinite(input.tail) ? input.tail : NaN;
    const tail = Number.isNaN(tailRaw)
      ? PREVIEW_LOGS_DEFAULT_TAIL
      : Math.min(Math.max(Math.floor(tailRaw), 1), PREVIEW_LOGS_MAX_TAIL);
    const lines = runtime.getLogTail(row.id).slice(-tail);
    runtime.touchPreview(row.id);
    const body =
      lines.length > 0
        ? clipUtf8StringToMaxBytes(lines.join('\n'), PREVIEW_LOGS_MARKDOWN_MAX_BYTES)
        : '(no log lines captured yet)';
    return outcome(
      [
        `## Preview: logs (last ${lines.length} line${lines.length === 1 ? '' : 's'}, status: ${row.status})`,
        '',
        '```text',
        body,
        '```',
      ].join('\n'),
      0,
      `logs:${lines.length}`,
      `Read ${lines.length} preview log line(s)`,
    );
  }

  // Drive ops need a ready preview ───────────────────────────────
  if (row.status !== 'ready') {
    const hint =
      row.status === 'starting'
        ? 'The preview is still starting — retry shortly, or use `{"tool":"preview","op":"logs"}` to watch boot progress.'
        : 'The preview failed to boot. Use `{"tool":"preview","op":"logs"}` to inspect the failure; only the human can restart it via **Start preview**.';
    return outcome(
      `## Preview tool\nPreview status is **${row.status}**, so browser ops are unavailable. ${hint}`,
      2,
      `not_ready:${row.status}`,
      `Preview not ready (${row.status})`,
    );
  }

  if (op === 'close') {
    await releasePreviewDocumentGuard(previewBrowserSessionId(chatSessionId));
    const closed = await closeBrowserSession(previewBrowserSessionId(chatSessionId));
    return outcome(
      fmtResult({ ok: true, op: 'close', data: { closed } }, 'Preview: close'),
      0,
      'close',
      'Preview drive browser closed',
    );
  }

  const serverUrl = runtime.serverReachableUrlForPort(row.port, chatSessionId);
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return outcome(
      `## Preview tool error\nCould not resolve a server-reachable preview origin from "${serverUrl}".`,
      1,
      'bad_origin',
      'Preview origin unresolvable',
    );
  }
  const policy: BrowserNavigationPolicyOpts = { allowOrigins: [origin] };

  let session;
  try {
    session = await getOrCreateBrowserSessionForChat(
      previewBrowserSessionId(chatSessionId),
      deps.launchOpts ?? {},
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return outcome(
      `## Preview tool error\nFailed to open the preview drive browser: ${msg}`,
      1,
      'launch_failed',
      'Preview browser failed to start',
      { errorLine: msg },
    );
  }
  const sh = asV3(session.stagehand);
  const opTimeoutMs = deps.launchOpts?.timeoutMs ?? session.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Keep the idle reaper from tearing the preview down mid-drive.
  runtime.touchPreview(row.id);

  // Request-time origin pin: persistent CDP interception fails any
  // main-frame document request that leaves the preview origin BEFORE it
  // egresses — click/type-driven navigations, form submits, client-side
  // redirects, and redirect hops included. guardEscape below stays as the
  // post-op backstop (and the only enforcement when CDP is unavailable).
  const requestGuardInstalled = await ensurePreviewOriginDocumentGuard(
    previewBrowserSessionId(chatSessionId),
    session,
    sh,
    origin,
  );

  /** Navigate within the pinned session. With the persistent guard active we
   *  drive `page.goto` directly — `browserNavigate`'s per-goto interception
   *  would race the guard on the same requestIds and its `Fetch.disable`
   *  would silently kill it. Without the guard (CDP unavailable) we keep
   *  `browserNavigate` so its per-goto interception + URL policy still
   *  apply. Callers wrap the result in `guardEscape` either way. */
  const navigateOnPin = async (url: string): Promise<BrowserToolResult> => {
    if (!requestGuardInstalled) {
      return browserNavigate(sh, url, opTimeoutMs, policy);
    }
    try {
      const page = activePage(sh);
      await page.goto(url, { waitUntil: 'load', timeoutMs: opTimeoutMs });
      return { ok: true, op: 'navigate', data: { url: page.url() } };
    } catch (e) {
      return { ok: false, op: 'navigate', error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** Post-op origin pin, applied to EVERY browser-backed op. The page can
   *  leave the pinned preview origin through any of: click/type in-page
   *  transitions, explicit/auto `navigate` via server-side redirects
   *  (`browserNavigate` only re-checks the general URL policy after
   *  redirects, which public origins pass), or a client-side redirect the
   *  app schedules between the pre-op origin check and an observe op like
   *  `screenshot`/`read_page`/`extract` (TOCTOU). ANY off-origin landing —
   *  public web included, not just policy-blocked private/loopback targets —
   *  is an escape: recover back to the preview root and report failure. The
   *  replacement result intentionally carries no `data`/`imageBase64`, so
   *  content captured from a foreign page is never returned to the agent. */
  const guardEscape = async (r: BrowserToolResult): Promise<BrowserToolResult> => {
    if (!r.ok) return r;
    const landed = currentPageUrl(sh);
    if (!landed || isOnOrigin(landed, origin)) return r;
    await navigateOnPin(`${origin}/`).catch(() => undefined);
    let landedOrigin: string;
    try {
      landedOrigin = new URL(landed).origin;
    } catch {
      landedOrigin = landed.slice(0, 120);
    }
    return {
      ok: false,
      op: r.op,
      error:
        `Action navigated off the preview origin (to ${landedOrigin}); the preview drive ` +
        'browser is pinned to the preview app, so the navigation was reverted to the preview root.',
    };
  };

  if (op === 'navigate') {
    const route = (input.route ?? '').trim();
    if (!route.startsWith('/')) {
      return outcome(
        '## Preview tool error\n`navigate` requires a `route` starting with `/` (a path within the preview app — full URLs are not accepted).',
        1,
        'bad_route',
        'Invalid preview route',
      );
    }
    // With the request guard active, an off-origin redirect hop is failed at
    // request time (the goto errors); guardEscape backstops the landed URL
    // either way.
    const r = await guardEscape(await navigateOnPin(origin + route));
    return outcome(
      fmtResult(r, 'Preview: navigate'),
      r.ok ? 0 : 1,
      r.ok ? `navigate:${route.slice(0, 120)}` : (r.error ?? 'navigate_failed'),
      r.ok ? `Preview opened ${route.slice(0, 120)}` : 'Preview navigation failed',
      r.ok ? { targetSummary: route.slice(0, 220) } : { errorLine: r.error },
    );
  }

  // All remaining ops act on the current page — make sure we're on the
  // preview first (fresh browser sessions sit on about:blank). Same
  // origin-pin applies: a preview root that redirects off-origin is an error,
  // not a page the op may run against.
  if (!isOnOrigin(currentPageUrl(sh), origin)) {
    const nav = await guardEscape(await navigateOnPin(`${origin}/`));
    if (!nav.ok) {
      return outcome(
        `## Preview tool error\nCould not open the preview app before running \`${op}\`: ${nav.error ?? 'navigation failed'}`,
        1,
        'auto_navigate_failed',
        'Preview unreachable',
        { errorLine: nav.error },
      );
    }
  }

  switch (op) {
    case 'click': {
      const r = await guardEscape(await browserClick(sh, input.target ?? ''));
      return outcome(
        fmtResult(r, 'Preview: click'),
        r.ok ? 0 : 1,
        r.ok ? 'click' : (r.error ?? 'click_failed'),
        r.ok ? 'Preview click completed' : 'Preview click failed',
        { targetSummary: input.target?.slice(0, 220), ...(r.ok ? {} : { errorLine: r.error }) },
      );
    }
    case 'type': {
      const r = await guardEscape(await browserType(sh, input.target ?? '', input.text ?? ''));
      return outcome(
        fmtResult(r, 'Preview: type'),
        r.ok ? 0 : 1,
        r.ok ? 'type' : (r.error ?? 'type_failed'),
        r.ok ? 'Typed into preview field' : 'Preview type failed',
        { targetSummary: input.target?.slice(0, 160), ...(r.ok ? {} : { errorLine: r.error }) },
      );
    }
    case 'scroll': {
      const r = await guardEscape(await browserScroll(sh, input.direction ?? ''));
      return outcome(
        fmtResult(r, 'Preview: scroll'),
        r.ok ? 0 : 1,
        r.ok ? `scroll:${input.direction ?? ''}` : (r.error ?? 'scroll_failed'),
        r.ok ? `Preview scrolled ${(input.direction ?? '').trim()}` : 'Preview scroll failed',
        r.ok ? {} : { errorLine: r.error },
      );
    }
    case 'wait': {
      const r = await guardEscape(await browserWaitFixed(sh, input.condition ?? '', opTimeoutMs));
      return outcome(
        fmtResult(r, 'Preview: wait'),
        r.ok ? 0 : 1,
        r.ok ? 'wait' : (r.error ?? 'wait_failed'),
        r.ok ? 'Preview wait finished' : 'Preview wait timed out',
        r.ok ? {} : { errorLine: r.error },
      );
    }
    case 'read_page': {
      // guardEscape AFTER the read: a client-side redirect between the pre-op
      // origin check and the read (TOCTOU) means the captured text may belong
      // to the foreign page — the escape result drops it.
      const r = await guardEscape(await browserReadPage(sh));
      return outcome(
        fmtResult(r, 'Preview: read_page'),
        r.ok ? 0 : 1,
        r.ok ? 'read_page' : (r.error ?? 'read_page_failed'),
        r.ok ? 'Read preview page text' : 'Preview read_page failed',
        r.ok ? {} : { errorLine: r.error },
      );
    }
    case 'extract': {
      const r = await guardEscape(await browserExtract(sh, input.instruction, input.schema));
      return outcome(
        fmtResult(r, 'Preview: extract'),
        r.ok ? 0 : 1,
        r.ok ? 'extract' : (r.error ?? 'extract_failed'),
        r.ok ? 'Extracted preview page data' : 'Preview extract failed',
        r.ok ? {} : { errorLine: r.error },
      );
    }
    case 'screenshot': {
      // Same TOCTOU note as read_page — an off-origin landing voids the
      // capture; guardEscape's replacement result carries no imageBase64.
      const r = await guardEscape(await browserScreenshot(sh));
      const { imageBase64, ...rest } = r;
      const lean = { ...rest, imageBase64: imageBase64 ? '<omitted>' : undefined };
      const lines = ['## Preview: screenshot', '', '```json', JSON.stringify(lean, null, 2), '```'];
      let screenshotWsUrl: string | undefined;
      if (r.ok && imageBase64 && imageBase64.length <= BROWSER_SCREENSHOT_BASE64_MAX_CHARS) {
        const mime = (r.data as { mime?: string } | undefined)?.mime ?? 'image/jpeg';
        lines.push('', `![preview screenshot](data:${mime};base64,${imageBase64})`);
        const dataUrl = `data:${mime};base64,${imageBase64}`;
        if (dataUrl.length <= BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS) {
          screenshotWsUrl = dataUrl;
        }
      }
      return outcome(
        lines.join('\n'),
        r.ok ? 0 : 1,
        r.ok ? 'screenshot' : (r.error ?? 'screenshot_failed'),
        r.ok ? 'Preview screenshot captured' : 'Preview screenshot failed',
        r.ok
          ? { screenshotWsUrl, screenshotCaptured: Boolean(imageBase64) }
          : { errorLine: r.error },
      );
    }
    default:
      // Exhaustiveness backstop — parse + op-set checks make this unreachable.
      return outcome(
        `## Preview tool error\nUnhandled op "${op}"`,
        1,
        'unhandled_op',
        'Unhandled preview action',
      );
  }
}
