/**
 * browser.ts — Shared Playwright browser plumbing.
 *
 * This module centralizes Chromium lifecycle for agent chat sessions. Higher-level
 * tools live in `browser-tools.ts` and drive a session through the
 * `BrowserSession` handle returned from `launchBrowserSession()`.
 *
 * Design notes:
 *   • Each call to `launchBrowserSession()` spins up a dedicated Playwright
 *     Chromium + BrowserContext. That gives every agent session cookie/storage
 *     isolation — two agents acting on the same URL cannot see each other's
 *     auth state.
 *   • Navigate / screenshot / selector click use Playwright. Natural-language
 *     `act` / `extract` may still talk to Stagehand when a test fake (or a
 *     future attach) provides `session.stagehand`.
 *   • A module-level `sessions` registry tracks live sessions so that a
 *     graceful process shutdown can close all of them in one call.
 *   • Global concurrency, idle auto-close, the single CDP Fetch guard (ad /
 *     tracker blocking + document URL policy), the download listener, and
 *     operator audit lines are configured via `AppConfig`
 *     (`browserMaxConcurrentContexts`, `browserIdleTimeoutMs`, …).
 *   • The `playwright` import is deferred to the first launch so
 *     `import './browser.js'` stays cheap at module-load time.
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import {
  browserAllowDownloadsFromConfig,
  browserBlockAdsTrackersFromConfig,
  getBrowserIdleTimeoutMs,
  getBrowserMaxConcurrentContexts,
} from './browser-host-policy.js';
import { installBrowserSessionHardening } from './browser-session-hardening.js';
import { installContextFetchGuard, type CdpSessionLike } from './browser-context-fetch-guard.js';

// ─── Public defaults ────────────────────────────────────────────

/** Sensible default viewport for AI-agent browsing — roughly a laptop. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/** Default per-operation timeout applied to navigation, act(), extract(). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Chromium flags required for reliable headless operation on the EC2 Linux
 * hosts. `--no-sandbox` is mandatory because the agenthub user does not have
 * the CAP_SYS_ADMIN capability needed for Chromium's sandbox. The remaining
 * flags avoid /dev/shm size limits and GPU probes that have no effect on a
 * headless server.
 */
export const DEFAULT_CHROMIUM_ARGS: readonly string[] = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
]);

// ─── Types ──────────────────────────────────────────────────────

export interface BrowserSessionOptions {
  /** Run without a visible window. Defaults to `true`. */
  headless?: boolean;
  /** Viewport dimensions. Defaults to {@link DEFAULT_VIEWPORT}. */
  viewport?: { width: number; height: number };
  /** Per-operation timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Chromium CLI args. Overrides — does NOT extend — {@link DEFAULT_CHROMIUM_ARGS}. */
  args?: readonly string[];
  /**
   * Path to the Chromium/Chrome executable. When omitted we fall back to the
   * Chromium binary managed by the `playwright` npm package (installed via
   * `npx playwright install chromium`). This keeps us self-contained and
   * avoids requiring a system-level `google-chrome` install on hosts like
   * our EC2 box.
   */
  executablePath?: string;
  /**
   * Optional LLM model name for Stagehand act()/extract() when a Stagehand
   * instance is attached to the session. Navigate / screenshot do not use it.
   */
  model?: string;
  /** Optional stable session id — useful when the caller already owns one (agent session id). */
  id?: string;
}

/**
 * A live browser session handle.
 *
 * `page` / `context` are Playwright objects in production (typed `unknown` so
 * this module does not pull Playwright types into every consumer). Test fakes
 * may omit them and provide `stagehand` with `context.activePage()` instead.
 */
export interface BrowserSession {
  id: string;
  /** Playwright Page (production). */
  page?: unknown;
  /** Playwright BrowserContext (production) — hardening + CDP. */
  context?: unknown;
  /**
   * Optional Stagehand instance for natural-language act/extract fallback.
   * Production launches do not attach one; unit tests still register fakes.
   */
  stagehand?: unknown;
  createdAt: number;
  /** Per-op timeout used for navigation waits (see {@link BrowserSessionOptions.timeoutMs}). */
  timeoutMs: number;
  close: () => Promise<void>;
}

// ─── Shared defaults object ─────────────────────────────────────

/**
 * The canonical default options passed to `new Stagehand(...)`. Exported so
 * tests can assert on them and so higher-level modules (audit logs, UI)
 * can surface the active configuration.
 */
