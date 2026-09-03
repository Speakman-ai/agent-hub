/**
 * browser-screencast.ts — Live mirror of a session's public-web Chromium.
 *
 * The agent's `browser` tool drives a headless Playwright Chromium that humans
 * could previously only observe through per-action stills. This module turns
 * that Chromium into a live feed via CDP `Page.startScreencast`, and lets a
 * human viewer act on it (mouse, keyboard, URL bar).
 *
 * Design:
 *   • One {@link ScreencastFeed} per browser-session id, created on the first
 *     viewer and torn down when the last viewer detaches. Frames are fanned out
 *     to every viewer; a late viewer receives the last frame immediately.
 *   • A viewer can attach before the agent has opened a browser. The feed
 *     reports `waiting` and hooks the registry's lifecycle stream so it goes
 *     `live` the moment the session launches, and `closed` when it goes away.
 *   • While at least one viewer is attached, the browser's idle auto-close is
 *     deferred (the same pairing an in-flight agent op uses), so a pane the
 *     human is watching never disappears under them. Closing the pane releases
 *     the hold.
 *   • Human input is refused while an agent step is in flight
 *     (`agent_busy`) — single-writer turn-taking, mirroring the shared
 *     terminal. Human navigation goes through the same URL policy as the
 *     agent's `navigate` op, so the pane cannot reach targets the agent cannot.
 *
 * This feed only ever binds to the generic `browser` session (public web). The
 * preview-drive Chromium (`preview:<sessionId>`) is intentionally not
 * screencast — the preview pane is the human's own iframe of that app.
 */

import {
  browserToolOpsInFlight,
  DEFAULT_TIMEOUT_MS,
  getBrowserSession,
  incrementBrowserToolOpEntered,
  notifyBrowserToolOpEnded,
  subscribeBrowserSessionLifecycle,
  type BrowserSession,
} from './browser.js';
import { browserNavigate, getActivePage, type HubPage } from './browser-tools.js';
import type { CdpSessionLike } from './browser-context-fetch-guard.js';

// ─── Types ───────────────────────────────────────────────────────

export const SCREENCAST_DEFAULT_MAX_WIDTH = 1280;
export const SCREENCAST_DEFAULT_MAX_HEIGHT = 800;
export const SCREENCAST_DEFAULT_QUALITY = 60;
export const SCREENCAST_MIN_DIMENSION = 160;
export const SCREENCAST_MAX_DIMENSION = 2560;

export type ScreencastStatus = 'waiting' | 'live' | 'closed';

export interface ScreencastState {
  status: ScreencastStatus;
  /** Current page URL when live, else null. */
  url: string | null;
  /** Chromium viewport (CSS px) when live. Input coordinates are in this space. */
  viewport: { width: number; height: number } | null;
}

export interface ScreencastFrame {
  /** Base64 JPEG. */
  data: string;
  /** Frame pixel size (may be downscaled from the viewport by maxWidth/maxHeight). */
  width: number;
  height: number;
  /** Viewport size the frame represents (CSS px) — input coordinate space. */
  viewportWidth: number;
  viewportHeight: number;
  url: string | null;
}

export interface ScreencastViewerOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

export interface ScreencastViewer extends ScreencastViewerOptions {
  id: string;
  onFrame: (frame: ScreencastFrame) => void;
  onState: (state: ScreencastState) => void;
}

export type ScreencastMouseButton = 'left' | 'right' | 'middle';

export type BrowserViewerInput =
  | {
      kind: 'mouse';
      type: 'move' | 'down' | 'up' | 'click';
      x: number;
      y: number;
      button?: ScreencastMouseButton;
      clickCount?: number;
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | {
      kind: 'key';
      type: 'press' | 'down' | 'up';
      key: string;
      modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean };
    }
  | { kind: 'text'; text: string };

export type BrowserViewerInputResult =
  | { ok: true }
  | {
      ok: false;
      code: 'no_browser' | 'agent_busy' | 'unsupported' | 'input_failed';
      message: string;
    };

