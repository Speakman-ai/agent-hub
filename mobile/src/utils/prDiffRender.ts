/**
 * prDiffRender.js — pure helpers for the mobile PR "Files changed" view.
 *
 * Normalizes `/api/pr/files` payloads (GitHub read-proxy and native Hub
 * PRs share the field names: filename/status/additions/deletions/patch)
 * and annotates per-file unified patches with line numbers + kinds so the
 * component layer can color lines and anchor inline review comments.
 *
 * Mobile counterpart of the hunk-walking in
 * `client/src/utils/commitDiff.js` (`annotateDiffLines`). No react-native
 * imports — unit-testable in plain node.
 */
/**
 * Normalize a `/api/pr/files` response into render-ready file entries.
 * Accepts the `{ files: [...] }` envelope or a bare array.
 *
 * @returns {Array<{filename: string, status: string, additions: number,
 *   deletions: number, patch: string|null, isBinary: boolean,
 *   previousFilename: string|null}>}
 */
export function normalizePrFiles(payload: any) {
  const raw = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.files)
      ? payload.files
      : [];
  return raw
    .filter((f: any) => f && typeof f === 'object')
    .map((f: any) => {
      const patch = typeof f.patch === 'string' && f.patch.length > 0 ? f.patch : null;
      const additions = Number(f.additions);
      const deletions = Number(f.deletions);
      return {
        filename: typeof f.filename === 'string' ? f.filename : '',
        status: typeof f.status === 'string' && f.status ? f.status : 'modified',
        additions: Number.isFinite(additions) && additions > 0 ? additions : 0,
        deletions: Number.isFinite(deletions) && deletions > 0 ? deletions : 0,
        patch,
        // GitHub omits `patch` for binary (and very large) files; native
        // PRs omit it for binaries too. Either way there is nothing to
        // expand, so the UI labels it instead of rendering an empty body.
        isBinary: !patch,
        previousFilename:
          typeof f.previous_filename === 'string' && f.previous_filename
            ? f.previous_filename
            : null,
      };
    })
    .filter((f: any) => f.filename);
}
/** Sum of per-file counters for the section summary line. */
export function summarizePrFiles(files: any) {
  const list = Array.isArray(files) ? files : [];
  return {
    count: list.length,
    additions: list.reduce((n: any, f: any) => n + (f?.additions || 0), 0),
    deletions: list.reduce((n: any, f: any) => n + (f?.deletions || 0), 0),
  };
}
/** Single-letter status marker for a changed file (GitHub-style). */
export function fileStatusLabel(status: any) {
  switch (String(status || '').toLowerCase()) {
    case 'added':
      return 'A';
    case 'removed':
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    default:
      return 'M';
  }
}
/**
 * Annotate one file's unified patch with line numbers and a render kind.
 *
 * Kinds: 'hunk' (@@ headers), 'meta' (anything before the first hunk —
 * `diff --git`, index, ---/+++ — plus `\ No newline...`), 'add', 'del',
 * 'context'. Additions carry `newLine` only, deletions `oldLine` only,
 * context lines both; hunk/meta lines carry neither (not commentable).
 *
 * Works for both GitHub `patch` fields (which start at the first `@@`)
 * and native patches (full `git diff` output with headers).
 *
 * @param {string|null|undefined} patch
 * @returns {Array<{text: string, kind: string, oldLine: number|null, newLine: number|null}>}
 */
export function annotatePatchLines(patch: any) {
  if (!patch || typeof patch !== 'string') return [];
  const rawLines = patch.split('\n');
  // A trailing '\n' yields a final empty element that isn't a diff line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  let oldLine = null;
  let newLine = null;
  const out = [];
  for (const text of rawLines) {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      out.push({ text, kind: 'hunk', oldLine: null, newLine: null });
      continue;
    }
    if (oldLine === null || newLine === null) {
      // Pre-hunk preamble (file headers, mode changes, binary notes).
      out.push({ text, kind: 'meta', oldLine: null, newLine: null });
      continue;
    }
    if (text.startsWith('\\')) {
      out.push({ text, kind: 'meta', oldLine: null, newLine: null });
    } else if (text.startsWith('+')) {
      out.push({ text, kind: 'add', oldLine: null, newLine });
      newLine += 1;
    } else if (text.startsWith('-')) {
      out.push({ text, kind: 'del', oldLine, newLine: null });
      oldLine += 1;
    } else {
      out.push({ text, kind: 'context', oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}
/**
 * Comment anchor (side + line) for an annotated diff line, or null when
 * the line is not commentable (hunk headers / meta). Matches the server's
 * inline-comment contract: side 'new' = post-image line (additions and
 * context), 'old' = pre-image (deletions).
 */
export function commentAnchorFor(line: any) {
  if (!line || typeof line !== 'object') return null;
  if (line.newLine != null) return { side: 'new', line: line.newLine };
  if (line.oldLine != null) return { side: 'old', line: line.oldLine };
  return null;
}
/** Inline review comments belonging to one file section. */
export function commentsForFile(comments: any, filename: any) {
  if (!Array.isArray(comments) || !filename) return [];
  return comments.filter((c: any) => c && c.file_path === filename);
}
/**
 * Group a file's inline comments into conversations. A thread is the set of
 * comments sharing an anchor (line + side) — the same grouping the web diff
 * uses — and resolution is a property of that anchor, so any comment in the
 * group carrying `resolved` marks the whole thread resolved. Groups come back
 * in first-comment order, which keeps the list stable across refetches.
 */
export function groupCommentThreads(comments: any) {
  if (!Array.isArray(comments)) return [];
  const byAnchor = new Map();
  for (const c of comments) {
    if (!c) continue;
    const side = c.side === 'old' ? 'old' : 'new';
    const line = Number(c.line);
    const key = `${side}:${line}`;
    let thread = byAnchor.get(key);
    if (!thread) {
      thread = { key, line, side, comments: [], resolved: false, resolvedBy: null };
      byAnchor.set(key, thread);
    }
    thread.comments.push(c);
    if (c.resolved) {
      thread.resolved = true;
      thread.resolvedBy = thread.resolvedBy || c.resolved_by || null;
    }
  }
  return Array.from(byAnchor.values());
}
