/**
 * design-react.ts — host-mediated `tool: design` ReAct action.
 *
 * Lets ANY agent, on ANY session and engine, render HTML/CSS/JS (a chart, a
 * mockup, a diagram, a small app) inline mid-turn — without switching the
 * session into design mode. The host:
 *
 *   1. Writes the HTML to the session's design artifact dir (the same
 *      `<worktree>/design` or `<dataDir>/design-sessions/<id>` root the
 *      `/session-files/<id>/design/*` mount serves), so it persists and is
 *      viewable.
 *   2. Renders it in server-side Chromium and streams a screenshot to the
 *      existing BrowserActivityPanel (web + mobile) via the same
 *      `browser_activity_*` broadcast the preview/browser tools use — no new
 *      client surface required.
 *
 * Invariants:
 * - **Always available.** Unlike `preview` (needs a dev server) or `browser`
 *   (config-gated), design render works everywhere: the artifact root falls
 *   back to the data-dir store when the session has no worktree, and rendering
 *   uses `page.setContent` (no navigation), so no egress policy is involved for
 *   the document itself. Subresources the HTML pulls (e.g. a chart lib from a
 *   public CDN) load as normal public-web requests.
 * - **Contract parity.** Returns the shared {@link BrowserReActStepOutcome} so
 *   the chat dispatcher treats it exactly like `preview` / `browser`.
 * - **Render failure never loses the artifact.** If Chromium can't launch, the
 *   HTML is still written and served; the step reports the save + a warning
 *   rather than failing outright.
 */
import path from 'path';
import fs from 'fs';
import type { BrowserSessionOptions } from './browser.js';
import { closeBrowserSession, DEFAULT_TIMEOUT_MS } from './browser.js';
import {
  browserScreenshot,
  getActivePage,
  getOrCreateBrowserSessionForChat,
  BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS,
  type BrowserReActStepOutcome,
} from './browser-tools.js';
import {
  resolveScreenshotDataDir,
  saveBrowserScreenshot,
  screenshotObservationLines,
} from './browser-screenshot-store.js';
import {
  worktreeDesignLocation,
  dataDirDesignLocation,
  type DesignArtifactLocation,
} from './design-artifact-store.js';

// ─── Ops ─────────────────────────────────────────────────────────

/** Single source of truth for ReAct `tool: design` operations (keep in sync with parseReActBlock). */
export const DESIGN_REACT_OPS = ['render'] as const;
export type DesignReActOp = (typeof DESIGN_REACT_OPS)[number];
export const DESIGN_REACT_OP_SET: ReadonlySet<string> = new Set(DESIGN_REACT_OPS);

/** File the rendered document is written to (the canvas mount serves it). */
export const DESIGN_RENDER_FILENAME = 'index.html';

/**
 * Max size of an agent-supplied design document. Generous enough for a
 * self-contained chart/mockup page, small enough to keep a runaway paste from
 * blowing the artifact dir or the render.
 */
export const MAX_DESIGN_HTML_BYTES = 512 * 1024;

// ─── Inputs / deps ───────────────────────────────────────────────

/** Fields parsed from `<agenthub:react>` design actions (see chat.ts). */
export interface DesignReActActionInput {
  op: string;
  /** render — the HTML/CSS/JS document (full page or a body fragment). */
  html?: string;
  /** render — optional <title> when `html` is a fragment. */
  title?: string;
}

export interface DesignRenderResult {
  ok: boolean;
  imageBase64?: string;
  mime?: string;
  error?: string;
}