export type BrowserViewerNavigateResult =
  | { ok: true; url: string }
  | { ok: false; code: 'no_browser' | 'agent_busy' | 'refused'; message: string };

// ─── Page shims ──────────────────────────────────────────────────

type ScreencastPage = HubPage & {
  viewportSize?: () => { width: number; height: number } | null;
  mouse?: {
    wheel: (x: number, y: number) => Promise<void>;
    move?: (x: number, y: number, opts?: { steps?: number }) => Promise<void>;
    down?: (opts?: { button?: ScreencastMouseButton; clickCount?: number }) => Promise<void>;
    up?: (opts?: { button?: ScreencastMouseButton; clickCount?: number }) => Promise<void>;
    click?: (
      x: number,
      y: number,
      opts?: { button?: ScreencastMouseButton; clickCount?: number },
    ) => Promise<void>;
  };
  keyboard?: {
    press?: (key: string) => Promise<void>;
    down?: (key: string) => Promise<void>;
    up?: (key: string) => Promise<void>;
    type?: (text: string) => Promise<void>;
    insertText?: (text: string) => Promise<void>;
  };
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function pageOf(session: BrowserSession): ScreencastPage | null {
  try {
    return getActivePage(session) as ScreencastPage;
  } catch {
    return null;
  }
}

function safeUrl(page: ScreencastPage | null): string | null {
  if (!page) return null;
  try {
    const u = page.url();
    return typeof u === 'string' ? u : null;
  } catch {
    return null;
  }
}

function viewportOf(page: ScreencastPage | null): { width: number; height: number } | null {
  if (!page || typeof page.viewportSize !== 'function') return null;
  try {
    const v = page.viewportSize();
    if (v && Number.isFinite(v.width) && Number.isFinite(v.height)) {
      return { width: v.width, height: v.height };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Open a CDP session on the page — Playwright context first, test-fake `mainSession` second. */
async function openCdpSession(session: BrowserSession): Promise<CdpSessionLike | null> {
  const page = pageOf(session);
  if (!page) return null;
  const ctx = asRecord(session.context);
  if (ctx && typeof ctx.newCDPSession === 'function') {
    try {
      return (await (ctx.newCDPSession as (p: unknown) => Promise<CdpSessionLike>)(page)) ?? null;
    } catch {
      /* fall through to the fake */
    }
  }
  const ms = (page as { mainSession?: CdpSessionLike }).mainSession;
  return ms ?? null;
}

function clampDim(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(SCREENCAST_MAX_DIMENSION, Math.max(SCREENCAST_MIN_DIMENSION, Math.round(v)));
}

function clampQuality(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(100, Math.max(10, Math.round(v)));
}

/** Playwright key name from a DOM `KeyboardEvent.key` + modifier flags. */
export function playwrightKeyFromDomKey(
  key: string,
  modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean },
): string | null {
  const k = key.trim();
  if (!k && key !== ' ') return null;
  const mods: string[] = [];
  if (modifiers?.ctrl) mods.push('Control');
  if (modifiers?.alt) mods.push('Alt');
  if (modifiers?.meta) mods.push('Meta');
  if (modifiers?.shift && key.length > 1) mods.push('Shift');
  const named = key === ' ' ? 'Space' : k;
  return mods.length ? `${mods.join('+')}+${named}` : named;
}

// ─── Feed ────────────────────────────────────────────────────────

type ScreencastFrameParams = {
  data: string;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
  sessionId: number;
};

class ScreencastFeed {
  readonly viewers = new Map<string, ScreencastViewer>();
  private cdp: CdpSessionLike | null = null;
  private frameHandler: ((params: unknown) => void) | null = null;
  private lastFrame: ScreencastFrame | null = null;
  private status: ScreencastStatus = 'waiting';
  private holdActive = false;
  private starting: Promise<void> | null = null;
  private unsubscribeLifecycle: (() => void) | null = null;
  private params = {
    maxWidth: SCREENCAST_DEFAULT_MAX_WIDTH,
    maxHeight: SCREENCAST_DEFAULT_MAX_HEIGHT,
    quality: SCREENCAST_DEFAULT_QUALITY,
  };

  constructor(readonly browserSessionId: string) {
    this.unsubscribeLifecycle = subscribeBrowserSessionLifecycle((ev) => {
      if (ev.id !== this.browserSessionId) return;
      if (ev.type === 'registered') void this.start();
      else this.onSessionClosed();
    });
  }

  get session(): BrowserSession | undefined {
    return getBrowserSession(this.browserSessionId);
  }

  currentState(): ScreencastState {
    const page = this.session ? pageOf(this.session) : null;
    return {
      status: this.status,
      url: this.status === 'live' ? safeUrl(page) : null,
      viewport: this.status === 'live' ? viewportOf(page) : null,
    };
  }

  /** How many op slots the feed itself holds (so input gating can subtract it). */
  get holdSlots(): number {
    return this.holdActive ? 1 : 0;
  }

  addViewer(viewer: ScreencastViewer): void {
    this.viewers.set(viewer.id, viewer);
    this.recomputeParams();
    if (!this.session) {
      this.status = 'waiting';
      viewer.onState(this.currentState());
      return;
    }
    if (this.status === 'live') {
      viewer.onState(this.currentState());
      if (this.lastFrame) viewer.onFrame(this.lastFrame);
      return;
    }
    void this.start();
  }

  removeViewer(viewerId: string): boolean {
    const had = this.viewers.delete(viewerId);
    if (this.viewers.size === 0) void this.dispose();
    else this.recomputeParams();
    return had;
  }

  /** Largest request wins so no viewer receives a frame smaller than it asked for. */
  private recomputeParams(): void {
    if (this.viewers.size === 0) return;
    let maxWidth = 0;
    let maxHeight = 0;
    let quality = 0;
    for (const v of this.viewers.values()) {
      maxWidth = Math.max(maxWidth, clampDim(v.maxWidth, SCREENCAST_DEFAULT_MAX_WIDTH));
      maxHeight = Math.max(maxHeight, clampDim(v.maxHeight, SCREENCAST_DEFAULT_MAX_HEIGHT));
      quality = Math.max(quality, clampQuality(v.quality, SCREENCAST_DEFAULT_QUALITY));
    }
    const changed =
      maxWidth !== this.params.maxWidth ||
      maxHeight !== this.params.maxHeight ||
      quality !== this.params.quality;
    this.params = { maxWidth, maxHeight, quality };
    if (changed && this.status === 'live') void this.restartScreencast();
  }

  private broadcastState(): void {
    const state = this.currentState();
    for (const v of Array.from(this.viewers.values())) {
      try {
        v.onState(state);
      } catch {
        /* viewer gone */
      }
    }
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startInner().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private screencastParams(): object {
    return {
      format: 'jpeg',
      quality: this.params.quality,
      maxWidth: this.params.maxWidth,
      maxHeight: this.params.maxHeight,
      everyNthFrame: 1,
    };
  }

  private async startInner(): Promise<void> {
    const session = this.session;
    if (!session || this.viewers.size === 0 || this.cdp) return;
    const cdp = await openCdpSession(session);
    // Session could have gone away while the CDP handshake ran.
    if (!this.session || this.viewers.size === 0) {
      void cdp?.detach?.().catch(() => {});
      return;
    }
    if (cdp) {
      this.cdp = cdp;
      this.frameHandler = (raw: unknown) => this.onFrame(raw as ScreencastFrameParams);
      cdp.on('Page.screencastFrame', this.frameHandler);
      try {
        await cdp.send('Page.startScreencast', this.screencastParams());
      } catch (err) {
        console.warn(`[browser-screencast] startScreencast failed: ${String(err)}`);
      }
    }
    // Without CDP (unit fake) we still report live so the URL bar / input
    // work; frames simply never arrive.
    this.status = 'live';
    this.acquireHold();
    this.broadcastState();
  }

  private async restartScreencast(): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    try {
      await cdp.send('Page.stopScreencast');
      await cdp.send('Page.startScreencast', this.screencastParams());
    } catch {
      /* Chromium may be mid-teardown */
    }
  }

  private onFrame(params: ScreencastFrameParams): void {
    const cdp = this.cdp;
    if (cdp && params && typeof params.sessionId === 'number') {
      void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }
    if (!params || typeof params.data !== 'string') return;
    const session = this.session;
    const page = session ? pageOf(session) : null;
    const vp = viewportOf(page);
    const frame: ScreencastFrame = {
      data: params.data,
      width: params.metadata?.deviceWidth ?? vp?.width ?? 0,
      height: params.metadata?.deviceHeight ?? vp?.height ?? 0,
      viewportWidth: vp?.width ?? params.metadata?.deviceWidth ?? 0,
      viewportHeight: vp?.height ?? params.metadata?.deviceHeight ?? 0,
      url: safeUrl(page),
    };
    this.lastFrame = frame;
    for (const v of Array.from(this.viewers.values())) {
      try {
        v.onFrame(frame);
      } catch {
        /* viewer gone */
      }
    }
  }

  private acquireHold(): void {
    if (this.holdActive) return;
    this.holdActive = true;
    incrementBrowserToolOpEntered(this.browserSessionId);
  }

  private releaseHold(): void {
    if (!this.holdActive) return;
    this.holdActive = false;
    notifyBrowserToolOpEnded(this.browserSessionId);
  }

  private onSessionClosed(): void {
    // The registry already dropped the op counter for this id; just forget the hold.
    this.holdActive = false;
    this.detachCdp();
    this.lastFrame = null;
    this.status = 'closed';
    this.broadcastState();
    // The agent may relaunch later in the same chat session; go back to
    // waiting so a still-open pane re-attaches automatically.
    this.status = 'waiting';
  }

  private detachCdp(): void {
    const cdp = this.cdp;
    if (!cdp) return;
    this.cdp = null;
    if (this.frameHandler) cdp.off('Page.screencastFrame', this.frameHandler);
    this.frameHandler = null;
    void cdp
      .send('Page.stopScreencast')
      .catch(() => {})
      .finally(() => cdp.detach?.().catch(() => {}));
  }

  async dispose(): Promise<void> {
    feeds.delete(this.browserSessionId);
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
    this.releaseHold();
    this.detachCdp();
    this.viewers.clear();
    this.lastFrame = null;
  }
}

const feeds = new Map<string, ScreencastFeed>();

/**
 * Attach a viewer to the live feed of `browserSessionId` (the chat session id
 * for the generic `browser` tool). Returns the detach function.
 */
export function attachBrowserScreencastViewer(
  browserSessionId: string,
  viewer: ScreencastViewer,
): () => void {
  let feed = feeds.get(browserSessionId);
  if (!feed) {
    feed = new ScreencastFeed(browserSessionId);
    feeds.set(browserSessionId, feed);
  }
  feed.addViewer(viewer);
  return () => {
    feeds.get(browserSessionId)?.removeViewer(viewer.id);
  };
}

/** Current feed state without attaching (for diagnostics / tests). */
export function getBrowserScreencastState(browserSessionId: string): ScreencastState {
  const feed = feeds.get(browserSessionId);
  if (feed) return feed.currentState();
  const session = getBrowserSession(browserSessionId);
  const page = session ? pageOf(session) : null;
  return session
    ? { status: 'live', url: safeUrl(page), viewport: viewportOf(page) }
    : { status: 'waiting', url: null, viewport: null };
}

// ─── Human input ─────────────────────────────────────────────────

const AGENT_BUSY_MESSAGE =
  'The agent is driving the browser right now — wait for its step to finish.';

/** True when a real agent step (not the feed's own keepalive hold) is in flight. */
export function isAgentDrivingBrowser(browserSessionId: string): boolean {
  const holdSlots = feeds.get(browserSessionId)?.holdSlots ?? 0;
  return browserToolOpsInFlight(browserSessionId) > holdSlots;
}

/** Forward a human viewer's mouse / keyboard input to the agent browser. */
export async function dispatchBrowserViewerInput(
  browserSessionId: string,
  input: BrowserViewerInput,
): Promise<BrowserViewerInputResult> {
  const session = getBrowserSession(browserSessionId);
  const page = session ? pageOf(session) : null;
  if (!session || !page) {
    return { ok: false, code: 'no_browser', message: 'The agent has not opened a browser yet.' };
  }
  if (isAgentDrivingBrowser(browserSessionId)) {
    return { ok: false, code: 'agent_busy', message: AGENT_BUSY_MESSAGE };
  }

  try {
    switch (input.kind) {
      case 'mouse': {
        const m = page.mouse;
        const button = input.button ?? 'left';
        if (!m) return { ok: false, code: 'unsupported', message: 'Mouse input is unavailable.' };
        if (input.type === 'move') {
          await m.move?.(input.x, input.y);
        } else if (input.type === 'down') {
          await m.move?.(input.x, input.y);
          await m.down?.({ button, clickCount: input.clickCount ?? 1 });
        } else if (input.type === 'up') {
          await m.up?.({ button, clickCount: input.clickCount ?? 1 });
        } else if (m.click) {
          await m.click(input.x, input.y, { button, clickCount: input.clickCount ?? 1 });
        } else {
          return { ok: false, code: 'unsupported', message: 'Mouse click is unavailable.' };
        }
        return { ok: true };
      }
      case 'wheel': {
        const m = page.mouse;
        if (!m?.wheel) return { ok: false, code: 'unsupported', message: 'Scroll is unavailable.' };
        await m.move?.(input.x, input.y);
        await m.wheel(input.deltaX, input.deltaY);
        return { ok: true };
      }
      case 'key': {
        const kb = page.keyboard;
        if (!kb) return { ok: false, code: 'unsupported', message: 'Keyboard is unavailable.' };
        const key = playwrightKeyFromDomKey(input.key, input.modifiers);
        if (!key) return { ok: false, code: 'input_failed', message: 'Empty key.' };
        const plainPrintable =
          input.key.length === 1 &&
          !input.modifiers?.ctrl &&
          !input.modifiers?.meta &&
          !input.modifiers?.alt;
        if (input.type === 'press') {
          if (plainPrintable && kb.type) await kb.type(input.key);
          else if (kb.press) await kb.press(key);
          else return { ok: false, code: 'unsupported', message: 'Key press is unavailable.' };
        } else if (input.type === 'down') {
          await kb.down?.(key);
        } else {
          await kb.up?.(key);
        }
        return { ok: true };
      }
      case 'text': {
        const kb = page.keyboard;
        if (!kb) return { ok: false, code: 'unsupported', message: 'Keyboard is unavailable.' };
        if (kb.insertText) await kb.insertText(input.text);
        else if (kb.type) await kb.type(input.text);
        else return { ok: false, code: 'unsupported', message: 'Text input is unavailable.' };
        return { ok: true };
      }
      default: {
        const _exhaustive: never = input;
        void _exhaustive;
        return { ok: false, code: 'unsupported', message: 'Unknown input.' };
      }
    }
  } catch (err) {
    return {
      ok: false,
      code: 'input_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Human URL-bar navigation. Runs the exact same policy as the agent's
 * `navigate` op — loopback / private / metadata targets are refused with the
 * same message the agent would see.
 */
export async function navigateBrowserViewer(
  browserSessionId: string,
  url: string,
): Promise<BrowserViewerNavigateResult> {
  const session = getBrowserSession(browserSessionId);
  if (!session) {
    return { ok: false, code: 'no_browser', message: 'The agent has not opened a browser yet.' };
  }
  if (isAgentDrivingBrowser(browserSessionId)) {
    return { ok: false, code: 'agent_busy', message: AGENT_BUSY_MESSAGE };
  }
  const r = await browserNavigate(session, url, session.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!r.ok) return { ok: false, code: 'refused', message: r.error ?? 'Navigation failed' };
  const landed = (r.data as { url?: string } | undefined)?.url ?? url;
  return { ok: true, url: landed };
}

/** Test-only: drop every feed without touching Chromium. */
export async function __resetBrowserScreencastForTests(): Promise<void> {
  const all = Array.from(feeds.values());
  feeds.clear();
  await Promise.allSettled(all.map((f) => f.dispose()));
}
