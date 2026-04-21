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
 * array of `{ path, kind }` — no line-level hunks in the public stream today.
 * Show one row per file so the diff card is meaningful.
 *
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

  const rows = [];
  for (const c of changes) {
    const p = c?.path ?? '';
    const kind = String(c?.kind ?? '').toLowerCase();
    const label = kind === 'add' ? 'add' : kind === 'delete' ? 'delete' : 'update';
    if (typeof c?.unified_diff === 'string' && c.unified_diff.trim()) {
      rows.push(`${label}  ${p}`);
      for (const line of c.unified_diff.split('\n')) {
        rows.push(line);
      }
    } else if (typeof c?.content === 'string' && c.content.trim()) {
      rows.push(`${label}  ${p}`);
      for (const line of c.content.split('\n')) {
        rows.push(line);
      }
    } else {
      rows.push(
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
    removals: [],
    additions: rows,
  };
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
    const old = input?.old_string || '';
    const replacement = input?.new_string || '';
    removals = old.split('\n');
    additions = replacement.split('\n');
  } else if (tool === 'Write') {
    const content = input?.content || '';
    const lines = content.split('\n');
    // For Write, show first 20 lines to keep it compact
    additions = lines.slice(0, 20);
    if (lines.length > 20) {
      additions.push(`… +${lines.length - 20} more lines`);
    }
  }

  return { filePath, action, removals, additions };
}
