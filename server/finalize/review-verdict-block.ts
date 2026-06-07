/**
 * review-verdict-block.ts — parse the structured tail block the reviewer
 * agent emits at the end of its in-session review turn.
 *
 * Per the in-session reviewer design (wiki:
 * `finalize-code-changes-architecture-v0`, v1 in-session reviewer card):
 * the reviewer participates in the originating session as a read-only
 * advisor. Its assistant message ends with:
 *
 *   <agenthub:review-verdict>
 *   {
 *     "verdict": "approved" | "changes_requested",
 *     "threads": [
 *       { "file_path": "server/foo.ts", "line_start": 42, "line_end": 45,
 *         "body": "**[6/10]** ..." }
 *     ]
 *   }
 *   </agenthub:review-verdict>
 *
 * The prose ABOVE the block lands in the session timeline as the
 * reviewer's chat message (so a human can read + push back on it). The
 * block itself is parsed off the tail by the orchestrator and persisted
 * to `finalize_runs.reviewer_verdict` + `reviewer_threads`.
 *
 * Mirrors the shape of `<agenthub:close-card>`: same tolerant parser
 * (`extractJsonFromTagBody`), same "first balanced JSON wins" rule,
 * same first-block-only semantics. Only the schema differs — verdict +
 * threads instead of reason + note.
 *
 * Defensive contract: malformed payloads return `{ present: true, task: null,
 * reason: '<malformed-code>' }` rather than throwing. The reviewer-dispatch
 * helper turns a `null` task into a `review_failed` outcome (defensive —
 * a reviewer that emits an unparseable block should not silently approve).
 *
 * `threads` is hard-capped via {@link REVIEWER_THREAD_HARD_CAP_DEFAULT}
 * mirroring the cap in `reviewer-dispatch.ts`; bodies above
 * {@link REVIEWER_THREAD_BODY_LIMIT_DEFAULT} are truncated with the same
 * marker `[…N chars truncated]`. Truncation is silent — production
 * reviewers stay well below both limits; the cap exists only so a
 * misbehaving model can't blow up the side-panel UI.
 */
import {
  extractJsonFromTagBody,
  normalizeControlCharsInsideStrings,
  sliceFirstBalancedJson,
} from '../action-block-parsing.js';

/** Mirror of `reviewer-dispatch.REVIEWER_THREAD_HARD_CAP` — see that file. */
export const REVIEWER_THREAD_HARD_CAP_DEFAULT = 200;

/** Mirror of `reviewer-dispatch.REVIEWER_THREAD_BODY_LIMIT` — see that file. */
export const REVIEWER_THREAD_BODY_LIMIT_DEFAULT = 8_000;

export type ReviewVerdict = 'approved' | 'changes_requested';

export interface ReviewThreadInput {
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  body: string;
}

export interface ReviewVerdictTask {
  verdict: ReviewVerdict;
  threads: ReviewThreadInput[];
}

export type ReviewVerdictMalformedReason =
  | 'invalid-json'
  | 'not-object'
  | 'missing-verdict'
  | 'invalid-verdict'
  | 'missing-threads'
  | 'threads-not-array'
  | 'empty-thread-list-with-changes-requested-noop';

export interface ReviewVerdictDetectionResult {
  /** True iff a `<agenthub:review-verdict>` block (well-formed or not) was found. */
  present: boolean;
  /** Parsed task, or null when the block is malformed / absent. */
  task: ReviewVerdictTask | null;
  /** Why the parse failed, or null on success / absent. */
  reason: ReviewVerdictMalformedReason | null;
  /** Raw body between the tags, for error reporting. Null when absent. */
  rawBody: string | null;
}

/**
 * Extract a `<agenthub:review-verdict>...</agenthub:review-verdict>` block
 * from `text`. Returns `present: false` when no block is found.
 *
 * Tolerates fenced wrappers (```json ... ```), prose before/after the
 * JSON payload, and raw newlines inside string values — same surface as
 * the close-card / preview parsers.
 *
 * Only the FIRST block in `text` is considered. A reviewer that emits two
 * tails in one turn is a contract violation; the orchestrator gates on
 * the first one and ignores the rest.
 */
export function detectReviewVerdictBlock(text: string): ReviewVerdictDetectionResult {
  if (typeof text !== 'string') {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const match = text.match(/<agenthub:review-verdict>\s*([\s\S]*?)\s*<\/agenthub:review-verdict>/);
  if (match) {
    return parseReviewVerdictPayload(match[1] ?? '', { present: true });
  }

  const bare = findBareReviewVerdictTail(text);
  if (bare) {
    return parseReviewVerdictPayload(bare.rawBody, { present: true });
  }

  return { present: false, task: null, reason: null, rawBody: null };
}

function parseReviewVerdictPayload(
  rawBody: string,
  opts: { present: boolean },
): ReviewVerdictDetectionResult {
  const normalized = extractJsonFromTagBody(rawBody);
  let parsed: unknown;
  try {
    parsed = normalized === null ? JSON.parse(rawBody) : JSON.parse(normalized);
  } catch {
    return { present: opts.present, task: null, reason: 'invalid-json', rawBody };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: opts.present, task: null, reason: 'not-object', rawBody };
  }
  const obj = parsed as Record<string, unknown>;

  const rawVerdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
  if (!rawVerdict) {
    return { present: opts.present, task: null, reason: 'missing-verdict', rawBody };
  }
  let verdict: ReviewVerdict | null = null;
  if (rawVerdict === 'approved' || rawVerdict === 'approve') verdict = 'approved';
  else if (
    rawVerdict === 'changes_requested' ||
    rawVerdict === 'changes-requested' ||
    rawVerdict === 'request_changes' ||
    rawVerdict === 'request-changes' ||
    rawVerdict === 'rejected'
  )
    verdict = 'changes_requested';
  if (!verdict) {
    return { present: opts.present, task: null, reason: 'invalid-verdict', rawBody };
  }

  // `threads` is optional; default to []. Allowing absent means "approved
  // with nothing to flag" works as `{ "verdict": "approved" }`.
  let threads: ReviewThreadInput[] = [];
  if (obj.threads !== undefined && obj.threads !== null) {
    if (!Array.isArray(obj.threads)) {
      return { present: opts.present, task: null, reason: 'threads-not-array', rawBody };
    }
    threads = sanitiseThreadInputs(obj.threads as unknown[]);
  }

  return { present: opts.present, task: { verdict, threads }, reason: null, rawBody };
}

