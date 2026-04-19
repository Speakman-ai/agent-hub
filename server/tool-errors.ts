/**
 * TOOL_ERROR aggregation — parses self-reported tool error lines out of the
 * project's daily notes so they can be surfaced in the Settings UI (and,
 * later, the Session Health dashboard).
 *
 * Two on-wire formats are supported during the transition window — see
 * `server/default-skills/agent-hub/references/errors.md` for the full spec.
 *
 *   v1 (legacy, 6 pipe-delimited fields):
 *     TOOL_ERROR | <ts> | <tool> | <action> | <exit> | <summary>
 *
 *   v2 (6 fields + JSON tail as the 7th field):
 *     TOOL_ERROR | <ts> | <tool> | <action> | <exit> | <summary> | {"v":2,...}
 *
 * The v2 JSON tail is opt-in and carries structured fields (`sev`,
 * `resolution`, `session`, `agent`, `attempt`, `tags`, `card`, `pr`) that
 * agents used to smuggle into the free-text `summary`. v1 lines parse to the
 * same `ToolError` shape with those fields set to sensible defaults
 * (`sev="blocked"`, `resolution="unresolved"`, version tag `1`) so the UI
 * doesn't need a separate code path.
 *
 * The writer script (`log-tool-error.sh`) sanitises `|` and newlines in
 * caller-supplied fields, so the split-on-`|` here is safe for those
 * positional fields. The JSON tail may contain `|` inside string values, so
 * we peel it off before splitting — see `splitLineFields` below.
 *
 * Daily-note files live at `<project.ahw>/memory/<YYYY-MM-DD>.md` and may
 * contain zero or more `## HH:MM` sections, each of which may contain a
 * TOOL_ERROR line inside a fenced code block.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

/**
 * Severity bucket — does this error block progress, was it absorbed, or is it
 * a repeat-retry signal? Agents writing v1 lines default to `"blocked"` to
 * match the historical "only log blocking failures" convention.
 */
export type ToolErrorSeverity = 'blocked' | 'soft' | 'retry' | 'unknown';

/** Terminal disposition of the failure when it was logged. */
export type ToolErrorResolution =
  | 'unresolved'
  | 'recovered'
  | 'escalated'
  | 'duplicate'
  | 'preexisting'
  | 'unknown';

/**
 * Optional structured metadata carried in the v2 JSON tail. All fields are
 * additive — future versions can keep introducing keys without another
 * wire-format migration. Unknown keys are preserved on `extras`.
 */
export interface ToolErrorMeta {
  /** Wire-format version — `1` for legacy lines, `2` for JSON-tail lines. */
  v: 1 | 2;
  /** Severity bucket; defaults to `"blocked"` on v1 lines. */
  sev: ToolErrorSeverity;
  /** Resolution state when the line was written; defaults to `"unresolved"`. */
  resolution: ToolErrorResolution;
  /** Session id that hit the error, if the agent chose to correlate it. */
  session?: string;
  /** Agent slug that logged the error. */
  agent?: string;
  /** Retry attempt counter — supports the "3+ retries" escalation rule. */
  attempt?: number;
  /** Freeform tag list for ad-hoc cohorting (e.g. `["ci","deploy"]`). */
  tags?: string[];
  /** Kanban card id this error is scoped to. */
  card?: string;
  /** PR URL this error is scoped to. */
  pr?: string;
  /** Unknown JSON-tail keys preserved verbatim so they don't get dropped. */
  extras?: Record<string, unknown>;
}

export interface ToolError {
  /** ISO-8601 timestamp as emitted by the log script (UTC). */
  timestamp: string;
  /** Tool name (e.g. "Bash", "Read", "Edit"). */
  tool: string;
  /** Caller-supplied action / command summary. */
  action: string;
  /** Exit code or error type string (e.g. "exit 1", "ENOENT"). */
  errorType: string;
  /** One-line human-readable summary (never includes the v2 JSON tail). */
  summary: string;
  /** Structured v2 metadata; synthesised with defaults for v1 lines. */
  meta: ToolErrorMeta;
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
  /** New in v2 — distribution across severity buckets. */
  countsBySeverity: Record<string, number>;
  /** New in v2 — distribution across resolution states. */
  countsByResolution: Record<string, number>;
  /** New in v2 — distribution across wire-format versions (1 vs 2). */
  countsByVersion: Record<string, number>;
}

