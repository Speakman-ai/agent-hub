/**
 * preview-test.ts — One-shot preview validator for Settings → Preview.
 *
 * The Preview settings panel exposes a "Test preview" button. This module
 * runs the configured `startScript` + `healthPath` against the project's
 * **`cwd`** (not a worktree, no session) for the sole purpose of telling
 * the user whether their saved config actually boots a dev server.
 *
 * Lifecycle (all owned here — fully self-contained):
 *
 *   1. Validate `project.prEnv.preview.enabled` and `project.cwd`.
 *   2. Allocate a host port in the configured range using a transient
 *      `net.createServer().listen(p)` probe — we don't touch the
 *      `worktree_previews` table because this run is not a session.
 *   3. `spawn('sh', ['-c', startScript])` with `PORT=<port>` inside
 *      `project.cwd/client` (matching `DEFAULT_PREVIEW_CWD` in
 *      `preview-runtime.ts`), in its own process group (`detached: true`).
 *   4. Poll `http://localhost:<port><healthPath>` every 500 ms for a 2xx
 *      response. Default deadline 30 s (mirrors `PreviewRuntime`).
 *   5. On the first 2xx, screenshot the root URL via Playwright into
 *      `uploads/preview-tests/<id>.png` and return its public URL.
 *   6. **Always** teardown the spawned process group (SIGTERM, then
 *      SIGKILL after 3 s) in a `finally` so a partially-failed test
 *      never leaks a process.
 *
 * Return shape:
 *
 *   { ok: boolean, ports: { allocated: number | null },
 *     durationMs: number, screenshotUrl?: string, error?: string }
 *
 * Errors are surfaced verbatim — the panel renders them inline so the
 * user can fix the misconfiguration (spawn ENOENT, port allocation
 * exhausted, health timeout, non-2xx status).
 *
 * All IO is injectable so unit tests run fast and don't shell out to a
 * real dev server: `spawn`, `fetch`, `clock`, `captureScreenshot`,
 * `allocatePort`, `kill` are constructor seams. Production wiring lives
 * at the bottom of this file.
 */

import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn as nodeSpawn } from 'child_process';
import { createServer as createNetServer } from 'net';
import { mkdirSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DEFAULT_PREVIEW_PORT_RANGE } from './preview-schema.js';
import type { Project } from '../types.js';

// ─── Public types ──────────────────────────────────────────────────

export interface PreviewTestResult {
  ok: boolean;
  ports: { allocated: number | null };
  durationMs: number;
  screenshotUrl?: string;
  error?: string;
}

export type PreviewTestSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type PreviewTestHealthFetchFn = (url: string) => Promise<{ ok: boolean; status: number }>;

export interface PreviewTestClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export interface PreviewTestDeps {
  /** Project under test. Reads `cwd`, `prEnv.preview.{enabled,startScript}` and `prEnv.healthPath`. */
  project: Project;
  /** Absolute path to the `uploads/` static root (e.g. `<serverDir>/uploads`). */
  uploadsDir: string;
  /** Optional public URL — when set, the returned `screenshotUrl` is absolute. */
  publicUrl?: string | null;
  /** Override the spawn seam. Defaults to Node's `child_process.spawn`. */
  spawn?: PreviewTestSpawnFn;
  /** Override the health-check seam. Defaults to a `fetch` wrapper. */
  fetch?: PreviewTestHealthFetchFn;
  /** Override the clock seam (`nowMs` + `sleep`). Defaults to real time. */
  clock?: PreviewTestClock;
  /**
   * Override the screenshot seam. Production wires this to a Playwright
   * helper that writes a single PNG; tests inject a no-op recorder.
   */
  captureScreenshot?: (url: string, outPath: string) => Promise<void>;
  /**
   * Override the port allocator seam. Production probes with
   * `net.createServer().listen(p)`; tests pass a synchronous fake.
   */
  allocatePort?: (min: number, max: number) => Promise<number>;
  /** Override the kill seam — production uses `process.kill`. */
  kill?: (target: number, signal: NodeJS.Signals) => void;
  /** Override the timeout in ms. Defaults to 30s (matches `PreviewRuntime`). */
  healthTimeoutMs?: number;
  /** Override the polling cadence. Defaults to 500ms. */
  healthIntervalMs?: number;
}

// ─── Defaults ──────────────────────────────────────────────────────

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 500;
/** `<cwd>/client` matches `DEFAULT_PREVIEW_CWD` in preview-runtime.ts. */
const DEFAULT_PREVIEW_CWD = 'client';
const DEFAULT_START_SCRIPT = 'npm run dev';
const SIGKILL_GRACE_MS = 3_000;

