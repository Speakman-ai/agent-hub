/**
 * Diff utilities for verbose mode code change display.
 */

/** Returns true for tools that modify files (Edit, Write). */
export function isFileModifyingTool(tool) {
  return tool === 'Edit' || tool === 'Write';
}

/**
 * Shorten a file path for display — show the last 3 segments.
 * e.g. /home/user/projects/app/src/components/Foo.jsx → src/components/Foo.jsx
 */
export function shortenPath(filePath) {
  if (!filePath) return '';
  const parts = filePath.split('/').filter(Boolean);
  return parts.length <= 3 ? filePath : parts.slice(-3).join('/');
}

/**
 * Codex CLI (`codex exec --json`) emits `file_change` items with a `changes`
 * array. `item.started` may only include `{ path, kind }`; `unified_diff` often
 * arrives on `item.completed` (merged into the tool card via
 * `mergeEditInputWithToolResult` + `tool_result.output` JSON).
 *
 * @param {Array<{ path?: string, kind?: string, unified_diff?: string, unifiedDiff?: string, diff?: string, patch?: string, patchContent?: string, patch_content?: string, content?: string }>} changes
 */
function parseCodexFileChanges(changes) {
  if (!changes.length) {
    return {
      filePath: '',
      action: 'Files',
      removals: [],
      additions: ['(no files in patch)'],
    };
  }

  const removals = [];
  const additions = [];

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (i > 0) {
      removals.push('');
      additions.push('· · ·');
    }

    const p = c?.path ?? '';
    const kind = String(c?.kind ?? '').toLowerCase();
    const label = kind === 'add' ? 'add' : kind === 'delete' ? 'delete' : 'update';
    const patch = getCodexPatchText(c);
    if (patch) {
      const parsed = parseApplyPatchContent(patch);
      removals.push(...parsed.removals);
      additions.push(`${label}  ${p}`);
      additions.push(...parsed.additions);
    } else if (typeof c?.content === 'string' && c.content.trim()) {
      additions.push(`${label}  ${p}`);
      for (const line of c.content.split('\n')) {
        additions.push(line);
      }
    } else {
      additions.push(
        `${label}  ${p || '(unknown path)'} — line-level diff not included in Codex JSON output`,
      );
    }
  }

  const multi = changes.length > 1;
  return {
    filePath: multi ? `${changes.length} files` : changes[0]?.path || '',
    action: multi
      ? 'Patch'
      : changes[0]?.kind === 'add'
        ? 'Create'
        : changes[0]?.kind === 'delete'
          ? 'Delete'
          : 'Update',
    removals,
    additions,
  };
}

function getCodexPatchText(change) {
  if (!change || typeof change !== 'object') return '';
  for (const key of [
    'unified_diff',
    'unifiedDiff',
    'diff',
    'patch',
    'patchContent',
    'patch_content',
  ]) {
    if (typeof change[key] === 'string' && change[key].trim()) {
      return change[key];
    }
  }
  return '';
}

function stripLeadingBom(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** True when the first codepoint is a minus used as a diff leader (ASCII or common Unicode). */
function isDiffMinusLeader(line) {
  const ch0 = line.codePointAt(0);
  return ch0 === 0x2d || ch0 === 0x2212 || ch0 === 0x2013;
}

/** True when the first codepoint is a plus used as a diff leader. */
function isDiffPlusLeader(line) {
  return line.codePointAt(0) === 0x2b;
}

/**
 * Codex `file_change` often emits `item.started` with `{ path, kind }` only, then
 * `item.completed` repeats the same paths with `unified_diff` in `tool_result.output`
 * (JSON array). DiffView reads the paired `tool_use.input`; merge completed hunks in
 * so line-level diffs render after the turn finishes.
 *
 * @param {Record<string, unknown> | null | undefined} input
 * @param {{ output?: string } | null | undefined} toolResult
 */
export function mergeEditInputWithToolResult(input, toolResult) {
  if (!input || typeof input !== 'object') return input;
  const changes = input.changes;
  if (!Array.isArray(changes) || changes.length === 0) return input;
  const rawOut = toolResult?.output;
  if (typeof rawOut !== 'string' || !rawOut.trim()) return input;
  let completed;
  try {
    completed = JSON.parse(rawOut);
  } catch {
    return input;
  }
  if (!Array.isArray(completed)) return input;

  const byPath = new Map();
  for (const ch of completed) {
    if (ch && typeof ch === 'object' && typeof ch.path === 'string') {
      byPath.set(ch.path, ch);
    }
  }

  let touched = false;
  const mergedChanges = changes.map((st) => {
    if (!st || typeof st !== 'object') return st;
    const p = st.path;
    if (typeof p !== 'string') return st;
    const fin = byPath.get(p);
    if (!fin || typeof fin !== 'object') return st;
    const next = { ...st };
    const patch = getCodexPatchText(fin);
    if (patch) {
      next.unified_diff = patch;
      touched = true;
    }
    if (typeof fin.content === 'string' && fin.content.trim()) {
      next.content = fin.content;
      touched = true;
    }
    if (typeof fin.kind === 'string' && fin.kind) {
      next.kind = fin.kind;
      touched = true;
    }
    return next;
  });

  return touched ? { ...input, changes: mergedChanges } : input;
}

/**
 * Split a unified-diff / applyPatch body into removal (-) and addition (+) lines.
 * Cursor `editToolCall` uses `applyPatch.patchContent` (see Cursor CLI docs).
 * Strips leading +/- from each line — DiffView renders its own gutter markers.
 */
function parseApplyPatchContent(patch) {
  if (typeof patch !== 'string' || !patch.trim()) {
    return { removals: [], additions: [] };
  }
  const removals = [];
  const additions = [];
  const body = stripLeadingBom(patch);
  for (let rawLine of body.split(/\r\n|\n|\r/)) {
    rawLine = rawLine.replace(/\r$/, '');
    if (rawLine.startsWith('diff --git')) continue;
    if (rawLine.startsWith('index ')) continue;
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) continue;
    if (rawLine.startsWith('@@')) continue;
    if (rawLine === '\\ No newline at end of file') continue;
    if (isDiffMinusLeader(rawLine) && !rawLine.startsWith('--- ')) {
      removals.push(rawLine.slice(1));
    } else if (isDiffPlusLeader(rawLine)) {
      additions.push(rawLine.slice(1));
    }
  }
  if (removals.length === 0 && additions.length === 0) {
    const raw = body
      .trim()
      .split(/\r\n|\n|\r/)
      .map((l) => l.replace(/\r$/, ''));
    return { removals: [], additions: raw.length ? raw : ['(empty patch)'] };
  }
  return { removals, additions };
}

