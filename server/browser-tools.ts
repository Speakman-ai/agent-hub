/**
 * browser-tools.ts — High-level browser operations for agent chat sessions.
 *
 * Playwright drives navigate, screenshot, selector click/type, scroll, wait,
 * and read_page. Natural-language click/type prefers Playwright getByText, then
 * falls back to Stagehand `act` when a test fake (or attached instance) provides
 * it. `extract` returns a Playwright page snapshot — the coding agent parses it;
 * there is no nested LLM.
 */

import {
  validateBrowserNavigationUrl,
  type BrowserNavigationPolicyOpts,
} from './browser-navigation-url.js';
import { clipUtf8StringToMaxBytes } from './utf8-clip.js';
import {
  getBrowserSession,
  launchBrowserSession,
  closeBrowserSession,
  incrementBrowserToolOpEntered,
  notifyBrowserToolOpEnded,
  DEFAULT_TIMEOUT_MS,
  type BrowserSession,
  type BrowserSessionOptions,
} from './browser.js';
import {
  logBrowserToolAudit,
  redactUrlForBrowserAudit,
  sanitizeBrowserToolAuditDetail,
} from './browser-tool-audit.js';
import {
  getContextFetchGuard,
  pausedRequestResourceType,
  type CdpSessionLike,
  type FetchRequestPausedParams,
} from './browser-context-fetch-guard.js';
import {
  resolveScreenshotDataDir,
  saveBrowserScreenshot,
  screenshotObservationLines,
} from './browser-screenshot-store.js';

// ─── Types ───────────────────────────────────────────────────────

/** Single source of truth for ReAct `tool: browser` operations (keep in sync with parseReActBlock). */
export const BROWSER_REACT_OPS = [
  'navigate',
  'click',
  'type',
  'extract',
  'screenshot',
  'scroll',
  'back',
  'forward',
  'wait',
  'read_page',
  'close',
] as const;

export type BrowserToolOp = (typeof BROWSER_REACT_OPS)[number];

export const BROWSER_REACT_OP_SET: ReadonlySet<string> = new Set(BROWSER_REACT_OPS);

/** Max UTF-8 bytes of `data` JSON embedded in ReAct continuation markdown (per tool result). */
export const BROWSER_TOOL_MARKDOWN_DATA_MAX_BYTES = 24_000;

/** Limits pathological ReAct-supplied extract schemas (size gate only). */
export const BROWSER_EXTRACT_SCHEMA_MAX_JSON_BYTES = 24_000;
export const BROWSER_EXTRACT_SCHEMA_MAX_DEPTH = 14;
export const BROWSER_EXTRACT_SCHEMA_MAX_KEYS_PER_NODE = 80;
export const BROWSER_EXTRACT_SCHEMA_MAX_ARRAY_LENGTH = 96;
export const BROWSER_EXTRACT_SCHEMA_MAX_NODES = 400;

/**
 * Hard ceiling on an encoded capture, purely a memory guard against a
 * pathological full-page screenshot.
 *
 * This used to be a *chat context* limit (750k chars) because the capture was
 * inlined into continuation markdown as a data URL. It no longer is — captures
 * go to disk and the observation carries a path — so a large-but-reasonable
 * screenshot must not be rejected outright. Transport limits live separately in
 * {@link BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS}; keep them independent.
 */
export const BROWSER_SCREENSHOT_BASE64_MAX_CHARS = 12_000_000;

export interface BrowserToolResult {
  ok: boolean;
  op: BrowserToolOp;
  data?: unknown;
  error?: string;
  /** Present for screenshot op — image base64 (no data: prefix); typically JPEG. */
  imageBase64?: string;
}

/** Fields parsed from `<agenthub:react>` browser actions (see chat.ts). */
export interface BrowserReActActionInput {
  /** Parsed from JSON — validated in {@link runBrowserReActStep}. */
  op: string;
  url?: string;
  /** click / type target — natural language or selector string. */
  target?: string;
  text?: string;
  instruction?: string;
  /** Optional JSON-schema–shaped object (size-gated; extract itself is a page snapshot). */
  schema?: Record<string, unknown>;
  direction?: string;
  condition?: string;
}

const SCROLL_DELTA_PX = 720;

export function shrinkBrowserToolResultForMarkdown(
  r: BrowserToolResult,
  maxDataJsonBytes: number = BROWSER_TOOL_MARKDOWN_DATA_MAX_BYTES,
): BrowserToolResult {
  if (!r.ok || r.data === undefined) return r;
  const ser = JSON.stringify(r.data);
  if (Buffer.byteLength(ser, 'utf-8') <= maxDataJsonBytes) return r;
  return {
    ...r,
    data: {
      _browserToolDataTruncated: true,
      approxOriginalJsonBytes: Buffer.byteLength(ser, 'utf-8'),
      preview: clipUtf8StringToMaxBytes(ser, maxDataJsonBytes),
    },
  };
}

type ExtractSchemaWalkState = { nodes: number };

