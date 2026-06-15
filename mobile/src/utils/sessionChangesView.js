/**
 * Pure view-model helpers for the SessionChanges screen — the mobile
 * counterpart of the web client's SessionChangesPane.
 *
 * Server contracts (see `server/session-changes.ts` + `server/routes/sessions.ts`):
 *
 *   GET /api/sessions/:id/changes →
 *     { baseBranch, baseSha, headSha, branch, dirty, files: [
 *         { path, oldPath?, status, additions, deletions, binary, untracked }
 *       ], truncated }
 *
 *   GET /api/sessions/:id/changes/diff?file= →
 *     { path, status, binary, unifiedDiff, tooLarge }
 *
 *   GET /api/sessions/:id/worktree-changes →
 *     { branch, hasUncommitted, hasUnpushed, committable, headSha }
 *
 * Everything here is dependency-free (no react-native imports) so it can be
 * unit-tested with plain Vitest in a node environment.
 */

/** Visual metadata per change status. `tone` is a semantic color slot the
 * screen resolves against the theme (add=green, del=red, info=blue, warn=amber). */
const STATUS_META = {
  added: { short: 'A', label: 'Added', tone: 'add' },
  deleted: { short: 'D', label: 'Deleted', tone: 'del' },
  renamed: { short: 'R', label: 'Renamed', tone: 'info' },
  copied: { short: 'C', label: 'Copied', tone: 'info' },
  'type-changed': { short: 'T', label: 'Type changed', tone: 'warn' },
  modified: { short: 'M', label: 'Modified', tone: 'warn' },
};

/** Status badge metadata, falling back to `modified` for unknown statuses
 * (matches the web pane's STATUS_META[f.status] || STATUS_META.modified). */
export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.modified;
}

