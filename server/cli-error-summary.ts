// Concise classification + summarization of one-shot CLI failures.
//
// Why this exists:
//   The one-shot engines (Claude / Cursor / Codex / Gemini) reject with an
//   Error whose `.message` is the raw, multi-line stderr of the failed CLI.
//   For Gemini that blob includes a "256-color support not detected" warning,
//   a multi-frame stack trace, and gemini-cli's own top-level handler bug
//   that prints `An unexpected critical error occurred:[object Object]`.
//
//   Dumping that whole thing at `console.error` for a best-effort background
//   task (memory reconciliation, scheduled crons) is noisy and unactionable —
//   the operator can't act on a stack frame, and a transient free-tier quota
//   429 isn't an "error" worth alarming on.
//
//   This module turns that raw text into a small `{ kind, message }` record
//   so callers can (a) log a single concise line and (b) pick a log level
//   (rate-limit/quota → warn; everything else → error). It is intentionally
//   pure and dependency-free so it's trivially testable and reusable across
//   memory.ts / heartbeat.ts / cron paths.

export type CliErrorKind = 'rate_limit' | 'auth' | 'timeout' | 'not_found' | 'generic';

export interface CliErrorSummary {
  kind: CliErrorKind;
  /** A single-line, human-readable summary safe to log directly. */
  message: string;
}

/** Max length of the summary line so a runaway stderr can't flood logs. */
const MAX_SUMMARY_LEN = 240;

// Lines that carry no diagnostic value and should never be chosen as the
// summary (CLI cosmetic warnings, stack frames, gemini's `[object Object]`).
const NOISE_PATTERNS: RegExp[] = [
  /256-color support not detected/i,
  /Using a terminal with at least/i,
  /Full report available at/i,
  /^\s*at\s+/i, // V8 stack frame
  /An unexpected critical error occurred:\s*\[object Object\]/i,
  /head to:\s*https?:\/\//i,
  /For more information on this error/i,
  /To monitor your current usage/i,
];

function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

function clamp(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SUMMARY_LEN ? trimmed.slice(0, MAX_SUMMARY_LEN - 1) + '…' : trimmed;
}

/**
 * Pick the most useful single line from a noisy multi-line stderr blob:
 * the first non-empty line that isn't a known-noise pattern. Falls back to
 * the first non-empty line, then to a fixed string.
 */
function firstSignalLine(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const meaningful = lines.find((l) => l.trim() && !isNoise(l));
  if (meaningful) return clamp(meaningful);
  const anyLine = lines.find((l) => l.trim());
  return anyLine ? clamp(anyLine) : 'unknown CLI failure';
}

/**
 * Classify and summarize a one-shot CLI failure.
 *
 * `engine` is optional and only used to make the rate-limit message more
 * specific (e.g. "Gemini API quota/rate limit hit").
 */
export function summarizeCliError(
  raw: string | null | undefined,
  engine?: string,
): CliErrorSummary {
  const text = (raw ?? '').toString();
  const lower = text.toLowerCase();
  const who = engine ? `${engine} ` : '';

  // Rate limit / quota — the common, transient, non-alarming case.
  // Covers HTTP 429, Google's RESOURCE_EXHAUSTED / free-tier quota strings,
  // OpenAI/Anthropic "rate limit" phrasing, and Gemini's daily-quota error.
  const rateLimitSignals = [
    'code: 429',
    'status 429',
    '429 ',
    'resource_exhausted',
    'exceeded your current quota',
    'exhausted your daily quota',
    'quota exceeded',
    'rate limit',
    'rate-limit',
    'too many requests',
    'terminalquotaerror',
  ];
  if (rateLimitSignals.some((s) => lower.includes(s))) {
    return {
      kind: 'rate_limit',
      message:
        `${who}quota/rate limit hit (HTTP 429) — try again later or switch engine/model`.trim(),
    };
  }

  // Auth / credential failures.
  const authSignals = [
    'unauthorized',
    'authentication',
    'invalid api key',
    'api key not valid',
    'permission denied',
    'no-credentials',
    'not logged in',
    'forbidden',
    'status 401',
    'status 403',
  ];
  if (authSignals.some((s) => lower.includes(s))) {
    return {
      kind: 'auth',
      message: `${who}authentication failed — check credentials in Settings → Engines`.trim(),
    };
  }

  // Timeout.
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return { kind: 'timeout', message: clamp(firstSignalLine(text)) || `${who}timed out`.trim() };
  }

  // Missing binary / cwd.
  if (
    lower.includes('not found at') ||
    lower.includes('enoent') ||
    lower.includes('does not exist')
  ) {
    return { kind: 'not_found', message: firstSignalLine(text) };
  }

  return { kind: 'generic', message: firstSignalLine(text) };
}