function walkExtractSchemaJson(
  v: unknown,
  depth: number,
  st: ExtractSchemaWalkState,
): { ok: true } | { ok: false; error: string } {
  if (depth > BROWSER_EXTRACT_SCHEMA_MAX_DEPTH) {
    return { ok: false, error: 'extract schema nesting is too deep' };
  }
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return { ok: true };
  }
  if (Array.isArray(v)) {
    st.nodes++;
    if (st.nodes > BROWSER_EXTRACT_SCHEMA_MAX_NODES) {
      return { ok: false, error: 'extract schema is too large (node budget exceeded)' };
    }
    if (v.length > BROWSER_EXTRACT_SCHEMA_MAX_ARRAY_LENGTH) {
      return { ok: false, error: 'extract schema array is too long' };
    }
    for (const item of v) {
      const r = walkExtractSchemaJson(item, depth + 1, st);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (typeof v === 'object') {
    st.nodes++;
    if (st.nodes > BROWSER_EXTRACT_SCHEMA_MAX_NODES) {
      return { ok: false, error: 'extract schema is too large (node budget exceeded)' };
    }
    const keys = Object.keys(v as object);
    if (keys.length > BROWSER_EXTRACT_SCHEMA_MAX_KEYS_PER_NODE) {
      return { ok: false, error: 'extract schema object has too many keys' };
    }
    for (const k of keys) {
      const r = walkExtractSchemaJson((v as Record<string, unknown>)[k], depth + 1, st);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: false, error: 'extract schema has unsupported value type' };
}

/**
 * Reject oversized / pathological JSON Schema objects (legacy extract payload).
 * Uses JSON round-trip so the walk cannot chase circular structures.
 */
export function validateBrowserExtractSchema(
  schema: Record<string, unknown>,
): { ok: true; parsed: Record<string, unknown> } | { ok: false; error: string } {
  let ser: string;
  try {
    ser = JSON.stringify(schema);
  } catch {
    return { ok: false, error: 'extract schema must be JSON-serializable' };
  }
  if (Buffer.byteLength(ser, 'utf8') > BROWSER_EXTRACT_SCHEMA_MAX_JSON_BYTES) {
    return {
      ok: false,
      error: `extract schema JSON exceeds ${BROWSER_EXTRACT_SCHEMA_MAX_JSON_BYTES} UTF-8 bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ser);
  } catch {
    return { ok: false, error: 'extract schema failed to parse' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'extract schema JSON must be a non-null object at the root' };
  }
  const st: ExtractSchemaWalkState = { nodes: 0 };
  const w = walkExtractSchemaJson(parsed, 0, st);
  if (!w.ok) return w;
  return { ok: true, parsed: parsed as Record<string, unknown> };
}

/**
 * Heuristic: treat as a selector when it looks like CSS/XPath/Playwright-style,
 * not a prose phrase (which goes to Stagehand `act`).
 */
export function looksLikeSelectorTarget(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (t.includes('\n')) return false;
  // Prose / natural language — spaces without selector bits
  if (/[\s\u00a0]/.test(t) && !t.includes('>>') && !/[[(]/.test(t)) return false;
  if (t.startsWith('//') || t.startsWith('(//')) return true;
  if (t.includes('>>')) return true;
  if (t.startsWith('#') || t.startsWith('.') || t.startsWith('[')) return true;
  if (/^(xpath|text|role|internal:|aria-|data-testid=)/i.test(t)) return true;
  // Alphanumeric + hyphens tag or simple compound: `div`, `button#x`
  if (/^[a-zA-Z][\w-]*([#.][\w-]+)?$/.test(t)) return true;
  return /^[#.[\w*]/.test(t);
}

/** Playwright Page surface (production) plus the Stagehand-shaped test fakes. */
export type HubPage = {
  url(): string;
  goto(
    url: string,
    opts?: { waitUntil?: string; timeout?: number; timeoutMs?: number },
  ): Promise<unknown>;
  screenshot(opts?: { type?: string; quality?: number }): Promise<Buffer | Uint8Array>;
  locator(selector: string): {
    click: (opts?: object) => Promise<void>;
    fill: (text: string) => Promise<void>;
  };
  evaluate(script: string): Promise<unknown>;
  waitForLoadState?: (state: string, opts?: { timeout?: number } | number) => Promise<void>;
  waitForSelector?: (sel: string, opts?: object) => Promise<void>;
  goBack?: (opts?: object) => Promise<void>;
  goForward?: (opts?: object) => Promise<void>;
  scroll?: (a: number, b: number, c: number, d: number) => Promise<void>;
  mouse?: { wheel: (x: number, y: number) => Promise<void> };
  getByText?: (
    text: string,
    opts?: { exact?: boolean },
  ) => {
    first: () => {
      click: (opts?: object) => Promise<void>;
      fill?: (text: string) => Promise<void>;
    };
  };
  getByLabel?: (
    text: string,
    opts?: { exact?: boolean },
  ) => {
    first: () => {
      click: (opts?: object) => Promise<void>;
      fill?: (text: string) => Promise<void>;
    };
  };
  title?: () => Promise<string> | string;
  innerText?: (selector: string) => Promise<string>;
};

export const PAGE_TEXT_EXCERPT_MAX_CHARS = 2_000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function pageFromContext(ctx: unknown): HubPage | undefined {
  const c = asRecord(ctx);
  if (!c) return undefined;
  if (typeof c.activePage === 'function') {
    const p = (c.activePage as () => HubPage | undefined)();
    if (p) return p;
  }
  if (typeof c.pages === 'function') {
    const pages = (c.pages as () => HubPage[])();
    if (pages?.[0]) return pages[0];
  }
  return undefined;
}

export function getActivePage(host: unknown): HubPage {
  const h = asRecord(host);
  if (!h) throw new Error('No active browser page — navigate first');
  if (h.page && typeof (h.page as HubPage).url === 'function') return h.page as HubPage;
  const fromCtx = pageFromContext(h.context);
  if (fromCtx) return fromCtx;
  const sh = asRecord(h.stagehand);
  const fromSh = pageFromContext(sh?.context);
  if (fromSh) return fromSh;
  throw new Error('No active browser page — navigate first');
}

function getAct(host: unknown): ((instruction: string) => Promise<unknown>) | undefined {
  const h = asRecord(host);
  if (!h) return undefined;
  if (typeof h.act === 'function') return h.act as (instruction: string) => Promise<unknown>;
  const sh = asRecord(h.stagehand);
  if (typeof sh?.act === 'function') return sh.act as (instruction: string) => Promise<unknown>;
  return undefined;
}

/** The raw Playwright context object for `host`, used to key the launch-time Fetch guard. */
function contextObjectOf(host: unknown): object | undefined {
  const h = asRecord(host);
  if (!h) return undefined;
  const ctx = asRecord(h.context) ?? asRecord(asRecord(h.stagehand)?.context);
  return ctx ?? undefined;
}

function playwrightContextOf(host: unknown): {
  newCDPSession?: (page: HubPage) => Promise<CdpSessionLike>;
} | null {
  const ctx = asRecord(contextObjectOf(host));
  if (!ctx) return null;
  if (typeof ctx.newCDPSession === 'function') {
    return ctx as { newCDPSession: (page: HubPage) => Promise<CdpSessionLike> };
  }
  return null;
}

function navOpts(timeoutMs: number): { waitUntil: 'load'; timeout: number } {
  return { waitUntil: 'load', timeout: timeoutMs };
}

export async function capturePageSnapshot(host: unknown): Promise<{
  url: string;
  title: string;
  textExcerpt: string;
}> {
  const page = getActivePage(host);
  const url = page.url();
  let title = '';
  try {
    if (typeof page.title === 'function') {
      const t = await page.title();
      title = typeof t === 'string' ? t.trim() : '';
    }
  } catch {
    title = '';
  }
  let text = '';
  try {
    if (typeof page.innerText === 'function') {
      text = await page.innerText('body');
    } else {
      const v = await page.evaluate(
        `(function(){ const b=document.body; if(!b) return ''; return b.innerText || b.textContent || ''; })()`,
      );
      text = typeof v === 'string' ? v : '';
    }
  } catch {
    text = '';
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return {
    url,
    title,
    textExcerpt:
      collapsed.length > PAGE_TEXT_EXCERPT_MAX_CHARS
        ? `${collapsed.slice(0, PAGE_TEXT_EXCERPT_MAX_CHARS)}…`
        : collapsed,
  };
}

export function pageSnapshotObservationLines(snap: {
  url: string;
  title: string;
  textExcerpt: string;
}): string[] {
  const titleBit = snap.title ? ` — title "${snap.title.replace(/"/g, "'")}"` : '';
  const text = snap.textExcerpt.trim();
  return [
    '',
    `Page: ${snap.url}${titleBit}`,
    text ? `Visible text:\n${text}` : 'Visible text: (empty — the page looks blank to the DOM).',
  ];
}

type PageWithMainSession = HubPage & { mainSession?: CdpSessionLike };

async function resolveCdpSession(host: unknown, page: HubPage): Promise<CdpSessionLike | null> {
  const pw = playwrightContextOf(host);
  if (pw?.newCDPSession) {
    try {
      return await pw.newCDPSession(page);
    } catch {
      // Fall through to Stagehand mainSession on test fakes.
    }
  }
  const ms = (page as PageWithMainSession).mainSession;
  if (ms) return ms;
  return null;
}

/**
 * Pause main-frame document requests during navigation and apply
 * {@link validateBrowserNavigationUrl} so redirect targets cannot bypass policy.
 *
 * When the context already has the launch-time {@link installContextFetchGuard}
 * Fetch owner, we install the policy into it (no second Fetch client). Only when
 * there is no launch guard (ad blocking disabled, or a test fake) do we open a
 * short-lived CDP session for the duration of the navigation. Best-effort: if
 * neither is available, only post-navigation URL checks apply.
 */
async function withDocumentNavigationUrlPolicy(
  host: unknown,
  run: () => Promise<void>,
  policy?: BrowserNavigationPolicyOpts,
): Promise<void> {
  const launchGuard = getContextFetchGuard(contextObjectOf(host));
  if (launchGuard?.installed) {
    const restore = launchGuard.setDocumentPolicy(
      (url) => validateBrowserNavigationUrl(url, policy).ok,
    );
    try {
      await run();
    } finally {
      restore();
    }
    return;
  }
  const page = getActivePage(host);
  const ms = await resolveCdpSession(host, page);
  if (!ms) {
    await run();
    return;
  }
  const handler = (raw: unknown) => {
    const params = raw as FetchRequestPausedParams;
    const { requestId, request } = params;
    const continueReq = () => {
      void ms.send('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    if (pausedRequestResourceType(params) !== 'Document') {
      continueReq();
      return;
    }
    const next = validateBrowserNavigationUrl(request.url, policy);
    if (!next.ok) {
      void ms
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        .catch(() => {});
      return;
    }
    continueReq();
  };
  // Attach BEFORE enabling: Chromium may pause in-flight requests the moment
  // Fetch.enable resolves — with no handler attached they would never be
  // continued and the page would hang.
  ms.on('Fetch.requestPaused', handler);
  let enabled = false;
  try {
    await ms.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    enabled = true;
  } catch (err) {
    ms.off('Fetch.requestPaused', handler);
    console.warn(
      '[browser-tools] Fetch.enable failed; main-frame redirect URL policy is degraded for this navigation:',
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    await run();
  } finally {
    if (enabled) {
      ms.off('Fetch.requestPaused', handler);
      await ms.send('Fetch.disable').catch(() => {});
    }
    // Drop the per-navigation CDP session so it does not leak on the target.
    await ms.detach?.().catch(() => {});
  }
}

/** Result of {@link installPersistentDocumentNavigationGuard}. */
export interface PersistentDocumentGuardHandle {
  /** False when the CDP session is unavailable (callers keep post-op checks as backstop). */
  installed: boolean;
  uninstall: () => Promise<void>;
}

/**
 * Persistent main-frame document-request guard for a browser session whose
 * page must stay pinned to a fixed document set (preview drive). Unlike
 * {@link withDocumentNavigationUrlPolicy} — which wraps a single `page.goto`
 * — this stays installed for the session, so click/type/JS-driven document
 * navigations (and redirect hops) are policy-checked at REQUEST time: a
 * disallowed document request is failed before it egresses, instead of only
 * being reverted after the fact.
 *
 * Scope matches the navigate-time policy: only `Document` resource requests
 * are intercepted; subresources are not (see the browser egress note in the
 * ReAct prompt docs). Best-effort: returns `installed: false` when no Fetch
 * owner is available.
 *
 * When the context has the launch-time {@link installContextFetchGuard} Fetch
 * owner (ad blocking on — the default), the origin pin is installed into that
 * single session's document-policy slot, so there is never a second Fetch
 * client. Only without a launch guard does this open its own persistent CDP
 * session; in that mode do not also run {@link withDocumentNavigationUrlPolicy}
 * on the same page (two transient Fetch clients would race the same requestId,
 * and one's `Fetch.disable` would silently kill the other) — which is why the
 * preview drive path issues raw `page.goto` while the pin is installed.
 */
export async function installPersistentDocumentNavigationGuard(
  host: unknown,
  isDocumentUrlAllowed: (url: string) => boolean,
): Promise<PersistentDocumentGuardHandle> {
  const noop: PersistentDocumentGuardHandle = { installed: false, uninstall: async () => {} };
  // Prefer the launch-time Fetch owner: install the origin pin into it so there
  // is never a second Fetch client on the context (which would race requestIds
  // and let a disallowed document egress before it is failed).
  const launchGuard = getContextFetchGuard(contextObjectOf(host));
  if (launchGuard?.installed) {
    const restore = launchGuard.setDocumentPolicy(isDocumentUrlAllowed);
    return {
      installed: true,
      uninstall: async () => {
        restore();
      },
    };
  }
  let ms: CdpSessionLike | null = null;
  let page: HubPage;
  try {
    page = getActivePage(host);
    ms = await resolveCdpSession(host, page);
  } catch {
    return noop;
  }
  if (!ms) {
    return noop;
  }
  const session = ms;
  const handler = (raw: unknown) => {
    const params = raw as FetchRequestPausedParams;
    const { requestId, request } = params;
    if (pausedRequestResourceType(params) !== 'Document') {
      void session.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    if (!isDocumentUrlAllowed(request.url)) {
      void session
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        .catch(() => {});
      return;
    }
    void session.send('Fetch.continueRequest', { requestId }).catch(() => {});
  };
  // Attach BEFORE enabling: Chromium may pause in-flight requests as soon as
  // Fetch.enable takes effect; an unhandled pause would hang the page.
  session.on('Fetch.requestPaused', handler);
  try {
    await session.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
  } catch (err) {
    session.off('Fetch.requestPaused', handler);
    console.warn(
      '[browser-tools] persistent document guard: Fetch.enable failed; request-time URL policy is degraded for this session:',
      err instanceof Error ? err.message : String(err),
    );
    return noop;
  }
  return {
    installed: true,
    uninstall: async () => {
      session.off('Fetch.requestPaused', handler);
      await session.send('Fetch.disable').catch(() => {});
      // Drop the CDP session so it does not leak on the target for the life of
      // the preview drive.
      await session.detach?.().catch(() => {});
    },
  };
}

export function resolveStagehandModelName(): string {
  const fromEnv = process.env.STAGEHAND_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return 'anthropic/claude-sonnet-5';
}

/**
 * Return an existing {@link BrowserSession} for this chat session or launch one.
 */
export async function getOrCreateBrowserSessionForChat(
  chatSessionId: string,
  extraOpts: BrowserSessionOptions = {},
): Promise<BrowserSession> {
  const existing = getBrowserSession(chatSessionId);
  if (existing) return existing;
  return launchBrowserSession({
    id: chatSessionId,
    ...extraOpts,
  });
}

function result(op: BrowserToolOp, ok: boolean, data?: unknown, error?: string): BrowserToolResult {
  const r: BrowserToolResult = { ok, op };
  if (data !== undefined) r.data = data;
  if (error !== undefined) r.error = error;
  return r;
}

export async function browserNavigate(
  host: unknown,
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  policyOpts?: BrowserNavigationPolicyOpts,
): Promise<BrowserToolResult> {
  const u = url.trim();
  if (!u) return result('navigate', false, undefined, 'url is required');
  const policy = validateBrowserNavigationUrl(u, policyOpts);
  if (!policy.ok) {
    return result('navigate', false, undefined, policy.error);
  }
  try {
    const page = getActivePage(host);
    await withDocumentNavigationUrlPolicy(
      host,
      async () => {
        const res = await page.goto(policy.href, navOpts(timeoutMs));
        void res;
      },
      policyOpts,
    );
    const finalUrl = page.url();
    const landed = validateBrowserNavigationUrl(finalUrl, policyOpts);
    if (!landed.ok) {
      return result(
        'navigate',
        false,
        undefined,
        `Navigation landed on a disallowed URL: ${landed.error}`,
      );
    }
    return result('navigate', true, { url: finalUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('navigate', false, undefined, msg);
  }
}

export async function browserClick(host: unknown, target: string): Promise<BrowserToolResult> {
  const t = target.trim();
  if (!t) return result('click', false, undefined, 'target is required');
  try {
    const page = getActivePage(host);
    if (looksLikeSelectorTarget(t)) {
      await page.locator(t).click();
      return result('click', true, { method: 'locator' });
    }
    if (typeof page.getByText === 'function') {
      try {
        await page.getByText(t, { exact: false }).first().click({ timeout: 8_000 });
        return result('click', true, { method: 'getByText' });
      } catch {
        // Fall through to Stagehand act, then a selector hint.
      }
    }
    const act = getAct(host);
    if (act) {
      await act(`Click ${t}`);
      return result('click', true, { method: 'act' });
    }
    return result(
      'click',
      false,
      undefined,
      `Could not click "${t}". Pass a CSS selector (e.g. button.submit) or take a screenshot and retry.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('click', false, undefined, msg);
  }
}

export async function browserType(
  host: unknown,
  target: string,
  text: string,
): Promise<BrowserToolResult> {
  const t = target.trim();
  if (!t) return result('type', false, undefined, 'target is required');
  try {
    const page = getActivePage(host);
    if (looksLikeSelectorTarget(t)) {
      await page.locator(t).fill(String(text));
      return result('type', true, { method: 'locator' });
    }
    if (typeof page.getByLabel === 'function') {
      try {
        const loc = page.getByLabel(t, { exact: false }).first();
        if (typeof loc.fill === 'function') {
          await loc.fill(String(text));
          return result('type', true, { method: 'getByLabel' });
        }
      } catch {
        // Fall through.
      }
    }
    if (typeof page.getByText === 'function') {
      try {
        const loc = page.getByText(t, { exact: false }).first();
        if (typeof loc.fill === 'function') {
          await loc.fill(String(text));
          return result('type', true, { method: 'getByText' });
        }
      } catch {
        // Fall through to act.
      }
    }
    const act = getAct(host);
    if (act) {
      const escaped = JSON.stringify(String(text));
      await act(`Type ${escaped} into ${t}`);
      return result('type', true, { method: 'act' });
    }
    return result(
      'type',
      false,
      undefined,
      `Could not type into "${t}". Pass a CSS selector or take a screenshot and retry.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('type', false, undefined, msg);
  }
}

export async function browserExtract(
  host: unknown,
  instruction?: string,
  schema?: Record<string, unknown>,
): Promise<BrowserToolResult> {
  try {
    if (schema && typeof schema === 'object' && instruction?.trim()) {
      const policy = validateBrowserExtractSchema(schema);
      if (!policy.ok) {
        return result('extract', false, undefined, policy.error);
      }
    }
    const snap = await capturePageSnapshot(host);
    return result('extract', true, {
      url: snap.url,
      title: snap.title,
      text: snap.textExcerpt,
      instruction: instruction?.trim() || undefined,
      note: 'Host extract is a Playwright page snapshot (no nested LLM). Parse this text yourself; use screenshot if you need layout.',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('extract', false, undefined, msg);
  }
}

export async function browserScreenshot(host: unknown): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(host);
    const buf = await page.screenshot({ type: 'jpeg', quality: 72 });
    const b64 = Buffer.from(buf).toString('base64');
    if (b64.length > BROWSER_SCREENSHOT_BASE64_MAX_CHARS) {
      return result(
        'screenshot',
        false,
        undefined,
        'Screenshot exceeds the maximum capture size the host will hold in memory',
      );
    }
    return { ok: true, op: 'screenshot', data: { mime: 'image/jpeg' }, imageBase64: b64 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('screenshot', false, undefined, msg);
  }
}

async function scrollBy(page: HubPage, deltaY: number): Promise<void> {
  if (page.mouse?.wheel) {
    await page.mouse.wheel(0, deltaY);
    return;
  }
  if (typeof page.scroll === 'function') {
    await page.scroll(0, 0, 0, deltaY);
    return;
  }
  await page.evaluate(`window.scrollBy(0, ${deltaY})`);
}

export async function browserScroll(host: unknown, direction: string): Promise<BrowserToolResult> {
  const d = direction.trim().toLowerCase();
  if (!d)
    return result('scroll', false, undefined, 'direction is required (up, down, top, bottom)');
  try {
    const page = getActivePage(host);
    if (d === 'top') {
      await page.evaluate('window.scrollTo(0, 0)');
    } else if (d === 'bottom') {
      await page.evaluate(
        `window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))`,
      );
    } else if (d === 'up') {
      await scrollBy(page, -SCROLL_DELTA_PX);
    } else if (d === 'down') {
      await scrollBy(page, SCROLL_DELTA_PX);
    } else {
      return result(
        'scroll',
        false,
        undefined,
        `Unknown direction "${direction}" — use up, down, top, or bottom`,
      );
    }
    return result('scroll', true, { direction: d });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('scroll', false, undefined, msg);
  }
}

export async function browserBack(
  host: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  policyOpts?: BrowserNavigationPolicyOpts,
): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(host);
    await withDocumentNavigationUrlPolicy(
      host,
      async () => {
        await page.goBack?.(navOpts(timeoutMs));
      },
      policyOpts,
    );
    const finalUrl = page.url();
    const landed = validateBrowserNavigationUrl(finalUrl, policyOpts);
    if (!landed.ok) {
      return result(
        'back',
        false,
        undefined,
        `History navigation landed on a disallowed URL: ${landed.error}`,
      );
    }
    return result('back', true, { url: finalUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('back', false, undefined, msg);
  }
}

export async function browserForward(
  host: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  policyOpts?: BrowserNavigationPolicyOpts,
): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(host);
    await withDocumentNavigationUrlPolicy(
      host,
      async () => {
        await page.goForward?.(navOpts(timeoutMs));
      },
      policyOpts,
    );
    const finalUrl = page.url();
    const landed = validateBrowserNavigationUrl(finalUrl, policyOpts);
    if (!landed.ok) {
      return result(
        'forward',
        false,
        undefined,
        `History navigation landed on a disallowed URL: ${landed.error}`,
      );
    }
    return result('forward', true, { url: finalUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('forward', false, undefined, msg);
  }
}

export async function browserWaitFixed(
  host: unknown,
  condition: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BrowserToolResult> {
  const c = condition.trim();
  if (!c) return result('wait', false, undefined, 'condition is required');
  try {
    const page = getActivePage(host);
    const lower = c.toLowerCase();
    const waitState = async (state: string) => {
      if (!page.waitForLoadState) throw new Error('waitForLoadState is not available');
      await page.waitForLoadState(state, { timeout: timeoutMs });
    };
    if (lower === 'networkidle' || lower === 'network_idle' || lower === 'network-idle') {
      await waitState('networkidle');
      return result('wait', true, { kind: 'networkidle' });
    }
    if (lower === 'load') {
      await waitState('load');
      return result('wait', true, { kind: 'load' });
    }
    if (lower === 'domcontentloaded' || lower === 'dom') {
      await waitState('domcontentloaded');
      return result('wait', true, { kind: 'domcontentloaded' });
    }
    const selPrefix = /^selector:\s*/i.exec(c);
    const selector = selPrefix ? c.slice(selPrefix[0].length).trim() : c;
    if (!page.waitForSelector) throw new Error('waitForSelector is not available');
    await page.waitForSelector(selector, {
      state: 'visible',
      timeout: timeoutMs,
    });
    return result('wait', true, { kind: 'selector', selector });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('wait', false, undefined, msg);
  }
}

export async function browserReadPage(host: unknown): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(host);
    const text = await page.evaluate(`(function(){
      const b=document.body;
      if(!b) return '';
      return b.innerText || b.textContent || '';
    })()`);
    const s = typeof text === 'string' ? text : String(text ?? '');
    return result('read_page', true, { text: s.slice(0, 800_000) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('read_page', false, undefined, msg);
  }
}

/** Max `data:` URL length for live WebSocket screenshot preview (browser chat UI). */
export const BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS = 120_000;

export interface BrowserStepUiExtras {
  summary: string;
  extractPreview?: string;
  screenshotWsUrl?: string;
  /** True when a screenshot op succeeded and produced image bytes (not whether a WS preview was sent). */
  screenshotCaptured?: boolean;
  targetSummary?: string;
  errorLine?: string;
}

/** Return type for chat host step + collapsible timeline copy. */
export type BrowserReActStepOutcome = {
  markdown: string;
  hostExit: number;
  hostDetail?: string;
  ui?: BrowserStepUiExtras;
};

export function summarizeJsonPreview(data: unknown, maxChars = 400): string | undefined {
  try {
    const s =
      typeof data === 'string' ? data.slice(0, maxChars + 400) : JSON.stringify(data, null, 0);
    if (s.length <= maxChars) return s;
    return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
  } catch {
    return undefined;
  }
}

/** Present-tense line for streaming browser status under the assistant turn. */
export function browserToolStartLabel(input: BrowserReActActionInput): string {
  const op = (input.op ?? '').trim().toLowerCase();
  const ell = '…';
  switch (op) {
    case 'navigate': {
      const raw = (input.url ?? '').trim();
      if (!raw) return `Navigating${ell}`;
      try {
        const h = new URL(raw).hostname;
        return h ? `Navigating to ${h}${ell}` : `Navigating${ell}`;
      } catch {
        return `Navigating${ell}`;
      }
    }
    case 'click': {
      const t = (input.target ?? '').trim();
      const one = t.replace(/\s+/g, ' ').trim();
      const short = one.length > 72 ? `${one.slice(0, 71)}…` : one;
      return short ? `Clicking ${short}…` : 'Clicking element…';
    }
    case 'type':
      if (!(input.target ?? '').trim()) return 'Typing…';
      {
        const tgt = (input.target ?? '').trim().replace(/\s+/g, ' ');
        return tgt.length > 72 ? `Typing into ${tgt.slice(0, 71)}…` : `Typing into ${tgt}…`;
      }
    case 'extract':
      if (!(input.instruction ?? '').trim()) return 'Extracting page content…';
      {
        const ins = (input.instruction ?? '').trim().replace(/\s+/g, ' ');
        return ins.length > 64 ? `Extracting ${ins.slice(0, 63)}…` : `Extracting ${ins}…`;
      }
    case 'screenshot':
      return 'Taking screenshot…';
    case 'scroll': {
      const d = (input.direction ?? '').trim();
      return d ? `Scrolling ${d}…` : 'Scrolling…';
    }
    case 'back':
      return 'Going back…';
    case 'forward':
      return 'Going forward…';
    case 'wait': {
      const c = (input.condition ?? '').trim();
      if (!c) return 'Waiting…';
      return c.length > 80 ? `Waiting for ${c.slice(0, 79)}…` : `Waiting for ${c}…`;
    }
    case 'read_page':
      return 'Reading page text…';
    case 'close':
      return 'Closing browser…';
    default:
      return 'Running browser tool…';
  }
}

function hostHintFromNavigateData(data: unknown): string | undefined {
  const u = (data as { url?: string } | undefined)?.url;
  if (!u || typeof u !== 'string') return undefined;
  try {
    return new URL(u).hostname;
  } catch {
    const s = u.replace(/^https?:\/\//i, '').split('/')[0];
    return s || undefined;
  }
}

/**
 * Run one browser tool from a parsed ReAct action. Injects markdown for the model.
 */
export async function runBrowserReActStep(
  chatSessionId: string,
  input: BrowserReActActionInput,
  sessionLaunchOpts: BrowserSessionOptions = {},
): Promise<BrowserReActStepOutcome> {
  const opRaw = typeof input.op === 'string' ? input.op.trim() : '';
  if (!opRaw || !BROWSER_REACT_OP_SET.has(opRaw)) {
    logBrowserToolAudit({
      chatSessionId,
      op: opRaw || 'missing',
      ok: false,
      hostExit: 1,
      detail: 'bad_op',
    });
    return {
      markdown: `## Browser tool error\nUnsupported or missing op "${opRaw}"`,
      hostExit: 1,
      hostDetail: 'bad_op',
      ui: {
        summary: 'Unsupported browser action',
        errorLine: opRaw ? `Unknown op "${opRaw}"` : 'Missing browser op',
      },
    };
  }
  const op = opRaw as BrowserToolOp;
  let session: BrowserSession;
  try {
    session = await getOrCreateBrowserSessionForChat(chatSessionId, sessionLaunchOpts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logBrowserToolAudit({
      chatSessionId,
      op: opRaw,
      ok: false,
      hostExit: 1,
      detail: 'launch_failed',
    });
    return {
      markdown: `## Browser tool error\nFailed to open browser session: ${msg}`,
      hostExit: 1,
      hostDetail: 'launch_failed',
      ui: { summary: 'Browser failed to start', errorLine: msg },
    };
  }
  const opTimeoutMs = sessionLaunchOpts.timeoutMs ?? session.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = session;

  const finish = (b: BrowserReActStepOutcome): BrowserReActStepOutcome => {
    logBrowserToolAudit({
      chatSessionId,
      op: opRaw,
      ok: b.hostExit === 0,
      hostExit: b.hostExit,
      detail: sanitizeBrowserToolAuditDetail({
        op: opRaw,
        hostExit: b.hostExit,
        hostDetail: typeof b.hostDetail === 'string' ? b.hostDetail : undefined,
        navigateUrl: input.url,
      }),
      urlSnippet: opRaw === 'navigate' ? redactUrlForBrowserAudit(input.url) : undefined,
    });
    return b;
  };

  // Never inline image bytes here: this markdown becomes pending context, which
  // is byte-capped. Image-bearing ops persist to disk and report a path.
  const fmt = (r: BrowserToolResult, title: string) => {
    const { imageBase64, ...rest } = shrinkBrowserToolResultForMarkdown(r);
    const display = { ...rest, imageBase64: imageBase64 ? '<omitted>' : undefined };
    return [`## ${title}`, '', '```json', JSON.stringify(display, null, 2), '```'].join('\n');
  };

  incrementBrowserToolOpEntered(chatSessionId);
  try {
    switch (op) {
      case 'close': {
        const closed = await closeBrowserSession(chatSessionId);
        const r = result('close', true, { closed });
        return finish({
          markdown: fmt(r, 'Browser: close'),
          hostExit: 0,
          hostDetail: 'close',
          ui: { summary: 'Browser session closed' },
        });
      }
      case 'navigate': {
        const r = await browserNavigate(host, input.url ?? '', opTimeoutMs);
        const openedHost = r.ok ? hostHintFromNavigateData(r.data) : undefined;
        return finish({
          markdown: fmt(r, 'Browser: navigate'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? input.url?.slice(0, 120) : r.error,
          ui: r.ok
            ? {
                summary: openedHost ? `Opened ${openedHost}` : 'Page loaded',
                targetSummary: input.url?.slice(0, 220),
              }
            : {
                summary: 'Navigation failed',
                errorLine: r.error,
                targetSummary: input.url?.slice(0, 220),
              },
        });
      }
      case 'click': {
        const r = await browserClick(host, input.target ?? '');
        return finish({
          markdown: fmt(r, 'Browser: click'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { method?: string })?.method : r.error,
          ui: r.ok
            ? { summary: 'Click completed', targetSummary: input.target?.slice(0, 220) }
            : {
                summary: 'Click failed',
                errorLine: r.error,
                targetSummary: input.target?.slice(0, 220),
              },
        });
      }
      case 'type': {
        const r = await browserType(host, input.target ?? '', input.text ?? '');
        return finish({
          markdown: fmt(r, 'Browser: type'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { method?: string })?.method : r.error,
          ui: r.ok
            ? {
                summary: 'Typed into field',
                targetSummary: input.target?.slice(0, 160),
              }
            : {
                summary: 'Type action failed',
                errorLine: r.error,
                targetSummary: input.target?.slice(0, 160),
              },
        });
      }
      case 'extract': {
        const r = await browserExtract(host, input.instruction, input.schema);
        const preview = r.ok ? summarizeJsonPreview(r.data) : undefined;
        return finish({
          markdown: fmt(r, 'Browser: extract'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? 'extract' : r.error,
          ui: r.ok
            ? { summary: 'Extracted page data', extractPreview: preview }
            : { summary: 'Extract failed', errorLine: r.error },
        });
      }
      case 'screenshot': {
        const r = await browserScreenshot(host);
        const { imageBase64, ...rest } = r;
        const mime = (r.data as { mime?: string } | undefined)?.mime ?? 'image/jpeg';
        // The image goes to a file, never into continuation markdown — inlined
        // base64 blew the 128 KiB pending-context cap and evicted every other
        // observation in the turn.
        const saved =
          r.ok && imageBase64
            ? saveBrowserScreenshot({
                sessionId: chatSessionId,
                dataDir: resolveScreenshotDataDir(),
                imageBase64,
                mime,
                label: 'browser',
              })
            : null;
        const lean = {
          ...rest,
          data: r.ok ? { ...(r.data as object | undefined), savedPath: saved?.absPath } : r.data,
          imageBase64: imageBase64
            ? saved
              ? '<saved to file>'
              : '<capture not persisted>'
            : undefined,
        };
        const lines = [
          '## Browser: screenshot',
          '',
          '```json',
          JSON.stringify(lean, null, 2),
          '```',
        ];
        let screenshotWsUrl: string | undefined;
        if (r.ok && imageBase64) {
          lines.push(...screenshotObservationLines(saved, mime));
          try {
            lines.push(...pageSnapshotObservationLines(await capturePageSnapshot(host)));
          } catch {
            // Snapshot is advisory — never fail a successful capture.
          }
          const dataUrl = `data:${mime};base64,${imageBase64}`;
          if (dataUrl.length <= BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS) {
            screenshotWsUrl = dataUrl;
          }
        }
        return finish({
          markdown: lines.join('\n'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? 'screenshot' : r.error,
          ui: r.ok
            ? {
                summary: 'Screenshot captured',
                screenshotWsUrl,
                screenshotCaptured: Boolean(imageBase64),
              }
            : { summary: 'Screenshot failed', errorLine: r.error },
        });
      }
      case 'scroll': {
        const r = await browserScroll(host, input.direction ?? '');
        return finish({
          markdown: fmt(r, 'Browser: scroll'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? input.direction : r.error,
          ui: r.ok
            ? {
                summary: `Scrolled ${(input.direction ?? '').trim()}`,
                targetSummary: input.direction,
              }
            : { summary: 'Scroll failed', errorLine: r.error },
        });
      }
      case 'back': {
        const r = await browserBack(host, opTimeoutMs);
        const openedHost = r.ok ? hostHintFromNavigateData(r.data) : undefined;
        return finish({
          markdown: fmt(r, 'Browser: back'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { url?: string } | undefined)?.url : r.error,
          ui: r.ok
            ? { summary: openedHost ? `Back · ${openedHost}` : 'Navigated back' }
            : { summary: 'Back navigation failed', errorLine: r.error },
        });
      }
      case 'forward': {
        const r = await browserForward(host, opTimeoutMs);
        const openedHost = r.ok ? hostHintFromNavigateData(r.data) : undefined;
        return finish({
          markdown: fmt(r, 'Browser: forward'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { url?: string } | undefined)?.url : r.error,
          ui: r.ok
            ? { summary: openedHost ? `Forward · ${openedHost}` : 'Navigated forward' }
            : { summary: 'Forward navigation failed', errorLine: r.error },
        });
      }
      case 'wait': {
        const r = await browserWaitFixed(host, input.condition ?? '', opTimeoutMs);
        return finish({
          markdown: fmt(r, 'Browser: wait'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { kind?: string } | undefined)?.kind : r.error,
          ui: r.ok
            ? { summary: `Wait finished (${input.condition ?? ''})`.slice(0, 220) }
            : { summary: 'Wait timed out', errorLine: r.error },
        });
      }
      case 'read_page': {
        const r = await browserReadPage(host);
        const body = r.data as { text?: string } | undefined;
        const pageText = body?.text ?? '';
        if (!r.ok) {
          return finish({
            markdown: fmt(r, 'Browser: read_page'),
            hostExit: 1,
            hostDetail: r.error,
            ui: { summary: 'Read page failed', errorLine: r.error },
          });
        }
        const maxShow = 24_000;
        const fullLen = pageText.length;
        const snippet =
          fullLen > maxShow
            ? `${pageText.slice(0, maxShow)}\n\n… [truncated, ${fullLen} chars total]`
            : pageText;
        const lean = {
          ok: true,
          op: 'read_page' as const,
          data: { text: snippet, totalChars: fullLen },
        };
        const lines = [
          '## Browser: read_page',
          '',
          '```json',
          JSON.stringify(lean, null, 2),
          '```',
        ];
        const preview = snippet.length <= 520 ? snippet : `${snippet.slice(0, 519)}…`;
        return finish({
          markdown: lines.join('\n'),
          hostExit: 0,
          hostDetail: `chars:${fullLen}`,
          ui: {
            summary: `Read ${fullLen.toLocaleString()} characters from page`,
            extractPreview: preview,
          },
        });
      }
      default: {
        return finish({
          markdown: `## Browser tool error\nUnsupported op`,
          hostExit: 1,
          hostDetail: 'bad_op',
          ui: { summary: 'Unsupported browser op', errorLine: 'bad_op' },
        });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return finish({
      markdown: `## Browser tool error\n${msg}`,
      hostExit: 1,
      hostDetail: 'threw',
      ui: { summary: 'Browser threw an error', errorLine: msg },
    });
  } finally {
    notifyBrowserToolOpEnded(chatSessionId);
  }
}
