/**
 * browser-screenshot-store.ts — on-disk sink for `browser` / `preview`
 * screenshot captures.
 *
 * A screenshot is image bytes, and the ReAct continuation channel is text.
 * Inlining the capture as a `data:` URL put up to ~750 KB of base64 into the
 * turn's pending context, which is byte-capped at 128 KiB
 * (`MAX_PENDING_CONTEXT_BYTES`): the capture blew the cap, got clipped to a
 * stream of truncated base64, and evicted every other observation merged into
 * the same turn. The agent saw a host step that "succeeded" and returned
 * nothing it could use.
 *
 * So the bytes land in a file and the markdown carries the path. Agents read
 * images by path with their own file-reading tool; the live chat preview keeps
 * using the separately-capped WebSocket data URL.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Directory under `dataDir` holding every session's captures. */
export const BROWSER_SCREENSHOT_DIR_NAME = 'browser-screenshots';

/** Newest captures retained per session; older files are pruned on write. */
export const BROWSER_SCREENSHOT_RETAIN_PER_SESSION = 20;

/**
 * Per-session retention bounds each directory but not the store: session dirs
 * accumulate forever otherwise. Two backstops, both enforced by
 * {@link sweepBrowserScreenshotStore} on the hourly purge tick.
 */
export const BROWSER_SCREENSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const BROWSER_SCREENSHOT_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Session ids are UUIDs — anything else is refused rather than path-joined. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface SavedBrowserScreenshot {
  /** Absolute path the agent can hand to its file-reading tool. */
  absPath: string;
  fileName: string;
  bytes: number;
}

/**
 * Data dir for captures. Read from the env rather than importing `config.js`
 * so this stays free of that module's load-time side effects; the server
 * exports `AGENT_HUB_DATA_DIR` to every spawn from the same resolved value.
 */
export function resolveScreenshotDataDir(): string {
  return process.env.AGENT_HUB_DATA_DIR || path.join(os.homedir(), '.agent-hub', 'data');
}

export function extensionForScreenshotMime(mime: string | undefined): string {
  return MIME_EXTENSIONS[(mime ?? '').toLowerCase()] ?? 'jpg';
}

/**
 * Absolute directory for a session's captures, or null when `sessionId` is not
 * a safe single path segment (never join untrusted input into a data path).
 */
export function browserScreenshotDirForSession(sessionId: string, dataDir: string): string | null {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') return null;
  if (!dataDir) return null;
  return path.join(dataDir, BROWSER_SCREENSHOT_DIR_NAME, sessionId);
}

/** Human-readable size for the observation line (KB/MB, one decimal). */
export function formatScreenshotBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Delete all but the `keep` newest files in `dir`. Best-effort: a prune failure
 * must never fail the capture that triggered it.
 */
export function pruneBrowserScreenshots(dir: string, keep: number): number {
  let removed = 0;
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          // Raced with another prune — treat as oldest so it gets swept.
        }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of entries.slice(Math.max(0, keep))) {
      try {
        fs.unlinkSync(stale.full);
        removed++;
      } catch {
        // Already gone or not ours — nothing to do.
      }
    }
  } catch {
    // Directory unreadable — nothing to prune.
  }
  return removed;
}

export interface SaveBrowserScreenshotOpts {
  sessionId: string;
  dataDir: string;
  imageBase64: string;
  mime?: string;
  /** Filename prefix, e.g. `browser` or `preview`. */
  label?: string;
  retain?: number;
}

/**
 * Write a capture to `<dataDir>/browser-screenshots/<sessionId>/`. Returns null
 * on any failure — a screenshot that cannot be persisted still reports success
 * to the UI, it just has no path for the agent to read.
 */
export function saveBrowserScreenshot(
  opts: SaveBrowserScreenshotOpts,
): SavedBrowserScreenshot | null {
  const { sessionId, dataDir, imageBase64, mime, label = 'browser' } = opts;
  if (!imageBase64) return null;
  const dir = browserScreenshotDirForSession(sessionId, dataDir);
  if (!dir) return null;

  const safeLabel = /^[a-z0-9-]{1,24}$/.test(label) ? label : 'browser';
  const ext = extensionForScreenshotMime(mime);
  const fileName = `${safeLabel}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const absPath = path.join(dir, fileName);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(imageBase64, 'base64');
    if (buf.length === 0) return null;
    fs.writeFileSync(absPath, buf);
    pruneBrowserScreenshots(dir, opts.retain ?? BROWSER_SCREENSHOT_RETAIN_PER_SESSION);
    return { absPath, fileName, bytes: buf.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[browser-screenshot] failed to save capture for ${sessionId}: ${msg}`);
    return null;
  }
}

/**
 * Markdown lines describing a saved capture — the replacement for the inlined
 * `data:` URL. Kept tiny so a screenshot can never dominate pending context.
 */
export function screenshotObservationLines(
  saved: SavedBrowserScreenshot | null,
  mime: string,
): string[] {
  if (!saved) {
    return [
      '',
      'Screenshot captured but could not be written to disk, so there is no path to read.',
    ];
  }
  return [
    '',
    `Screenshot saved to \`${saved.absPath}\` (${formatScreenshotBytes(saved.bytes)}, ${mime}).`,
    'Read that path with your file-reading tool to view the image.',
  ];
}