const VALID_SEVERITIES: ReadonlySet<ToolErrorSeverity> = new Set([
  'blocked',
  'soft',
  'retry',
  'unknown',
]);

const VALID_RESOLUTIONS: ReadonlySet<ToolErrorResolution> = new Set([
  'unresolved',
  'recovered',
  'escalated',
  'duplicate',
  'preexisting',
  'unknown',
]);

/**
 * Default metadata for a v1 line — conservative (treat as a blocker, no known
 * resolution) so historical aggregates don't suddenly lean "recovered" just
 * because the field is absent.
 */
function defaultV1Meta(): ToolErrorMeta {
  return { v: 1, sev: 'blocked', resolution: 'unresolved' };
}

/**
 * Split a TOOL_ERROR line into its positional fields while treating a
 * balanced JSON object at the tail as a single atomic field (so `|` inside
 * JSON strings doesn't shred the line).
 *
 * Strategy: locate the 6th `|` (the delimiter after the 6 positional
 * fields), then look for the first `{` in the remainder. If the substring
 * from that `{` to the line end parses as valid JSON we treat it as the
 * optional 7th field. This handles both nested JSON objects (e.g.
 * `{"v":2,"extras":{"a":1}}`) and `|` characters inside JSON string
 * values — neither `lastIndexOf("{")` nor `lastIndexOf("|")` alone
 * would get both right.
 */
function splitLineFields(line: string): { fields: string[]; jsonTail: string | null } {
  // Find the position of the 6th `|` — after TOOL_ERROR, ts, tool, action,
  // exit, and summary. Everything beyond it is either absent (v1) or the
  // JSON tail (v2, which may contain `|` inside string values).
  let pipeCount = 0;
  let sixthPipeAt = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      pipeCount++;
      if (pipeCount === 6) {
        sixthPipeAt = i;
        break;
      }
    }
  }

  if (sixthPipeAt < 0) {
    // Fewer than 6 pipes — plain v1 line (or malformed), split normally.
    return { fields: line.split('|').map((p) => p.trim()), jsonTail: null };
  }

  const afterSixthPipe = line.slice(sixthPipeAt + 1);
  const braceOffset = afterSixthPipe.indexOf('{');
  if (braceOffset < 0) {
    // No brace after the 6th pipe — extra summary text, no JSON tail.
    return { fields: line.split('|').map((p) => p.trim()), jsonTail: null };
  }

  const braceAt = sixthPipeAt + 1 + braceOffset;
  const tailCandidate = line.slice(braceAt).trim();
  if (!tailCandidate.endsWith('}')) {
    return { fields: line.split('|').map((p) => p.trim()), jsonTail: null };
  }

  try {
    JSON.parse(tailCandidate);
  } catch {
    return { fields: line.split('|').map((p) => p.trim()), jsonTail: null };
  }

  // Valid JSON tail — the 6 positional fields are everything before the
  // 6th pipe.
  const fields = line
    .slice(0, sixthPipeAt)
    .split('|')
    .map((p) => p.trim());
  return { fields, jsonTail: tailCandidate };
}

/**
 * Normalise a parsed JSON tail into a `ToolErrorMeta`. Unknown keys survive
 * on `extras` so we don't silently drop data an agent bothered to record.
 * Bad values for known enums collapse to `"unknown"` rather than throwing —
 * a malformed tail shouldn't evict the whole line from aggregates.
 */
