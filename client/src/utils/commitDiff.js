/**
 * commitDiff.js — split a unified diff (git show / git diff output) into
 * per-file sections so the commit page can render one collapsible block
 * per file, GitHub-style. Pure string processing — trivial to unit test.
 */

/**
 * Extract the post-image path from a `diff --git a/<old> b/<new>` header.
 * Handles the common unquoted form and falls back to the raw header text
 * for exotic paths (quotes/renames keep enough context to be readable).
 * @param {string} headerLine
 * @returns {string}
 */
function filenameFromHeader(headerLine) {
  const m = headerLine.match(/^diff --git a\/(.*) b\/(.*)$/);
  if (!m) return headerLine.replace(/^diff --git\s*/, '');
  // Rename: show old → new; identical paths show once.
  return m[1] === m[2] ? m[2] : `${m[1]} → ${m[2]}`;
}

/**
 * Split a unified diff into per-file sections.
 * @param {string|null|undefined} patch
 * @returns {Array<{filename: string, additions: number, deletions: number,
 *                  isBinary: boolean, lines: string[]}>}
 */
export function splitUnifiedDiff(patch) {
  if (!patch || typeof patch !== 'string') return [];
  const sections = [];
  let current = null;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = {
        filename: filenameFromHeader(line),
        additions: 0,
        deletions: 0,
        isBinary: false,
        lines: [line],
      };
      sections.push(current);
      continue;
    }
    if (!current) {
      // Preamble before the first file header (e.g. merge-commit notes
      // from `git show -m`) — attach to a synthetic section so nothing
      // silently disappears.
      if (!line.trim()) continue;
      current = { filename: '', additions: 0, deletions: 0, isBinary: false, lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions += 1;
    }
  }

  // Drop a synthetic empty preamble section if it gathered nothing useful.
  return sections.filter((s) => s.filename || s.lines.some((l) => l.trim()));
}

/**
 * Annotate a file section's raw diff lines with old/new line numbers by
 * walking the `@@ -a,b +c,d @@` hunk headers — the anchor inline review
 * comments attach to.
 *
 * For each line:
 *   - context lines carry both `oldLine` and `newLine`
 *   - additions carry `newLine` only, deletions `oldLine` only
 *   - headers/hunks/meta lines carry neither (not commentable)
 *
 * @param {string[]} lines raw lines of ONE file section (from splitUnifiedDiff)
 * @returns {Array<{text: string, oldLine: number|null, newLine: number|null}>}
 */
export function annotateDiffLines(lines) {
  let oldLine = null;
  let newLine = null;
  const out = [];
  for (const text of lines || []) {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      out.push({ text, oldLine: null, newLine: null });
      continue;
    }
    if (oldLine === null || newLine === null) {
      out.push({ text, oldLine: null, newLine: null }); // pre-hunk meta
      continue;
    }
    if (text.startsWith('+') && !text.startsWith('+++')) {
      out.push({ text, oldLine: null, newLine });
      newLine += 1;
    } else if (text.startsWith('-') && !text.startsWith('---')) {
      out.push({ text, oldLine, newLine: null });
      oldLine += 1;
    } else if (text.startsWith('\\')) {
      out.push({ text, oldLine: null, newLine: null }); // "\ No newline at end of file"
    } else if (text.startsWith('+++') || text.startsWith('---')) {
      out.push({ text, oldLine: null, newLine: null });
    } else {
      out.push({ text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}
