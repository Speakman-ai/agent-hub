/**
 * Re-touch files a shell command just rewrote so the preview dev server's
 * file watcher sees an in-place change.
 *
 * `sed -i`, `perl -i`, `mv`, `cp` and friends replace a file by writing a
 * temp file and renaming it over the original. Some watchers (ng serve's
 * esbuild watcher among them) track the old inode or collapse the
 * unlink+add pair and never rebuild, so the preview keeps serving stale
 * code until something writes the file in place. A `touch` is that write:
 * it only bumps mtime, never content, and reliably produces a change event
 * on both inotify and polling watchers.
 *
 * Scope: shell tools only (the editor tools write in place), only while
 * this session has a preview booting or serving, and only source files
 * whose inode changed inside the command's run window. Every shell command
 * is checked rather than guessing writers from the command text (`perl -i`,
 * scripts, formatters); a read-only command finds nothing and stops there.
 */
import { sessionWorktreeIoFor } from '../session-worktree-io.js';
import type { SessionWorktreeIo } from '../session-env/worktree-io.js';
import {
  sessionHasActiveUserPreview,
  type PreviewWorktreeSyncDeps,
} from './preview-worktree-sync.js';

const SHELL_TOOLS = new Set(['Bash', 'Shell', 'run_terminal_cmd']);

/** Wait for a burst of shell results to settle, and let watcher atomic-write windows close. */
export const NUDGE_DEBOUNCE_MS = 400;
/** Tolerate clock skew between the Hub and a guest-hosted worktree. */
const CHANGE_SLACK_MS = 5_000;
/** A command touching more than this is a checkout or install, not an edit. */
const MAX_NUDGE_FILES = 200;
const TOUCH_CHUNK = 50;
/** Close command windows whose result never arrived (killed turn). */
const OPEN_WINDOW_TTL_MS = 30 * 60_000;

export interface PreviewWatchNudgeDeps extends PreviewWorktreeSyncDeps {
  worktreePath: string;
  now?: () => number;
  resolveIo?: (sessionId: string, worktreePath: string) => Promise<SessionWorktreeIo>;
  schedule?: (fn: () => void, ms: number) => void;
  /** Override the clock-skew slack (tests). */
  changeSlackMs?: number;
}

interface OpenWindow {
  sessionId: string;
  startedAt: number;
}

/**
 * The single record of every change window some scan may still examine,
 * keyed `cmd:<toolUseId>` or `scan:<n>`. A shell command's window opens at
 * its tool_use and stays open until a scan covering it has been requested;
 * a scan's window opens synchronously when it is requested and closes when
 * it completes, however long it waits in the per-session queue. Ledger
 * pruning reads only this map, so no hand-off (awaiting a result, the
 * debounce, the queue, in-flight I/O) can leave a live window uncounted.
 */
const openWindows = new Map<string, OpenWindow>();
let scanSeq = 0;
const scheduledBySession = new Map<
  string,
  { since: number; deps: PreviewWatchNudgeDeps; commandWindowIds: Set<string> }
>();
/**
 * Per session: worktree path -> fingerprint (`ctime:inode:size`) we last
 * observed, including the one our own `touch` produced. A file is nudged
 * only when its fingerprint moved since then, so the slack window can never
 * re-select a file whose latest change was a previous nudge. The inode is
 * there because kernel ctime ticks coarsely (a few ms): a `sed -i` or `mv`
 * landing in the same tick as our touch still gets a new inode.
 */
const fingerprintLedgerBySession = new Map<string, Map<string, string>>();
/** Nudges for one session run one at a time so none sees another's touch as an edit. */
const nudgeChainBySession = new Map<string, Promise<unknown>>();

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}

/** Call on every `tool_use` stream event. */
export function notePreviewWatchToolUse(
  sessionId: string,
  toolUseId: string | undefined,
  tool: string,
  _input: Record<string, unknown>,
  now: number = Date.now(),
): void {
  if (!toolUseId || !isShellTool(tool)) return;
  for (const [id, w] of openWindows) {
    if (id.startsWith('cmd:') && now - w.startedAt > OPEN_WINDOW_TTL_MS) openWindows.delete(id);
  }
  openWindows.set(`cmd:${toolUseId}`, { sessionId, startedAt: now });
}

