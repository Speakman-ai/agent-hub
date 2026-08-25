/**
 * commitDiff.js — split a unified diff into per-file sections (mobile).
 * Mirrors client/src/utils/commitDiff.js.
 */
function filenameFromHeader(headerLine: any) {
  const m = headerLine.match(/^diff --git a\/(.*) b\/(.*)$/);
  if (!m) return headerLine.replace(/^diff --git\s*/, '');
  return m[1] === m[2] ? m[2] : `${m[1]} → ${m[2]}`;
}
export function splitUnifiedDiff(patch: any) {
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
  return sections.filter((s: any) => s.filename || s.lines.some((l: any) => l.trim()));
}