/**
 * Fallback when the reviewer omits `<agenthub:review-verdict>` tags but
 * still ends the turn with a trailing JSON object `{ "verdict": ... }`.
 * Common when models follow the prose + fenced-json pattern from the skill
 * prompt without wrapping the fence in the action block.
 */
function findBareReviewVerdictTail(text: string): { rawBody: string; startIndex: number } | null {
  const trimmed = text.trimEnd();

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenceMatch && fenceMatch.index != null) {
    const inner = fenceMatch[1] ?? '';
    const normalized = extractJsonFromTagBody(inner);
    if (normalized && hasVerdictField(normalized)) {
      return { rawBody: inner, startIndex: fenceMatch.index };
    }
  }

  for (
    let brace = trimmed.lastIndexOf('{');
    brace >= 0;
    brace = trimmed.lastIndexOf('{', brace - 1)
  ) {
    const tailSlice = trimmed.slice(brace);
    const balanced = sliceFirstBalancedJson(tailSlice);
    if (!balanced) continue;
    const endPos = brace + balanced.length;
    if (trimmed.slice(endPos).trim() !== '') continue;
    const normalized = normalizeControlCharsInsideStrings(balanced);
    if (!hasVerdictField(normalized)) continue;
    return { rawBody: balanced, startIndex: brace };
  }

  return null;
}

function hasVerdictField(jsonStr: string): boolean {
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).verdict === 'string'
    );
  } catch {
    return false;
  }
}

export function describeReviewVerdictReason(reason: ReviewVerdictMalformedReason): string {
  switch (reason) {
    case 'invalid-json':
      return 'Review-verdict block contains invalid JSON';
    case 'not-object':
      return 'Review-verdict block payload is not a JSON object';
    case 'missing-verdict':
      return 'Review-verdict block is missing the "verdict" field';
    case 'invalid-verdict':
      return 'Review-verdict block has an invalid "verdict" value';
    case 'missing-threads':
      return 'Review-verdict block is missing the "threads" field';
    case 'threads-not-array':
      return 'Review-verdict block "threads" is not an array';
    case 'empty-thread-list-with-changes-requested-noop':
      return 'Review-verdict block has changes_requested but no anchored findings';
    default:
      return 'Review-verdict block could not be parsed';
  }
}

/**
 * Drop blank-path / blank-body entries, coerce line numbers, truncate
 * over-long bodies, cap the total at {@link REVIEWER_THREAD_HARD_CAP_DEFAULT}.
 * Mirrors `reviewer-dispatch.sanitiseThreads` but lives here so the
 * parser is the single sanitisation surface for the reviewer's tail
 * block.
 *
 * Exported for tests; the production path threads through
 * {@link detectReviewVerdictBlock}.
 */
export function sanitiseThreadInputs(rawThreads: unknown[]): ReviewThreadInput[] {
  const out: ReviewThreadInput[] = [];
  for (const raw of rawThreads.slice(0, REVIEWER_THREAD_HARD_CAP_DEFAULT)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const t = raw as Record<string, unknown>;
    const filePath = typeof t.file_path === 'string' ? t.file_path.trim() : '';
    if (!filePath) continue;
    const bodyRaw = typeof t.body === 'string' ? t.body : '';
    if (!bodyRaw.trim()) continue;
    out.push({
      file_path: filePath,
      line_start: coerceLine(t.line_start),
      line_end: coerceLine(t.line_end),
      body: truncateBody(bodyRaw),
    });
  }
  return out;
}

function coerceLine(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

function truncateBody(body: string): string {
  if (body.length <= REVIEWER_THREAD_BODY_LIMIT_DEFAULT) return body;
  const head = body.slice(0, REVIEWER_THREAD_BODY_LIMIT_DEFAULT);
  const removed = body.length - REVIEWER_THREAD_BODY_LIMIT_DEFAULT;
  return `${head}\n\n[…${removed} chars truncated]`;
}

/**
 * Strip the trailing `<agenthub:review-verdict>` block (and any
 * surrounding whitespace) from `text`. Used when persisting the
 * reviewer's prose into the session — the structured block is
 * machine-only and would clutter the side-panel chat view if surfaced
 * verbatim.
 *
 * Idempotent: a text with no block returns unchanged. Strips only the
 * FIRST block to match `detectReviewVerdictBlock`'s semantics; if a
 * reviewer emits two we keep that as evidence of the contract violation
 * in the persisted chat message.
 */
export function stripReviewVerdictBlock(text: string): string {
  if (typeof text !== 'string') return text;
  const tagStripped = text.replace(
    /\s*<agenthub:review-verdict>\s*[\s\S]*?\s*<\/agenthub:review-verdict>\s*$/,
    '',
  );
  if (tagStripped !== text) return tagStripped.trim();

  const bare = findBareReviewVerdictTail(text);
  if (bare && bare.startIndex >= 0) {
    return text.trimEnd().slice(0, bare.startIndex).trimEnd();
  }
  return text;
}
