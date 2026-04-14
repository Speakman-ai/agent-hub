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
 * Parse tool input into diff lines for display.
 * Returns { filePath, action, removals, additions }.
 */
export function parseDiffLines(tool, input) {
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