export const DEFAULT_STAGEHAND_OPTIONS = Object.freeze({
  env: 'LOCAL' as const,
  verbose: 0 as const,
  localBrowserLaunchOptions: Object.freeze({
    headless: true,
    viewport: DEFAULT_VIEWPORT,
    args: DEFAULT_CHROMIUM_ARGS,
    chromiumSandbox: false,
    // `connectTimeoutMs` covers the CDP handshake; per-action timeouts are
    // applied separately via `actTimeoutMs` and `domSettleTimeout`.
    connectTimeoutMs: DEFAULT_TIMEOUT_MS,
  }),
  actTimeoutMs: DEFAULT_TIMEOUT_MS,
  domSettleTimeout: DEFAULT_TIMEOUT_MS,
});

// ─── Options builder (pure / test-friendly) ─────────────────────

type StagehandOptions = {
  env: 'LOCAL';
  verbose: 0 | 1 | 2;
  localBrowserLaunchOptions: {
    headless: boolean;
    viewport: { width: number; height: number };
    args: string[];
    chromiumSandbox: boolean;
    connectTimeoutMs: number;
    executablePath?: string;
  };
  actTimeoutMs: number;
  domSettleTimeout: number;
  model?: string;
};

/**
 * Resolve a default Chromium executable path by asking the `playwright`
 * package where it installed its managed binary. Isolated as a function so
 * unit tests can stub it out without importing the full Playwright runtime.
 *
 * Returns `undefined` if Playwright cannot resolve a path — in that case
 * launch fails rather than probing system Chrome.
 */
export async function resolveDefaultChromiumPath(): Promise<string | undefined> {
  try {
    const pw = (await import('playwright')) as {
      chromium: { executablePath: () => string };
    };
    return pw.chromium.executablePath();
  } catch {
    return undefined;
  }
}

/**
 * Build a one-line, human-readable diagnostic describing how Chromium will be
 * located for a launch. Surfaced in the error message (and a server log) when
 * Chromium launch fails, so a bare `ECONNREFUSED` / spawn error becomes
 * actionable: it tells you the resolved executable path, whether that path
 * actually exists on disk, and the value of `PLAYWRIGHT_BROWSERS_PATH` (the env
 * that pins the browser location across image build vs. runtime).
 *
 * Pure and side-effect-free apart from a single `existsSync` stat, so it is
 * cheap to call on the error path and trivial to unit-test.
 */
export function describeChromiumLaunchEnv(executablePath: string | undefined): string {
  const browsersPath =
    process.env.PLAYWRIGHT_BROWSERS_PATH || '(unset → defaults to ~/.cache/ms-playwright)';
  let execNote: string;
  if (!executablePath) {
    execNote = 'executablePath=(unresolved — Playwright Chromium is not installed)';
  } else {
    const exists = existsSync(executablePath) ? 'exists' : 'MISSING ON DISK';
    execNote = `executablePath=${executablePath} [${exists}]`;
  }
  return `PLAYWRIGHT_BROWSERS_PATH=${browsersPath}; ${execNote}`;
}

/**
 * Merge caller overrides onto {@link DEFAULT_STAGEHAND_OPTIONS} and return
 * a plain (non-frozen, mutation-safe) object suitable for handing to the
 * Stagehand constructor.
 *
 * This is exported separately from `launchBrowserSession` so unit tests
 * can assert merge behavior without spinning up Chromium.
 */
export function buildStagehandOptions(opts: BrowserSessionOptions = {}): StagehandOptions {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result: StagehandOptions = {
    env: 'LOCAL',
    verbose: 0,
    localBrowserLaunchOptions: {
      headless: opts.headless ?? DEFAULT_STAGEHAND_OPTIONS.localBrowserLaunchOptions.headless,
      viewport: opts.viewport ?? DEFAULT_VIEWPORT,
      args: [...(opts.args ?? DEFAULT_CHROMIUM_ARGS)],
      chromiumSandbox: false,
      connectTimeoutMs: timeout,
    },
    actTimeoutMs: timeout,
    domSettleTimeout: timeout,
  };
  if (opts.executablePath) result.localBrowserLaunchOptions.executablePath = opts.executablePath;
  if (opts.model) result.model = opts.model;
  return result;
}

// ─── Session registry ───────────────────────────────────────────

const sessions = new Map<string, BrowserSession>();
/** In-flight {@link launchBrowserSession} for pinned ids — prevents duplicate Chromium for concurrent callers. */
const launchInFlight = new Map<string, Promise<BrowserSession>>();
/** In-flight launches reserved against the cap (incremented before the gate; includes init before {@link sessions} insert). */
let pendingBrowserConstruction = 0;
/** Auto-close timers — one per live {@link BrowserSession} id. */
const idleCloseTimerBySessionId = new Map<string, NodeJS.Timeout>();
/** In-flight host browser (`runBrowserReActStep`) nesting — idle close defers until zero. */
const activeBrowserToolOpsBySessionId = new Map<string, number>();

