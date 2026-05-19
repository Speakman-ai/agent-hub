/**
 * Mobile twin of `client/src/utils/diff.js`.
 *
 * Pure, dependency-free helpers for rendering compact inline diffs for
 * file-modifying tools (Edit, Write) in the chat stream. Kept in sync with
 * the web util so both clients produce the same structure.
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
 * Codex `file_change` tool_use input — see `client/src/utils/diff.js`.
 * @param {Array<{ path?: string, kind?: string, unified_diff?: string, content?: string }>} changes
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
    if (typeof c?.unified_diff === 'string' && c.unified_diff.trim()) {
      const parsed = parseApplyPatchContent(c.unified_diff);
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
    action: multi ? 'Patch' : changes[0]?.kind === 'add' ? 'Create' : changes[0]?.kind === 'delete' ? 'Delete' : 'Update',
    removals,
    additions,
  };
}

function parseApplyPatchContent(patch) {
  if (typeof patch !== 'string' || !patch.trim()) {
    return { removals: [], additions: [] };
  }
  const removals = [];
  const additions = [];
  for (const rawLine of patch.split('\n')) {
    if (rawLine.startsWith('diff --git')) continue;
    if (rawLine.startsWith('index ')) continue;
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) continue;
    if (rawLine.startsWith('@@')) continue;
    if (rawLine === '\\ No newline at end of file') continue;
    if (rawLine.startsWith('-')) {
      removals.push(rawLine.slice(1));
    } else if (rawLine.startsWith('+')) {
      additions.push(rawLine.slice(1));
    }
  }
  if (removals.length === 0 && additions.length === 0) {
    const raw = patch.trim().split('\n');
    return { removals: [], additions: raw.length ? raw : ['(empty patch)'] };
  }
  return { removals, additions };
}

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
  if (ap && typeof ap === 'object' && typeof ap.patchContent === 'string' && ap.patchContent.trim()) {
    return parseApplyPatchContent(ap.patchContent);
  }

  return null;
}

/**
 * Parse tool input into diff lines for display.
 * Returns { filePath, action, removals, additions }.
 *
 * Edit: old_string → removals, new_string → additions.
 * Write: content → additions (truncated to 20 lines for mobile).
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
    additions = lines.slice(0, 20);
    if (lines.length > 20) {
      additions.push(`… +${lines.length - 20} more lines`);
    }
  }

  return { filePath, action, removals, additions };
}

export function diffHasDisplayableLines(tool, input) {
  const { removals, additions } = parseDiffLines(tool, input);
  return removals.some((l) => l.trim()) || additions.some((l) => l.trim());
}

/**
 * Kept in sync with `client/src/utils/diff.js`. Returns true only when this
 * is a `Write` tool call whose body field is exactly the empty string —
 * "create/clear an empty file" vs. "args haven't arrived yet". Drives the
 * placeholder copy in DiffView so Write of `""` is not misreported as
 * "pending or unavailable".
 */
export function isExplicitEmptyWrite(tool, input) {
  if (tool !== 'Write' || !input || typeof input !== 'object') return false;
  const fields = ['content', 'fileText', 'contents'];
  for (const k of fields) {
    if (k in input && input[k] === '') return true;
  }
  return false;
}