export interface DesignReActDeps {
  /** Where to write the artifact. Caller resolves it (worktree vs data-dir). */
  location: DesignArtifactLocation;
  /** Render the document to a screenshot. Injected so tests skip Chromium. */
  render: (html: string) => Promise<DesignRenderResult>;
  /** FS seam (default: real mkdir + writeFile). */
  writeArtifact?: (root: string, filename: string, contents: string) => void;
  /** Path the artifact is served at, for the observation markdown. */
  servedPath?: string;
  /** Screenshot persistence dir (default: resolveScreenshotDataDir()). */
  screenshotDataDir?: string;
  /** Session id, for naming the persisted screenshot. */
  sessionId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Stable browser-registry id for a session's design render browser. */
export function designBrowserSessionId(chatSessionId: string): string {
  return `design:${chatSessionId}`;
}

function outcome(
  markdown: string,
  hostExit: number,
  hostDetail: string,
  summary: string,
  extra?: Partial<NonNullable<BrowserReActStepOutcome['ui']>>,
): BrowserReActStepOutcome {
  return { markdown, hostExit, hostDetail, ui: { summary, ...(extra ?? {}) } };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Wrap a body fragment in a minimal document. A full document (has `<html>` or
 * a doctype) is left untouched so the agent keeps full control over `<head>`,
 * scripts, and styles.
 */
export function toFullDesignDocument(html: string, title?: string): string {
  const trimmed = html.trim();
  if (/<!doctype/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) return trimmed;
  const t = escapeHtml((title ?? 'Design').trim() || 'Design');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${t}</title>`,
    '</head>',
    '<body>',
    trimmed,
    '</body>',
    '</html>',
  ].join('\n');
}

function defaultWriteArtifact(root: string, filename: string, contents: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, filename), contents, 'utf8');
}

/**
 * Resolve where an always-on design render writes, independent of session mode.
 * Mirrors `resolveDesignLocationForServe` exactly so the `/session-files` mount
 * serves whatever this writes: worktree when present, else the per-session
 * data-dir store.
 */
export function resolveDesignRenderLocation(args: {
  worktreePath?: string | null;
  sessionId: string;
  dataDir: string;
}): DesignArtifactLocation {
  const worktree = (args.worktreePath ?? '').trim();
  if (worktree) return worktreeDesignLocation(worktree);
  return dataDirDesignLocation(args.dataDir, args.sessionId);
}

/**
 * Render an HTML document to a JPEG screenshot in server-side Chromium.
 *
 * Uses `page.setContent` (not navigation) so the document itself never touches
 * the browser egress policy. A short post-load `networkidle` wait gives
 * CDN-loaded chart libraries time to fetch and draw. Always closes its
 * throwaway browser session.
 */
export async function renderDesignHtmlScreenshot(
  chatSessionId: string,
  html: string,
  launchOpts?: BrowserSessionOptions,
): Promise<DesignRenderResult> {
  const browserSessionId = designBrowserSessionId(chatSessionId);
  // Preserve the browser-session type inferred from getOrCreateBrowserSessionForChat
  // rather than widening to `unknown` (getActivePage/browserScreenshot accept it as-is).
  let session: Awaited<ReturnType<typeof getOrCreateBrowserSessionForChat>>;
  try {
    session = await getOrCreateBrowserSessionForChat(browserSessionId, launchOpts ?? {});
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const timeout = launchOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const page = getActivePage(session);
    const setContent = (page as { setContent?: unknown }).setContent;
    if (typeof setContent !== 'function') {
      return { ok: false, error: 'Browser page does not support setContent rendering' };
    }
    await (setContent as (h: string, o?: object) => Promise<void>).call(page, html, {
      waitUntil: 'load',
      timeout,
    });
    // Best-effort: let async chart/data libs settle. Never fails the render.
    try {
      await page.waitForLoadState?.('networkidle', { timeout: 2000 });
    } catch {
      /* networkidle may never settle; the load screenshot is still valid */
    }
    const shot = await browserScreenshot(session);
    if (!shot.ok || !shot.imageBase64) {
      return { ok: false, error: shot.error ?? 'screenshot capture failed' };
    }
    const mime = (shot.data as { mime?: string } | undefined)?.mime ?? 'image/jpeg';
    return { ok: true, imageBase64: shot.imageBase64, mime };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await closeBrowserSession(browserSessionId).catch(() => {});
  }
}

// ─── Main entry ──────────────────────────────────────────────────

/**
 * Run one `tool: design` action for `chatSessionId`. Mirrors the
 * {@link BrowserReActStepOutcome} contract. Never throws for expected states
 * (bad op, missing/oversize html, render failure) — those return a non-zero
 * hostExit with actionable markdown.
 */
export async function runDesignReActStep(
  input: DesignReActActionInput,
  deps: DesignReActDeps,
): Promise<BrowserReActStepOutcome> {
  const opRaw = typeof input.op === 'string' ? input.op.trim().toLowerCase() : '';
  if (!opRaw || !DESIGN_REACT_OP_SET.has(opRaw)) {
    return outcome(
      `## Design tool error\nUnsupported or missing op "${opRaw}". Supported: \`render\`.`,
      1,
      'bad_op',
      'Unsupported design action',
      { errorLine: opRaw ? `Unknown op "${opRaw}"` : 'Missing design op' },
    );
  }