/** Call on every `tool_result` stream event. */
export function notePreviewWatchToolResult(
  sessionId: string,
  toolUseId: string | undefined,
  deps: PreviewWatchNudgeDeps,
): void {
  if (!toolUseId) return;
  const windowId = `cmd:${toolUseId}`;
  const window = openWindows.get(windowId);
  if (!window || window.sessionId !== sessionId) return;
  if (!sessionHasActiveUserPreview(sessionId, deps)) {
    openWindows.delete(windowId);
    return;
  }

  const existing = scheduledBySession.get(sessionId);
  if (existing) {
    existing.since = Math.min(existing.since, window.startedAt);
    existing.deps = deps;
    existing.commandWindowIds.add(windowId);
    return;
  }
  scheduledBySession.set(sessionId, {
    since: window.startedAt,
    deps,
    commandWindowIds: new Set([windowId]),
  });
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
  schedule(() => {
    const entry = scheduledBySession.get(sessionId);
    scheduledBySession.delete(sessionId);
    if (!entry) return;
    // The scan registers its own window synchronously, so the command
    // windows can close now without a gap.
    void nudgeRecentlyChangedFiles(sessionId, entry.since, entry.deps).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[preview-nudge] ${sessionId.slice(0, 8)}: ${msg}`);
    });
    for (const id of entry.commandWindowIds) openWindows.delete(id);
  }, NUDGE_DEBOUNCE_MS);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Worktree files whose inode changed since `sinceSec` (epoch seconds), as
 * NUL-delimited `<fingerprint>\\0<path>\\0` pairs.
 *
 * ctime, not mtime or git status: `mv` keeps the source's mtime, and a
 * `sed -i` that restores committed contents leaves the file clean, yet both
 * bump ctime (rename and replace always do). The window is only a cheap
 * pre-filter; the per-session ledger decides what actually changed.
 * `.git` and `node_modules` are pruned so the walk stays cheap.
 */
export function buildRecentChangeFindCommand(sinceSec: number): string {
  return (
    `find . \\( -name .git -o -name node_modules \\) -prune -o ` +
    `-type f -newerct @${Math.floor(sinceSec)} -printf '%C@:%i:%s\\0%p\\0'`
  );
}

export function buildTouchCommand(paths: string[]): string {
  // `-c`: a path removed since listing is skipped, never created.
  return `touch -c -- ${paths.map((p) => shellQuote(`./${p}`)).join(' ')}`;
}

/** Current fingerprints of the given paths; vanished paths are simply absent. */
export function buildStatCommand(paths: string[]): string {
  const quoted = paths.map((p) => shellQuote(`./${p}`)).join(' ');
  return `find ${quoted} -maxdepth 0 -printf '%C@:%i:%s\\0%p\\0' 2>/dev/null; exit 0`;
}

export function inodeOf(fingerprint: string): string {
  return fingerprint.split(':')[1] ?? '';
}

/** Touch-and-verify rounds before leaving a still-churning file to the next scan. */
const TOUCH_ATTEMPTS = 3;

/**
 * Touch `expected` (path -> inode seen by the scan) and return the
 * fingerprints that are provably post-touch: the stat after the touch shows
 * the same inode we meant to touch. A different inode means another command
 * replaced the file around our touch, so the replacement is touched again
 * with its own inode as the new expectation. Anything never verified is
 * left out; the caller must not ledger it, so a later scan retries it.
 * (An in-place write to the same inode in that gap is accepted: watchers
 * see in-place writes on their own; only replacements get lost.)
 */
async function touchVerified(
  io: SessionWorktreeIo,
  expected: Map<string, string>,
  tag: string,
): Promise<Map<string, string>> {
  const verified = new Map<string, string>();
  let pending = expected;
  for (let attempt = 0; attempt < TOUCH_ATTEMPTS && pending.size > 0; attempt++) {
    const retry = new Map<string, string>();
    const paths = [...pending.keys()];
    for (let i = 0; i < paths.length; i += TOUCH_CHUNK) {
      const chunk = paths.slice(i, i + TOUCH_CHUNK);
      const touched = await io.exec(buildTouchCommand(chunk), { timeoutMs: 10_000 });
      if (touched.exitCode !== 0) {
        console.warn(
          `[preview-nudge] ${tag}: touch failed (${touched.exitCode}): ${touched.stderr.trim()}`,
        );
        continue;
      }
      const stat = await io.exec(buildStatCommand(chunk), { timeoutMs: 10_000 });
      for (const [path, fp] of parseFingerprintPairs(stat.stdout)) {
        if (inodeOf(fp) === pending.get(path)) verified.set(path, fp);
        else retry.set(path, inodeOf(fp));
      }
    }
    pending = retry;
  }
  if (pending.size > 0) {
    console.info(
      `[preview-nudge] ${tag}: ${pending.size} file(s) kept changing, left for next scan`,
    );
  }
  return verified;
}

/** Parse `<fingerprint>\\0<path>\\0` pairs into worktree-relative path -> fingerprint. */
export function parseFingerprintPairs(stdout: string): Map<string, string> {
  const fields = stdout.split('\0');
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1].replace(/^\.\//, '');
    if (fields[i] && path) out.set(path, fields[i]);
  }
  return out;
}

/**
 * Tracked files plus untracked files git does not ignore, as git itself
 * resolves them (negated patterns, nested .gitignore, info/exclude,
 * core.excludesFile). `-z` keeps names verbatim.
 */
export const LIST_SOURCE_FILES_GIT_ARGS = ['ls-files', '-z', '-co', '--exclude-standard'];

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((p) => p.length > 0);
}

/** Returns the worktree-relative paths that were touched. */
export function nudgeRecentlyChangedFiles(
  sessionId: string,
  since: number,
  deps: PreviewWatchNudgeDeps,
): Promise<string[]> {
  const scanWindowId = `scan:${++scanSeq}`;
  openWindows.set(scanWindowId, { sessionId, startedAt: since });
  const prev = nudgeChainBySession.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => runNudge(sessionId, since, deps));
  nudgeChainBySession.set(sessionId, run);
  void run
    .finally(() => {
      openWindows.delete(scanWindowId);
      if (nudgeChainBySession.get(sessionId) === run) nudgeChainBySession.delete(sessionId);
    })
    .catch(() => undefined);
  return run;
}

/**
 * Start of the oldest window still open for this session. Commands start at
 * "now" or later, so no future window reaches further back.
 */
function oldestOpenWindowStart(sessionId: string, fallback: number): number {
  let oldest = fallback;
  for (const w of openWindows.values()) {
    if (w.sessionId === sessionId) oldest = Math.min(oldest, w.startedAt);
  }
  return oldest;
}

/**
 * Drop fingerprints no outstanding window can include. Pruning by the
 * current scan's window alone is wrong when commands finish out of order: an
 * older window would re-see a file whose post-touch fingerprint was dropped
 * and nudge it again.
 */
function pruneLedger(
  sessionId: string,
  ledger: Map<string, string>,
  since: number,
  deps: PreviewWatchNudgeDeps,
): void {
  const windowStart = oldestOpenWindowStart(sessionId, since);
  // Same floor as the find window, so an entry kept here is exactly one a
  // window could still list.
  const cutoffSec = Math.floor((windowStart - (deps.changeSlackMs ?? CHANGE_SLACK_MS)) / 1000);
  for (const [path, fp] of ledger) {
    if (Number.parseFloat(fp) < cutoffSec) ledger.delete(path);
  }
}

async function runNudge(
  sessionId: string,
  since: number,
  deps: PreviewWatchNudgeDeps,
): Promise<string[]> {
  if (!sessionHasActiveUserPreview(sessionId, deps)) {
    fingerprintLedgerBySession.delete(sessionId);
    return [];
  }
  const tag = sessionId.slice(0, 8);
  const resolveIo = deps.resolveIo ?? sessionWorktreeIoFor;
  const io = await resolveIo(sessionId, deps.worktreePath);
  const sinceSec = (since - (deps.changeSlackMs ?? CHANGE_SLACK_MS)) / 1000;
  const found = await io.exec(buildRecentChangeFindCommand(sinceSec), { timeoutMs: 15_000 });
  if (found.exitCode !== 0) {
    console.warn(`[preview-nudge] ${tag}: find failed (${found.exitCode}): ${found.stderr.trim()}`);
    return [];
  }
  const observed = parseFingerprintPairs(found.stdout);
  if (observed.size === 0) return [];
  const listed = await io.git(LIST_SOURCE_FILES_GIT_ARGS, { timeoutMs: 15_000 });
  if (listed.exitCode !== 0) {
    console.warn(
      `[preview-nudge] ${tag}: git ls-files failed (${listed.exitCode}): ${listed.stderr.trim()}`,
    );
    return [];
  }
  const source = new Set(splitNul(listed.stdout));
  let ledger = fingerprintLedgerBySession.get(sessionId);
  if (!ledger) {
    ledger = new Map<string, string>();
    fingerprintLedgerBySession.set(sessionId, ledger);
  }
  // Invariant: a changed file enters the ledger only with a fingerprint
  // verified to be post-touch. Recording it any earlier would mark it
  // handled even if the touch fails or lands on a different inode.
  const changed = new Map<string, string>();
  for (const [path, fp] of observed) {
    if (!source.has(path) || ledger.get(path) === fp) continue;
    changed.set(path, fp);
  }
  if (changed.size > MAX_NUDGE_FILES) {
    // Deliberately declined (checkout, install): ledger them as-is so later
    // scans do not reconsider the same burst.
    for (const [path, fp] of changed) ledger.set(path, fp);
    pruneLedger(sessionId, ledger, since, deps);
    console.info(`[preview-nudge] ${tag}: over ${MAX_NUDGE_FILES} changed files, skipping`);
    return [];
  }
  const expected = new Map([...changed].map(([path, fp]) => [path, inodeOf(fp)]));
  const verified = await touchVerified(io, expected, tag);
  for (const [path, fp] of verified) ledger.set(path, fp);
  pruneLedger(sessionId, ledger, since, deps);
  if (verified.size > 0) {
    console.info(`[preview-nudge] ${tag}: touched ${verified.size} file(s) after shell edit`);
  }
  return [...verified.keys()];
}

/** Test-only: ledgered paths for a session. */
export function ledgerPathsForTest(sessionId: string): string[] {
  return [...(fingerprintLedgerBySession.get(sessionId)?.keys() ?? [])].sort();
}

/** Test-only reset. */
export function resetPreviewWatchNudgeState(): void {
  openWindows.clear();
  scanSeq = 0;
  scheduledBySession.clear();
  fingerprintLedgerBySession.clear();
  nudgeChainBySession.clear();
}