// ─── Entry point ───────────────────────────────────────────────────

/**
 * Run a one-shot preview test. Always resolves — failures are reported
 * via `result.ok=false, result.error`. The caller can render the result
 * inline without try/catching.
 */
export async function runPreviewTest(deps: PreviewTestDeps): Promise<PreviewTestResult> {
  const clock: PreviewTestClock = deps.clock ?? {
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const start = clock.nowMs();
  const ports: { allocated: number | null } = { allocated: null };

  const previewCfg = deps.project.prEnv?.preview;
  if (!previewCfg?.enabled) {
    return {
      ok: false,
      ports,
      durationMs: clock.nowMs() - start,
      error: 'Preview is not enabled in project settings — save the config with enable on first.',
    };
  }
  const cwd = deps.project.cwd;
  if (!cwd || typeof cwd !== 'string') {
    return {
      ok: false,
      ports,
      durationMs: clock.nowMs() - start,
      error: 'Project has no cwd configured.',
    };
  }

  const startScript = (
    previewCfg.startScript ??
    deps.project.prEnv?.startScript ??
    DEFAULT_START_SCRIPT
  ).trim();
  const healthPath = ((deps.project.prEnv?.healthPath ?? '/').trim() || '/').replace(
    /^([^/])/,
    '/$1',
  );

  const allocate = deps.allocatePort ?? defaultAllocatePort;
  let port: number;
  try {
    port = await allocate(DEFAULT_PREVIEW_PORT_RANGE.min, DEFAULT_PREVIEW_PORT_RANGE.max);
  } catch (err) {
    return {
      ok: false,
      ports,
      durationMs: clock.nowMs() - start,
      error: `Port allocation failed: ${errorMessage(err)}`,
    };
  }
  ports.allocated = port;

  const spawnFn = deps.spawn ?? (nodeSpawn as unknown as PreviewTestSpawnFn);
  const fetchFn = deps.fetch ?? defaultHealthFetch;
  const killFn = deps.kill ?? ((t, s) => process.kill(t, s));
  const healthTimeoutMs = deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthIntervalMs = deps.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;

  const previewCwd = path.join(cwd, DEFAULT_PREVIEW_CWD);

  let child: ChildProcess | null = null;
  let spawnError: Error | null = null;
  try {
    child = spawnFn('sh', ['-c', startScript], {
      cwd: previewCwd,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    spawnError = err as Error;
  }

  if (spawnError || !child) {
    return {
      ok: false,
      ports,
      durationMs: clock.nowMs() - start,
      error: `spawn failed: ${spawnError ? errorMessage(spawnError) : 'unknown spawn error'}`,
    };
  }

  // Collect the first ~50 stdout/stderr lines so a failed test can
  // surface them in the response. Matches the per-session log-tail size.
  const tail: string[] = [];
  const appendTail = (buf: Buffer): void => {
    const txt = buf.toString('utf8');
    for (const line of txt.split('\n')) {
      if (tail.length >= 50) break;
      if (line.length > 0) tail.push(line);
    }
  };
  child.stdout?.on('data', appendTail);
  child.stderr?.on('data', appendTail);

  // Async 'error' events (e.g. EACCES on spawn) may fire after the
  // synchronous return above. Capture the first one — we surface it if
  // the health check ends up failing.
  let asyncSpawnError: string | null = null;
  child.on('error', (err) => {
    if (!asyncSpawnError) asyncSpawnError = err.message;
  });
  // Likewise, premature exit during boot is meaningful — record code/signal.
  let prematureExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    if (!prematureExit) prematureExit = { code, signal: signal as NodeJS.Signals | null };
  });

  try {
    const healthUrl = `http://localhost:${port}${healthPath}`;
    const deadline = clock.nowMs() + healthTimeoutMs;
    let healthOk = false;
    let lastStatus: number | null = null;
    while (clock.nowMs() < deadline) {
      // If the child has already exited, polling further will never
      // succeed — short-circuit so the user sees a clear "spawn died"
      // message instead of waiting the full 30 s.
      if (prematureExit && !healthOk) {
        const { code, signal } = prematureExit;
        return {
          ok: false,
          ports,
          durationMs: clock.nowMs() - start,
          error:
            `startScript exited during startup (code=${code} signal=${signal ?? ''}). ` +
            (asyncSpawnError ? `Spawn error: ${asyncSpawnError}. ` : '') +
            (tail.length > 0 ? `Log tail: ${tail.slice(0, 10).join(' | ')}` : ''),
        };
      }
      try {
        const res = await fetchFn(healthUrl);
        lastStatus = res.status;
        if (res.ok) {
          healthOk = true;
          break;
        }
      } catch {
        // network errors expected while booting — keep polling
      }
      await clock.sleep(healthIntervalMs);
    }

    if (!healthOk) {
      const reason = lastStatus
        ? `health check returned non-2xx (last status: ${lastStatus}) after ${healthTimeoutMs}ms`
        : `health check timed out after ${healthTimeoutMs}ms (no response on ${healthPath})`;
      const detail = asyncSpawnError ? ` Spawn error: ${asyncSpawnError}.` : '';
      const tailHint = tail.length > 0 ? ` Log tail: ${tail.slice(0, 10).join(' | ')}` : '';
      return {
        ok: false,
        ports,
        durationMs: clock.nowMs() - start,
        error: `${reason}.${detail}${tailHint}`,
      };
    }

    // Health passed — capture one screenshot of `http://localhost:<port>/`.
    const screenshotId = randomUUID();
    const screenshotDir = path.join(uploadsDir(deps), 'preview-tests');
    mkdirSync(screenshotDir, { recursive: true });
    const filename = `${screenshotId}.png`;
    const screenshotPath = path.join(screenshotDir, filename);
    const captureFn = deps.captureScreenshot ?? defaultCaptureScreenshot;
    try {
      await captureFn(`http://localhost:${port}/`, screenshotPath);
    } catch (err) {
      // Screenshot failures are non-fatal. The health check passed, so
      // the test is "ok" — we just don't surface a thumbnail.
      return {
        ok: true,
        ports,
        durationMs: clock.nowMs() - start,
        error: `Health check passed but screenshot failed: ${errorMessage(err)}`,
      };
    }

    const screenshotUrl = buildScreenshotUrl(deps.publicUrl ?? null, filename);
    return {
      ok: true,
      ports,
      durationMs: clock.nowMs() - start,
      screenshotUrl,
    };
  } finally {
    // Teardown — always. Send SIGTERM to the process group, wait up to
    // 3s, then SIGKILL. Wrap in try/catch because the child may already
    // be gone (ESRCH) or never assigned a pid.
    if (child && child.exitCode == null && child.signalCode == null) {
      const pid = child.pid;
      if (typeof pid === 'number') {
        try {
          killFn(-pid, 'SIGTERM');
        } catch {
          // pgroup already gone — fall through to direct kill
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        }
      }
      // Wait for actual exit so the OS releases the port before the
      // function returns. If the child doesn't exit gracefully, SIGKILL.
      await waitForExit(child, SIGKILL_GRACE_MS, () => {
        if (typeof child!.pid === 'number') {
          try {
            killFn(-child!.pid, 'SIGKILL');
          } catch {
            try {
              child!.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }
      });
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function uploadsDir(deps: PreviewTestDeps): string {
  return deps.uploadsDir;
}

function buildScreenshotUrl(publicUrl: string | null, filename: string): string {
  const rel = `/uploads/preview-tests/${filename}`;
  if (!publicUrl) return rel;
  return `${publicUrl.replace(/\/$/, '')}${rel}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function waitForExit(proc: ChildProcess, graceMs: number, onTimeout: () => void): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
    }, graceMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Probes `net.createServer().listen(p, '127.0.0.1')` for each port in
 * the configured range and returns the first that binds. Releases the
 * probe socket before returning so the actual spawn can claim the port.
 *
 * There is a benign race here (another process could grab the port
 * between probe-close and spawn) but that surfaces cleanly as an
 * EADDRINUSE in the child's log tail.
 */
async function defaultAllocatePort(min: number, max: number): Promise<number> {
  for (let p = min; p <= max; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createNetServer();
      srv.unref();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => {
        srv.close(() => resolve(true));
      });
      try {
        srv.listen(p, '127.0.0.1');
      } catch {
        resolve(false);
      }
    });
    if (ok) return p;
  }
  throw new Error(`Preview port pool exhausted: all ports in [${min}, ${max}] are in use`);
}

/** Wraps `fetch` and reports `ok`/`status` even on non-2xx replies. */
async function defaultHealthFetch(url: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, { method: 'GET' });
  return { ok: res.ok, status: res.status };
}

/**
 * Production screenshot — launches a headless Chromium via the
 * `playwright` package and snapshots the root URL. Mirrors the same
 * dynamic-import pattern used by `capture-engine.ts` so the module
 * doesn't pay the import cost on cold boot.
 */
async function defaultCaptureScreenshot(url: string, outPath: string): Promise<void> {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    } catch {
      // Fall through — we still want a screenshot of whatever rendered.
    }
    await page.screenshot({ path: outPath, fullPage: false });
    await ctx.close();
  } finally {
    await browser.close();
  }
}