// ─── Lifecycle listeners ────────────────────────────────────────

export type BrowserSessionLifecycleEvent =
  | { type: 'registered'; id: string; session: BrowserSession }
  | { type: 'closed'; id: string };

const lifecycleListeners = new Set<(ev: BrowserSessionLifecycleEvent) => void>();

/**
 * Observe browser sessions entering / leaving the registry. Used by the live
 * screencast feed so a viewer pane opened before the agent's first `browser`
 * action attaches the moment Chromium comes up, and drops cleanly when the
 * session closes (idle timeout, explicit `close` op, shutdown).
 */
export function subscribeBrowserSessionLifecycle(
  listener: (ev: BrowserSessionLifecycleEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

function emitBrowserSessionLifecycle(ev: BrowserSessionLifecycleEvent): void {
  for (const l of Array.from(lifecycleListeners)) {
    try {
      l(ev);
    } catch (err) {
      console.warn(`[browser] lifecycle listener failed: ${String(err)}`);
    }
  }
}

/** Number of in-flight agent `browser` steps against `id` (0 when idle or unknown). */
export function browserToolOpsInFlight(id: string): number {
  return activeBrowserToolOpsBySessionId.get(id) ?? 0;
}

function clearBrowserIdleTimer(id: string): void {
  const t = idleCloseTimerBySessionId.get(id);
  if (t) clearTimeout(t);
  idleCloseTimerBySessionId.delete(id);
}

function scheduleBrowserIdleClose(id: string): void {
  clearBrowserIdleTimer(id);
  const ms = getBrowserIdleTimeoutMs();
  const t = setTimeout(() => {
    idleCloseTimerBySessionId.delete(id);
    if ((activeBrowserToolOpsBySessionId.get(id) ?? 0) > 0) {
      scheduleBrowserIdleClose(id);
      return;
    }
    void closeBrowserSession(id).catch(() => {});
  }, ms);
  idleCloseTimerBySessionId.set(id, t);
}

/**
 * Mark the beginning of `runBrowserReActStep`; pairs with {@link notifyBrowserToolOpEnded}.
 */
export function incrementBrowserToolOpEntered(chatSessionId: string): void {
  activeBrowserToolOpsBySessionId.set(
    chatSessionId,
    (activeBrowserToolOpsBySessionId.get(chatSessionId) ?? 0) + 1,
  );
}

/** Mark the end of `runBrowserReActStep` and restart the idle countdown from completion. */
export function notifyBrowserToolOpEnded(chatSessionId: string): void {
  const prior = activeBrowserToolOpsBySessionId.get(chatSessionId) ?? 0;
  const n = Math.max(0, prior - 1);
  if (n <= 0) activeBrowserToolOpsBySessionId.delete(chatSessionId);
  else activeBrowserToolOpsBySessionId.set(chatSessionId, n);
  bumpBrowserSessionActivity(chatSessionId);
}

/**
 * Restart the idle auto-close countdown (`browserIdleTimeoutMs`) starting **now**.
 * Idle teardown is deferred while any {@link incrementBrowserToolOpEntered} pairing is pending.
 *
 * Typical callers: notifyBrowserToolOpEnded (browser-tools after each completed step).
 */
export function bumpBrowserSessionActivity(id: string): void {
  if (!sessions.has(id)) return;
  scheduleBrowserIdleClose(id);
}

type PlaywrightPage = {
  setDefaultTimeout?: (ms: number) => void;
  setDefaultNavigationTimeout?: (ms: number) => void;
  close?: () => Promise<void>;
};

type PlaywrightContext = {
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  route?: (pattern: string, handler: (...args: unknown[]) => unknown) => Promise<unknown>;
  newCDPSession?: (page: PlaywrightPage) => Promise<CdpSessionLike>;
};

type PlaywrightBrowser = {
  newContext: (opts?: {
    viewport?: { width: number; height: number };
  }) => Promise<PlaywrightContext>;
  close: () => Promise<void>;
};

type PlaywrightChromium = {
  executablePath: () => string;
  launch: (opts: {
    headless?: boolean;
    executablePath?: string;
    args?: string[];
  }) => Promise<PlaywrightBrowser>;
};

async function loadPlaywrightChromium(): Promise<PlaywrightChromium> {
  const pw = (await import('playwright')) as unknown as { chromium: PlaywrightChromium };
  return pw.chromium;
}

/** Test-only: leftover from the Stagehand launcher — kept so older tests still import it. */
export function __resetStagehandLoaderForTests(): void {
  /* Playwright launch has no constructor cache. */
}

/**
 * Capacity gate evaluated **after** this launch has reserved a slot (`pendingBrowserConstruction++`),
 * eliminating a TOCTOU where parallel callers observed `pending === 0` before any reservation.
 *
 * Exported for invariant tests in `browser-launch-capacity-gate.test.ts`.
 */
export function exceedsBrowserConcurrencyAfterReservation(
  liveSessionsCount: number,
  pendingIncludingThisReservation: number,
  maxContexts: number,
): boolean {
  return liveSessionsCount + pendingIncludingThisReservation > maxContexts;
}

/**
 * Launch an isolated browser session. Each call creates a fresh Playwright
 * Chromium + BrowserContext so sessions do not share cookies, local storage,
 * or service-worker caches.
 *
 * When `opts.id` is set, concurrent calls with the same id share one launch
 * (singleflight) and reuse an existing registered session if present.
 * Unpinned launches always create a new browser.
 *
 * Throws if Chromium is not installed or Playwright fails to launch.
 */
export async function launchBrowserSession(
  opts: BrowserSessionOptions = {},
): Promise<BrowserSession> {
  const pinnedId = opts.id;
  if (pinnedId) {
    const hit = sessions.get(pinnedId);
    if (hit) return hit;
    let inflight = launchInFlight.get(pinnedId);
    if (!inflight) {
      inflight = performLaunchBrowserSession(opts).finally(() => {
        launchInFlight.delete(pinnedId);
      });
      launchInFlight.set(pinnedId, inflight);
    }
    return inflight;
  }
  return performLaunchBrowserSession(opts);
}

async function performLaunchBrowserSession(opts: BrowserSessionOptions): Promise<BrowserSession> {
  const maxContexts = getBrowserMaxConcurrentContexts();
  pendingBrowserConstruction++;
  try {
    if (
      exceedsBrowserConcurrencyAfterReservation(
        sessions.size,
        pendingBrowserConstruction,
        maxContexts,
      )
    ) {
      throw new Error(
        `Host browser capacity reached (${maxContexts} concurrent contexts). Close an idle browser session or retry later.`,
      );
    }
    const chromium = await loadPlaywrightChromium();
    const effectiveOpts: BrowserSessionOptions = { ...opts };
    if (!effectiveOpts.executablePath) {
      effectiveOpts.executablePath = await resolveDefaultChromiumPath();
    }
    const timeoutMs = effectiveOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const launchDiag = describeChromiumLaunchEnv(effectiveOpts.executablePath);
    let browser: PlaywrightBrowser | undefined;
    let context: PlaywrightContext | undefined;
    let page: PlaywrightPage | undefined;
    try {
      browser = await chromium.launch({
        headless:
          effectiveOpts.headless ?? DEFAULT_STAGEHAND_OPTIONS.localBrowserLaunchOptions.headless,
        executablePath: effectiveOpts.executablePath,
        args: [...(effectiveOpts.args ?? DEFAULT_CHROMIUM_ARGS)],
      });
      context = await browser.newContext({
        viewport: effectiveOpts.viewport ?? DEFAULT_VIEWPORT,
      });
      try {
        await installBrowserSessionHardening(context, {
          allowDownloads: browserAllowDownloadsFromConfig(),
        });
      } catch (hardErr) {
        console.warn(`[browser] Session hardening (downloads) failed: ${String(hardErr)}`);
      }
      page = await context.newPage();
      page.setDefaultTimeout?.(timeoutMs);
      page.setDefaultNavigationTimeout?.(timeoutMs);
      // The single CDP Fetch owner for this context: ad/tracker blocking plus
      // the mutable main-frame document URL policy that navigate-time and
      // preview-origin-pin callers install into it. Installed only when ad
      // blocking is on — otherwise navigate-time callers open a short-lived CDP
      // session per goto, so there is still never a second Fetch client.
      if (browserBlockAdsTrackersFromConfig() && typeof context.newCDPSession === 'function') {
        try {
          const cdp = await context.newCDPSession(page);
          await installContextFetchGuard(context, cdp, { blockAdsTrackers: true });
        } catch (guardErr) {
          console.warn(
            `[browser] Context Fetch guard (ad-block + document policy) failed: ${String(guardErr)}`,
          );
        }
      }
    } catch (initErr) {
      const msg = initErr instanceof Error ? initErr.message : String(initErr);
      try {
        await page?.close?.();
      } catch {
        /* already dead */
      }
      try {
        await context?.close();
      } catch {
        /* already dead */
      }
      try {
        await browser?.close();
      } catch {
        /* already dead */
      }
      console.warn(`[browser] Playwright launch failed: ${msg} — ${launchDiag}`);
      throw new Error(`Chromium launch failed: ${msg}. ${launchDiag}`);
    }
    if (!browser || !context || !page) {
      throw new Error(`Chromium launch failed: incomplete Playwright session. ${launchDiag}`);
    }
    const launchedBrowser = browser;
    const launchedContext = context;
    const launchedPage = page;

    const id = opts.id ?? randomUUID();
    const session: BrowserSession = {
      id,
      page: launchedPage,
      context: launchedContext,
      createdAt: Date.now(),
      timeoutMs,
      close: async () => {
        clearBrowserIdleTimer(id);
        activeBrowserToolOpsBySessionId.delete(id);
        const wasRegistered = sessions.delete(id);
        if (wasRegistered) emitBrowserSessionLifecycle({ type: 'closed', id });
        try {
          await launchedPage.close?.();
        } catch {
          /* already dead */
        }
        try {
          await launchedContext.close();
        } catch (err) {
          console.warn(`[browser] Failed to close context ${id}: ${String(err)}`);
        }
        try {
          await launchedBrowser.close();
        } catch (err) {
          console.warn(`[browser] Failed to close session ${id}: ${String(err)}`);
        }
      },
    };
    sessions.set(id, session);
    scheduleBrowserIdleClose(id);
    emitBrowserSessionLifecycle({ type: 'registered', id, session });
    return session;
  } finally {
    pendingBrowserConstruction--;
  }
}

/** Lookup a previously-launched session by id. */
export function getBrowserSession(id: string): BrowserSession | undefined {
  return sessions.get(id);
}

/** Snapshot of currently live sessions (useful for diagnostics). */
export function listBrowserSessions(): BrowserSession[] {
  return Array.from(sessions.values());
}

/**
 * Close a specific session.
 * @returns `true` if a matching session was closed, `false` if no session
 *          with that id was registered.
 */
export async function closeBrowserSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  clearBrowserIdleTimer(id);
  await session.close();
  return true;
}

/**
 * Close every live session. Safe to call during graceful shutdown — any
 * individual close failure is logged and ignored so one wedged session
 * cannot block the others from being torn down.
 */
export async function closeAllBrowserSessions(): Promise<void> {
  const pending = Array.from(launchInFlight.values());
  launchInFlight.clear();
  await Promise.allSettled(pending);
  for (const t of idleCloseTimerBySessionId.values()) clearTimeout(t);
  idleCloseTimerBySessionId.clear();
  const snapshot = Array.from(sessions.values());
  sessions.clear();
  for (const s of snapshot) emitBrowserSessionLifecycle({ type: 'closed', id: s.id });
  pendingBrowserConstruction = 0;
  activeBrowserToolOpsBySessionId.clear();
  await Promise.allSettled(
    snapshot.map(async (s) => {
      try {
        await s.close();
      } catch (err) {
        console.warn(`[browser] Failed to close session ${s.id}: ${String(err)}`);
      }
    }),
  );
}

// ─── Test-only reset hook ───────────────────────────────────────

/**
 * Clear the internal session registry without closing sessions. Exposed
 * only for unit tests that register fake sessions — production code should
 * use {@link closeAllBrowserSessions}.
 */
export function __resetBrowserRegistryForTests(): void {
  sessions.clear();
  launchInFlight.clear();
  pendingBrowserConstruction = 0;
  activeBrowserToolOpsBySessionId.clear();
  for (const t of idleCloseTimerBySessionId.values()) clearTimeout(t);
  idleCloseTimerBySessionId.clear();
}

/**
 * Drop a registry entry without closing Chromium (for fake sessions from
 * {@link __registerBrowserSessionForTests}).
 */
export function __unregisterBrowserSessionForTests(id: string): void {
  clearBrowserIdleTimer(id);
  activeBrowserToolOpsBySessionId.delete(id);
  if (sessions.delete(id)) emitBrowserSessionLifecycle({ type: 'closed', id });
}

/**
 * Register a pre-built session object into the registry. Test-only hook
 * that lets us exercise getBrowserSession / listBrowserSessions /
 * closeBrowserSession without spinning up real Chromium.
 */
export function __registerBrowserSessionForTests(session: BrowserSession): void {
  sessions.set(session.id, session);
  emitBrowserSessionLifecycle({ type: 'registered', id: session.id, session });
}