/** Last path segment, e.g. `src/utils/api.js` → `api.js`. */
export function basename(p) {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Directory part, e.g. `src/utils/api.js` → `src/utils` (empty for bare names). */
export function dirname(p) {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

/**
 * Normalize a `/changes` response body into what the screen renders.
 * Defensive about shape: tolerates a null/error body, a non-array `files`,
 * missing counters, and unknown statuses. Also precomputes the +/− totals
 * the header shows.
 */
export function normalizeChangesSummary(body) {
  const rawFiles = Array.isArray(body?.files) ? body.files : [];
  const files = [];
  for (const f of rawFiles) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    files.push({
      path: f.path,
      oldPath: typeof f.oldPath === 'string' && f.oldPath ? f.oldPath : null,
      status: STATUS_META[f.status] ? f.status : 'modified',
      additions: Number.isFinite(f.additions) ? f.additions : 0,
      deletions: Number.isFinite(f.deletions) ? f.deletions : 0,
      binary: !!f.binary,
      untracked: !!f.untracked,
    });
  }
  const totals = files.reduce(
    (acc, f) => {
      acc.additions += f.additions;
      acc.deletions += f.deletions;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
  return {
    branch: typeof body?.branch === 'string' ? body.branch : null,
    baseBranch: typeof body?.baseBranch === 'string' ? body.baseBranch : null,
    dirty: !!body?.dirty,
    truncated: !!body?.truncated,
    files,
    totals,
  };
}

/**
 * Classify one raw unified-diff line for coloring.
 * Order matters: `+++`/`---` file headers must win over `+`/`-` content lines.
 *
 * Types: 'add' | 'del' | 'hunk' | 'meta' | 'context'
 */
export function classifyDiffLine(line) {
  if (typeof line !== 'string') return 'context';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('dissimilarity index') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to') ||
    line.startsWith('copy from') ||
    line.startsWith('copy to') ||
    line.startsWith('Binary files') ||
    line.startsWith('\\')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/**
 * Split a raw unified diff into `{ text, type }` line objects.
 * A single trailing newline (git always emits one) is trimmed so the
 * renderer doesn't show a phantom empty line.
 */
export function parseUnifiedDiff(unifiedDiff) {
  if (typeof unifiedDiff !== 'string' || unifiedDiff.length === 0) return [];
  const text = unifiedDiff.endsWith('\n') ? unifiedDiff.slice(0, -1) : unifiedDiff;
  if (!text) return [];
  return text.split('\n').map((line) => ({ text: line, type: classifyDiffLine(line) }));
}

/** Render cap so a near-MAX_FILE_DIFF_BYTES diff can't mount tens of
 * thousands of <Text> nodes on a phone. */
export const MAX_RENDER_LINES = 1500;

/**
 * Turn a `/changes/diff` response (or fetch failure) into a render decision.
 *
 * Returns one of:
 *   { kind: 'loading' }                       — diff not fetched yet
 *   { kind: 'error', message }                — fetch / server error
 *   { kind: 'binary' }                        — binary file, no text diff
 *   { kind: 'tooLarge' }                      — server withheld the body
 *   { kind: 'empty' }                         — no textual changes
 *   { kind: 'diff', lines, hiddenLines }      — parsed lines (capped)
 */
export function describeDiff(diff, { maxLines = MAX_RENDER_LINES } = {}) {
  if (!diff) return { kind: 'loading' };
  if (diff.error) return { kind: 'error', message: String(diff.error) };
  if (diff.binary) return { kind: 'binary' };
  if (diff.tooLarge) return { kind: 'tooLarge' };
  const lines = parseUnifiedDiff(diff.unifiedDiff);
  if (lines.length === 0) return { kind: 'empty' };
  if (lines.length > maxLines) {
    return { kind: 'diff', lines: lines.slice(0, maxLines), hiddenLines: lines.length - maxLines };
  }
  return { kind: 'diff', lines, hiddenLines: 0 };
}

/**
 * One-line live git-status hint from `/worktree-changes`
 * (e.g. "uncommitted changes · unpushed commits"), or null when clean/unknown.
 */
export function worktreeStatusLine(worktree) {
  if (!worktree || typeof worktree !== 'object') return null;
  const parts = [];
  if (worktree.hasUncommitted) parts.push('uncommitted changes');
  if (worktree.hasUnpushed) parts.push('unpushed commits');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Resolve the freshest available session row for the Changes screen.
 *
 * The screen is reached via React Navigation, whose route params carry only a
 * one-time snapshot of the session. `FinalizeBar` re-syncs its dropdown from
 * the `session` prop, so a stale snapshot reintroduces the wrong-mode bug it
 * fixes (e.g. showing `Build` while the server is in Ask mode). Resolution
 * order, freshest first:
 *
 *   1. The live copy from app context (`sessions` / `cronSessions`), kept
 *      current by WebSocket events — this reflects mode changes made elsewhere.
 *   2. A row fetched directly for this id (covers sessions not in the active
 *      agent's context list, or opened before that list loaded).
 *   3. The route-param snapshot, as a last resort so the bar still renders.
 *
 * @param {{
 *   sessionId?: string|null,
 *   sessions?: Array<{ id?: string }>|null,
 *   cronSessions?: Array<{ id?: string }>|null,
 *   fetched?: { id?: string }|null,
 *   routeSession?: object|null,
 * }} params
 * @returns {object|null}
 */
export function resolveLiveSession({
  sessionId,
  sessions,
  cronSessions,
  fetched,
  routeSession,
} = {}) {
  if (sessionId) {
    const fromContext =
      (Array.isArray(sessions) && sessions.find((s) => s?.id === sessionId)) ||
      (Array.isArray(cronSessions) && cronSessions.find((s) => s?.id === sessionId));
    if (fromContext) return fromContext;
    if (fetched && fetched.id === sessionId) return fetched;
  }
  return routeSession || null;
}

/**
 * Whether the Changes screen should fetch the session row directly: only when
 * we have an id but no live copy in app context (else context — kept fresh via
 * WS — is authoritative and a fetch would be redundant/staler).
 *
 * @param {{ sessionId?: string|null, contextSession?: object|null }} params
 * @returns {boolean}
 */
export function shouldFetchSessionRow({ sessionId, contextSession } = {}) {
  return !!sessionId && !contextSession;
}
