/**
 * TOOL_ERROR aggregation — parses self-reported tool error lines out of the
 * project's daily notes so they can be surfaced in the Settings UI (and,
 * later, the Session Health dashboard).
 *
 * Log line format (produced by `server/default-skills/agent-hub/scripts/log-tool-error.sh`):
 *
 *   TOOL_ERROR | <ISO timestamp> | <tool> | <action> | <exit> | <summary>
 *
 * The script sanitises `|` and newlines inside caller-supplied fields, so the
 * split-on-`|` here is safe. The daily-note files live at
 * `<project.ahw>/memory/<YYYY-MM-DD>.md` and may contain zero or more
 * `## HH:MM` sections, each of which may contain a TOOL_ERROR line inside a
 * fenced code block.
 *
 * This module is intentionally minimal — it is a stub for the future Session
 * Health epic. It does only two things: parse lines and aggregate counts.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

export interface ToolError {
  /** ISO-8601 timestamp as emitted by the log script (UTC). */
  timestamp: string;
  /** Tool name (e.g. "Bash", "Read", "Edit"). */
  tool: string;
  /** Caller-supplied action / command summary. */
  action: string;
  /** Exit code or error type string (e.g. "exit 1", "ENOENT"). */
  errorType: string;
  /** One-line human-readable summary. */
  summary: string;
  /** Date of the daily note the line was found in (YYYY-MM-DD). */
  date: string;
  /** Raw line as it appeared in the note (useful for debugging). */
  raw: string;
}

export interface ToolErrorAggregate {
  since: string | null;
  total: number;
  errors: ToolError[];
  countsByTool: Record<string, number>;
  countsByErrorType: Record<string, number>;
  countsByDate: Record<string, number>;
}

const TOOL_ERROR_LINE_RE = /^TOOL_ERROR\s*\|/;

/**
 * Parse TOOL_ERROR lines out of a single daily-note markdown string. The
 * `date` argument is tagged onto every matched line so callers can aggregate
 * across multiple days without re-deriving the date from the path.
 *
 * Lines that start with `TOOL_ERROR |` but don't have exactly six fields are
 * skipped silently — malformed lines are out of scope for this stub. We log
 * nothing because the caller is a read endpoint and we don't want log spam on
 * every request.
 */
export function parseToolErrorsFromNote(content: string, date: string): ToolError[] {
  const results: ToolError[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!TOOL_ERROR_LINE_RE.test(line)) continue;
    // Six pipe-delimited fields: TOOL_ERROR | ts | tool | action | exit | summary
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 6) continue;
    // parts[0] === "TOOL_ERROR"
    const [, timestamp, tool, action, errorType, ...rest] = parts;
    // Join any trailing pipes back into summary as a defence-in-depth even
    // though the writer sanitises them. This keeps late changes to the writer
    // from silently truncating output here.
    const summary = rest.join(' | ');
    if (!timestamp || !tool || !summary) continue;
    results.push({
      timestamp,
      tool,
      action,
      errorType,
      summary,
      date,
      raw: line,
    });
  }
  return results;
}

/**
 * Scan `<workspace>/memory/*.md` and parse every TOOL_ERROR line into a
 * structured aggregate. `since` (YYYY-MM-DD inclusive) filters daily-note
 * files before reading them, keeping the read amplification bounded even
 * when a project has years of notes.
 */
export function aggregateToolErrors(
  workspace: string | undefined,
  options: { since?: string } = {},
): ToolErrorAggregate {
  const empty: ToolErrorAggregate = {
    since: options.since ?? null,
    total: 0,
    errors: [],
    countsByTool: {},
    countsByErrorType: {},
    countsByDate: {},
  };
  if (!workspace) return empty;

  const memoryDir = path.join(workspace, 'memory');
  if (!existsSync(memoryDir)) return empty;

  let files: string[];
  try {
    files = readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  } catch {
    return empty;
  }

  const since = options.since ?? null;
  const relevant = since ? files.filter((f) => f.replace('.md', '') >= since) : files;
  relevant.sort();

  const all: ToolError[] = [];
  for (const file of relevant) {
    const date = file.replace('.md', '');
    try {
      const content = readFileSync(path.join(memoryDir, file), 'utf-8');
      all.push(...parseToolErrorsFromNote(content, date));
    } catch {
      // Skip unreadable files — don't let one bad note break the whole view.
    }
  }

  // Newest-first so the UI can slice a head without extra sorting.
  all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const countsByTool: Record<string, number> = {};
  const countsByErrorType: Record<string, number> = {};
  const countsByDate: Record<string, number> = {};
  for (const e of all) {
    countsByTool[e.tool] = (countsByTool[e.tool] ?? 0) + 1;
    countsByErrorType[e.errorType] = (countsByErrorType[e.errorType] ?? 0) + 1;
    countsByDate[e.date] = (countsByDate[e.date] ?? 0) + 1;
  }

  return {
    since,
    total: all.length,
    errors: all,
    countsByTool,
    countsByErrorType,
    countsByDate,
  };
}