/** Root of the whole store, or null when `dataDir` is unusable. */
export function browserScreenshotStoreRoot(dataDir: string): string | null {
  return dataDir ? path.join(dataDir, BROWSER_SCREENSHOT_DIR_NAME) : null;
}

/**
 * Drop a session's entire capture directory. Called when the session is
 * hard-deleted, so the normal lifecycle reclaims its own bytes rather than
 * leaving them for the age/size backstop. Best-effort and never throws — a
 * cleanup failure must not abort the purge of the rest of the session.
 */
export function removeBrowserScreenshotsForSession(sessionId: string, dataDir: string): boolean {
  const dir = browserScreenshotDirForSession(sessionId, dataDir);
  if (!dir) return false;
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[browser-screenshot] failed to remove capture dir for ${sessionId}: ${msg}`);
    return false;
  }
}

export interface BrowserScreenshotSweepOpts {
  dataDir: string;
  maxAgeMs?: number;
  maxTotalBytes?: number;
  /** Injected for deterministic tests. */
  nowMs?: number;
}

export interface BrowserScreenshotSweepResult {
  /** Session directories removed. */
  dirsRemoved: number;
  bytesReclaimed: number;
  /** Bytes still on disk after the sweep. */
  bytesRemaining: number;
}

interface SessionDirStat {
  dir: string;
  bytes: number;
  /** Newest mtime inside the dir — the session's last capture. */
  newestMtimeMs: number;
}

function statSessionDir(dir: string): SessionDirStat | null {
  try {
    let bytes = 0;
    let newestMtimeMs = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const st = fs.statSync(path.join(dir, entry.name));
        bytes += st.size;
        if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
      } catch {
        // Raced with a concurrent prune — skip this entry.
      }
    }
    return { dir, bytes, newestMtimeMs };
  } catch {
    return null;
  }
}

/**
 * Global backstop over the whole store, run from the hourly purge tick.
 *
 * Per-session retention caps each directory but nothing caps the number of
 * directories, so completed sessions would accumulate forever. Two bounds are
 * enforced here:
 *
 * 1. **Age** — a session dir whose newest capture is older than `maxAgeMs`
 *    goes entirely. This is also what reclaims orphans: dirs whose session row
 *    vanished without passing through the hard-delete path (crash, manual row
 *    delete, a session that never archived) have no other collector.
 * 2. **Total size** — if the store still exceeds `maxTotalBytes`, the
 *    least-recently-used session dirs are removed until it fits, so disk is
 *    bounded even under a burst of active sessions inside the age window.
 *
 * Best-effort throughout: an unreadable entry is skipped, never fatal.
 */
export function sweepBrowserScreenshotStore(
  opts: BrowserScreenshotSweepOpts,
): BrowserScreenshotSweepResult {
  const {
    dataDir,
    maxAgeMs = BROWSER_SCREENSHOT_MAX_AGE_MS,
    maxTotalBytes = BROWSER_SCREENSHOT_STORE_MAX_BYTES,
    nowMs = Date.now(),
  } = opts;
  const result: BrowserScreenshotSweepResult = {
    dirsRemoved: 0,
    bytesReclaimed: 0,
    bytesRemaining: 0,
  };

  const root = browserScreenshotStoreRoot(dataDir);
  if (!root) return result;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // Store not created yet (no screenshot ever taken) — nothing to sweep.
    return result;
  }

  const remove = (stat: SessionDirStat): void => {
    try {
      fs.rmSync(stat.dir, { recursive: true, force: true });
      result.dirsRemoved++;
      result.bytesReclaimed += stat.bytes;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[browser-screenshot] sweep could not remove ${stat.dir}: ${msg}`);
      // Failed removal still occupies disk — keep it in the running total.
      result.bytesRemaining += stat.bytes;
    }
  };

  const survivors: SessionDirStat[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stat = statSessionDir(path.join(root, entry.name));
    if (!stat) continue;
    // An empty dir carries newestMtimeMs 0, so it ages out immediately.
    if (nowMs - stat.newestMtimeMs > maxAgeMs) {
      remove(stat);
    } else {
      survivors.push(stat);
    }
  }

  let liveBytes = survivors.reduce((sum, s) => sum + s.bytes, 0);
  if (liveBytes > maxTotalBytes) {
    // Oldest-first so the sessions most likely still in use survive longest.
    survivors.sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);
    for (const stat of survivors) {
      if (liveBytes <= maxTotalBytes) break;
      const before = result.dirsRemoved;
      remove(stat);
      if (result.dirsRemoved > before) liveBytes -= stat.bytes;
      stat.bytes = -1; // Mark as handled for the remaining-bytes tally below.
    }
  }

  result.bytesRemaining += survivors
    .filter((s) => s.bytes >= 0)
    .reduce((sum, s) => sum + s.bytes, 0);

  if (result.dirsRemoved > 0) {
    console.log(
      `[browser-screenshot] sweep removed ${result.dirsRemoved} session dir(s), reclaimed ${formatScreenshotBytes(result.bytesReclaimed)}; ${formatScreenshotBytes(result.bytesRemaining)} remaining.`,
    );
  }
  return result;
}