/**
 * Cursor Agent stream-json passes `detail.args` as tool input. Edit uses nested
 * strategies (`strReplace`, `multiStrReplace`, `applyPatch`) — not Claude's
 * top-level `old_string` / `new_string`. See Cursor output-format docs.
 *
 * @returns {{ removals: string[], additions: string[] } | null}
 */
/** Split file text into diff lines; empty string → no rows (avoids blank +/- gutters). */
function splitDiffLines(text) {
  if (text === '' || text == null) return [];
  return String(text).split('\n');
}

function parseCursorEditStrategies(input) {
  if (!input || typeof input !== 'object') return null;

  const sr = input.strReplace;
  if (sr && typeof sr === 'object') {
    const oldT = typeof sr.oldText === 'string' ? sr.oldText : '';
    const newT = typeof sr.newText === 'string' ? sr.newText : '';
    if (oldT.length > 0 || newT.length > 0) {
      return { removals: splitDiffLines(oldT), additions: splitDiffLines(newT) };
    }
  }

  const mr = input.multiStrReplace;
  if (mr?.edits && Array.isArray(mr.edits) && mr.edits.length > 0) {
    const removals = [];
    const additions = [];
    let wrote = false;
    mr.edits.forEach((ed) => {
      const o = typeof ed?.oldText === 'string' ? ed.oldText : '';
      const n = typeof ed?.newText === 'string' ? ed.newText : '';
      if (!o && !n) return;
      if (wrote) {
        removals.push('');
        additions.push('· · ·');
      }
      removals.push(...splitDiffLines(o));
      additions.push(...splitDiffLines(n));
      wrote = true;
    });
    if (wrote) return { removals, additions };
  }

  const ap = input.applyPatch;
  if (
    ap &&
    typeof ap === 'object' &&
    typeof ap.patchContent === 'string' &&
    ap.patchContent.trim()
  ) {
    return parseApplyPatchContent(ap.patchContent);
  }

  return null;
}

/**
 * Parse tool input into diff lines for display.
 * Returns { filePath, action, removals, additions }.
 */
export function parseDiffLines(tool, input) {
  if (input?.changes && Array.isArray(input.changes)) {
    return parseCodexFileChanges(input.changes);
  }

  const filePath = input?.file_path || input?.path || '';
  const action = tool === 'Edit' ? 'Update' : 'Create';

  let removals = [];
  let additions = [];

  if (tool === 'Edit') {
    const cursor = parseCursorEditStrategies(input);
    if (cursor) {
      removals = cursor.removals;
      additions = cursor.additions;
    } else if (typeof input?.unified_diff === 'string' && input.unified_diff.trim()) {
      const u = parseApplyPatchContent(input.unified_diff);
      removals = u.removals;
      additions = u.additions;
    } else {
      const old = input?.old_string ?? input?.oldString ?? '';
      const replacement = input?.new_string ?? input?.newString ?? '';
      removals = splitDiffLines(old);
      additions = splitDiffLines(replacement);
    }
  } else if (tool === 'Write') {
    const content = input?.content ?? input?.fileText ?? input?.contents ?? '';
    const lines = splitDiffLines(content);
    // For Write, show first 20 lines to keep it compact
    additions = lines.slice(0, 20);
    if (lines.length > 20) {
      additions.push(`… +${lines.length - 20} more lines`);
    }
  }

  return { filePath, action, removals, additions };
}

/** True when parseDiffLines produced at least one non-blank line to render. */
export function diffHasDisplayableLines(tool, input) {
  const { removals, additions } = parseDiffLines(tool, input);
  return removals.some((l) => l.trim()) || additions.some((l) => l.trim());
}

/**
 * True when this is a `Write` call whose content/fileText/contents is the
 * explicit empty string `""` (model intentionally created or cleared a file
 * with no body). Lets DiffView distinguish "legit empty file" from "Edit
 * with no diff content yet" so the placeholder text reflects reality.
 *
 * Returns false when the field is `undefined`/missing — that's the "args
 * not yet arrived" case the standard `Diff content pending or unavailable`
 * placeholder still applies to.
 */
export function isExplicitEmptyWrite(tool, input) {
  if (tool !== 'Write' || !input || typeof input !== 'object') return false;
  const fields = ['content', 'fileText', 'contents'];
  for (const k of fields) {
    if (k in input && input[k] === '') return true;
  }
  return false;
}