  const rawHtml = typeof input.html === 'string' ? input.html : '';
  if (!rawHtml.trim()) {
    return outcome(
      '## Design tool error\n`render` requires a non-empty `html` field (a full HTML document or a body fragment).',
      1,
      'missing_html',
      'Design render missing html',
      { errorLine: 'html is required' },
    );
  }
  if (Buffer.byteLength(rawHtml, 'utf8') > MAX_DESIGN_HTML_BYTES) {
    return outcome(
      `## Design tool error\nThe \`html\` document exceeds the ${Math.floor(
        MAX_DESIGN_HTML_BYTES / 1024,
      )} KB limit. Trim inline data or load large assets from a CDN.`,
      1,
      'html_too_large',
      'Design html too large',
      { errorLine: 'html exceeds size limit' },
    );
  }

  const doc = toFullDesignDocument(rawHtml, input.title);
  const write = deps.writeArtifact ?? defaultWriteArtifact;

  let saveError: string | null = null;
  try {
    write(deps.location.root, DESIGN_RENDER_FILENAME, doc);
  } catch (e) {
    saveError = e instanceof Error ? e.message : String(e);
  }

  const servedLine = deps.servedPath ? `\n- Served at \`${deps.servedPath}\`` : '';

  if (saveError) {
    // Could not persist — but still try to render so the user sees something.
    const r = await deps.render(doc).catch(
      (e): DesignRenderResult => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    const ok = r.ok && !!r.imageBase64;
    return buildRenderOutcome({
      r,
      ok,
      deps,
      savedNote: `\n- **Warning:** could not persist the artifact: ${saveError}`,
      servedLine: '',
      // The required artifact never made it to disk — this host step is a
      // failure regardless of whether the live screenshot rendered.
      persistFailed: true,
    });
  }

  const r = await deps
    .render(doc)
    .catch(
      (e): DesignRenderResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  return buildRenderOutcome({
    r,
    ok: r.ok && !!r.imageBase64,
    deps,
    savedNote: '',
    servedLine,
    persistFailed: false,
  });
}

function buildRenderOutcome(args: {
  r: DesignRenderResult;
  ok: boolean;
  deps: DesignReActDeps;
  savedNote: string;
  servedLine: string;
  /** True when the artifact could not be written — forces a non-zero exit. */
  persistFailed: boolean;
}): BrowserReActStepOutcome {
  const { r, ok, deps, savedNote, servedLine, persistFailed } = args;
  if (!ok) {
    // Render failed. Exit is non-zero only when persistence ALSO failed;
    // a saved artifact with a failed live render is a soft warning (exit 0).
    return outcome(
      [
        persistFailed
          ? '## Design tool error (artifact not saved)'
          : '## Design rendered (artifact saved)',
        '',
        persistFailed
          ? 'The design document could not be saved AND the live preview could not be rendered:'
          : 'The design document was saved, but the live preview could not be rendered:',
        '',
        '```',
        r.error ?? 'unknown render error',
        '```',
        savedNote,
        servedLine,
        '',
        'This is an environment/render issue, not a missing capability — the design',
        'tool exists and renders whenever server-side Chromium can launch.',
      ]
        .filter(Boolean)
        .join('\n'),
      persistFailed ? 1 : 0,
      persistFailed ? 'persist_failed' : 'render_failed',
      persistFailed
        ? 'Design not saved, preview render failed'
        : 'Design saved, preview render failed',
      { errorLine: r.error },
    );
  }

  const mime = r.mime ?? 'image/jpeg';
  const saved = saveBrowserScreenshot({
    sessionId: deps.sessionId,
    dataDir: deps.screenshotDataDir ?? resolveScreenshotDataDir(),
    imageBase64: r.imageBase64!,
    mime,
    label: 'design',
  });
  const header = persistFailed ? '## Design rendered (artifact NOT saved)' : '## Design rendered';
  const lead = persistFailed
    ? 'Streamed the render to the chat, but the artifact could not be persisted.'
    : 'Rendered your design and streamed it to the chat.';
  const lines = [header, '', lead];
  if (servedLine) lines.push(servedLine.replace(/^\n/, ''));
  if (savedNote) lines.push(savedNote.replace(/^\n/, ''));
  lines.push('', ...screenshotObservationLines(saved, mime));

  let screenshotWsUrl: string | undefined;
  const dataUrl = `data:${mime};base64,${r.imageBase64!}`;
  if (dataUrl.length <= BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS) {
    screenshotWsUrl = dataUrl;
  }

  // A rendered screenshot with a lost artifact must not read as a fully
  // successful host step — the saved artifact is a required output.
  return outcome(
    lines.join('\n'),
    persistFailed ? 1 : 0,
    persistFailed ? 'persist_failed' : 'render',
    persistFailed ? 'Design rendered, artifact not saved' : 'Design rendered',
    {
      screenshotWsUrl,
      screenshotCaptured: true,
    },
  );
}
