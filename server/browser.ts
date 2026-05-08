/**
 * browser.ts — Shared Stagehand/Playwright browser plumbing.
 *
 * This module centralizes the configuration and lifecycle management for the
 * Stagehand-wrapped Playwright browser instances agents use during chat
 * sessions. It purposefully does not expose raw Playwright types to the rest
 * of the server; higher-level tools live in `browser-tools.ts` and interact
 * with a session through the `BrowserSession` handle returned from
 * `launchBrowserSession()`.
 *
 * Design notes:
 *   • Each call to `launchBrowserSession()` spins up a dedicated Stagehand
 *     (and thus a dedicated Chromium context). That gives every agent
 *     session cookie/storage isolation — two agents acting on the same URL
 *     cannot see each other's auth state.
 *   • All launches share a single defaults object (`DEFAULT_STAGEHAND_OPTIONS`)
 *     tuned for headless operation on our EC2 Linux hosts. Callers may
 *     override any field via the `BrowserSessionOptions` argument.
 *   • A module-level `sessions` registry tracks live sessions so that a
 *     graceful process shutdown (or an ad-hoc admin endpoint) can close all
 *     of them in one call.
 *   • The heavy `@browserbasehq/stagehand` import is deferred to the first
 *     launch so `import './browser.js'` stays cheap at module-load time
 *     (unit tests and the API bootstrap do not need to pay for it).
 */

import { randomUUID } from 'crypto';

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
   * Optional LLM model name passed through to Stagehand for act()/extract().
   * If omitted, agents can still drive raw Playwright via `session.stagehand.context`
   * but natural-language methods will error at call-time.
   */
  model?: string;
  /** Optional stable session id — useful when the caller already owns one (agent session id). */
  id?: string;
}

/**
 * A live browser session handle.
 *
 * `stagehand` is typed as `unknown` in the public surface because the
 * concrete `Stagehand` type pulls the entire dependency graph into every
 * consumer's type-checking. Call sites that need to talk to Stagehand can
 * narrow via `import type { Stagehand } from '@browserbasehq/stagehand'`.
 */
export interface BrowserSession {
  id: string;
  stagehand: unknown;
  createdAt: number;
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
 * Stagehand falls back to chrome-launcher's system Chrome discovery.
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

/** Minimal shape we rely on from the Stagehand constructor at runtime. */
interface StagehandLike {
  init: () => Promise<void>;
  close: (opts?: { force?: boolean }) => Promise<void>;
}

// Lazily imported so module load stays cheap.
let _stagehandCtor: (new (opts: unknown) => StagehandLike) | null = null;
async function loadStagehand(): Promise<new (opts: unknown) => StagehandLike> {
  if (_stagehandCtor) return _stagehandCtor;
  const mod = (await import('@browserbasehq/stagehand')) as {
    Stagehand: new (opts: unknown) => StagehandLike;
  };
  _stagehandCtor = mod.Stagehand;
  return _stagehandCtor;
}

/** Test-only: clear lazy Stagehand constructor cache after `vi.mock('@browserbasehq/stagehand')`. */
export function __resetStagehandLoaderForTests(): void {
  _stagehandCtor = null;
}

/**
 * Launch an isolated browser session. Each call creates a fresh Stagehand
 * (and therefore a fresh Chromium context) so sessions do not share
 * cookies, local storage, or service-worker caches.
 *
 * When `opts.id` is set, concurrent calls with the same id share one launch
 * (singleflight) and reuse an existing registered session if present.
 * Unpinned launches always create a new browser.
 *
 * Throws if Chromium is not installed or Stagehand fails to connect.
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
  const Stagehand = await loadStagehand();
  // If the caller didn't pin an executablePath, default to Playwright's
  // managed Chromium. This avoids Stagehand's chrome-launcher falling back
  // to system-level Chrome (which isn't installed on our EC2 host).
  const effectiveOpts: BrowserSessionOptions = { ...opts };
  if (!effectiveOpts.executablePath) {
    effectiveOpts.executablePath = await resolveDefaultChromiumPath();
  }
  const sh = new Stagehand(buildStagehandOptions(effectiveOpts));
  await sh.init();

  const id = opts.id ?? randomUUID();
  const session: BrowserSession = {
    id,
    stagehand: sh,
    createdAt: Date.now(),
    close: async () => {
      sessions.delete(id);
      try {
        await sh.close();
      } catch (err) {
        // Cleanup is best-effort; the underlying process may have already exited.
        console.warn(`[browser] Failed to close session ${id}: ${String(err)}`);
      }
    },
  };
  sessions.set(id, session);
  return session;
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
  const snapshot = Array.from(sessions.values());
  sessions.clear();
  await Promise.allSettled(
    snapshot.map(async (s) => {
      try {
        const sh = s.stagehand as StagehandLike;
        await sh.close();
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
}

/**
 * Register a pre-built session object into the registry. Test-only hook
 * that lets us exercise getBrowserSession / listBrowserSessions /
 * closeBrowserSession without spinning up real Chromium.
 */
export function __registerBrowserSessionForTests(session: BrowserSession): void {
  sessions.set(session.id, session);
}