export function parseMetaFromJsonTail(jsonTail: string): ToolErrorMeta {
  const meta = defaultV1Meta();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonTail);
  } catch {
    return meta;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return meta;
  const obj = parsed as Record<string, unknown>;

  // Presence of a valid object tail implies v2 intent, so default to 2
  // when `v` is absent. Non-object tails (arrays, primitives) bail out
  // above and return v1 defaults — that asymmetry is intentional.
  meta.v = obj.v === 2 ? 2 : obj.v === 1 ? 1 : 2;
  if (typeof obj.sev === 'string' && VALID_SEVERITIES.has(obj.sev as ToolErrorSeverity)) {
    meta.sev = obj.sev as ToolErrorSeverity;
  } else if (obj.sev !== undefined) {
    meta.sev = 'unknown';
  }
  if (
    typeof obj.resolution === 'string' &&
    VALID_RESOLUTIONS.has(obj.resolution as ToolErrorResolution)
  ) {
    meta.resolution = obj.resolution as ToolErrorResolution;
  } else if (obj.resolution !== undefined) {
    meta.resolution = 'unknown';
  }
  if (typeof obj.session === 'string') meta.session = obj.session;
  if (typeof obj.agent === 'string') meta.agent = obj.agent;
  if (typeof obj.attempt === 'number' && Number.isFinite(obj.attempt)) {
    meta.attempt = obj.attempt;
  }
  if (Array.isArray(obj.tags)) {
    meta.tags = obj.tags.filter((t): t is string => typeof t === 'string');
  }
  if (typeof obj.card === 'string') meta.card = obj.card;
  if (typeof obj.pr === 'string') meta.pr = obj.pr;

  const known = new Set([
    'v',
    'sev',
    'resolution',
    'session',
    'agent',
    'attempt',
    'tags',
    'card',
    'pr',
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) extras[k] = v;
  }
  if (Object.keys(extras).length > 0) meta.extras = extras;

  return meta;
}

const TOOL_ERROR_LINE_RE = /^TOOL_ERROR\s*\|/;

/**
 * Parse TOOL_ERROR lines out of a single daily-note markdown string. The
 * `date` argument is tagged onto every matched line so callers can aggregate
 * across multiple days without re-deriving the date from the path.
 *
 * Accepts both v1 (6 fields) and v2 (6 fields + JSON tail) lines. Lines that
 * don't have at least 6 positional fields are skipped silently — malformed
 * lines are out of scope. We log nothing because the caller is a read
 * endpoint and we don't want log spam on every request.
 */
export function parseToolErrorsFromNote(content: string, date: string): ToolError[] {
  const results: ToolError[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!TOOL_ERROR_LINE_RE.test(line)) continue;

    const { fields, jsonTail } = splitLineFields(line);
    if (fields.length < 6) continue;

    // fields[0] === "TOOL_ERROR"
    const [, timestamp, tool, action, errorType, ...rest] = fields;
    // Join any trailing pipes back into summary as a defence-in-depth even
    // though the writer sanitises them. This keeps late changes to the writer
    // from silently truncating output here.
    const summary = rest.join(' | ');
    if (!timestamp || !tool || !summary) continue;

    const meta = jsonTail ? parseMetaFromJsonTail(jsonTail) : defaultV1Meta();
    results.push({
      timestamp,
      tool,
      action,
      errorType,
      summary,
      meta,
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
    countsBySeverity: {},
    countsByResolution: {},
    countsByVersion: {},
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
  const countsBySeverity: Record<string, number> = {};
  const countsByResolution: Record<string, number> = {};
  const countsByVersion: Record<string, number> = {};
  for (const e of all) {
    countsByTool[e.tool] = (countsByTool[e.tool] ?? 0) + 1;
    countsByErrorType[e.errorType] = (countsByErrorType[e.errorType] ?? 0) + 1;
    countsByDate[e.date] = (countsByDate[e.date] ?? 0) + 1;
    countsBySeverity[e.meta.sev] = (countsBySeverity[e.meta.sev] ?? 0) + 1;
    countsByResolution[e.meta.resolution] = (countsByResolution[e.meta.resolution] ?? 0) + 1;
    const vKey = `v${e.meta.v}`;
    countsByVersion[vKey] = (countsByVersion[vKey] ?? 0) + 1;
  }

  return {
    since,
    total: all.length,
    errors: all,
    countsByTool,
    countsByErrorType,
    countsByDate,
    countsBySeverity,
    countsByResolution,
    countsByVersion,
  };
}
