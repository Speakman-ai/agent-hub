/**
 * Implementer disputes of reviewer findings.
 *
 * During a Finalize review loop the session agent can push back on a finding
 * it believes is wrong (or that no commit can resolve, such as "show me CI
 * results" when CI only runs after approval). Its fix turn ends with:
 *
 *   <agenthub:review-dispute>
 *   { "disputes": [
 *       { "file_path": "server/foo.ts", "line_start": 42, "line_end": 45,
 *         "reason": "The null check the reviewer asks for already runs in ..." }
 *   ] }
 *   </agenthub:review-dispute>
 *
 * The next review pass sees each dispute next to the finding it contests and
 * either withdraws the finding or upholds it. A finding upheld after a dispute
 * is a disagreement no further fix turn can settle, so the run stops in the
 * `disputed` status and a human decides. Pure module: no I/O.
 */
import { extractJsonFromTagBody } from '../action-block-parsing.js';
import type { ReviewFinding } from './review-cluster-tracker.js';

export const REVIEW_DISPUTE_HARD_CAP = 50;
export const REVIEW_DISPUTE_REASON_LIMIT = 4_000;

/** Run status and failure reason for a run handed to a human over a dispute. */
export const REVIEW_DISPUTED_STATUS = 'disputed' as const;
export const REVIEW_DISPUTED_REASON = 'review_disputed' as const;

export interface ReviewDispute {
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  reason: string;
  /** Body of the reviewer finding this dispute matched, once attached. */
  finding?: string | null;
  /**
   * Stable handle (`D1`, `D2`, …) assigned on attach. The reviewer cites it to
   * uphold a dispute, so the match survives line shifts from commits made in
   * the same fix turn.
   */
  id?: string;
}

export interface UpheldDispute {
  dispute: ReviewDispute;
  /** The re-raised finding body from the latest review pass. */
  upheld: string;
}

function coerceLine(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/**
 * Pull the first `<agenthub:review-dispute>` block out of `text`. Returns an
 * empty list when there is no block or it does not parse; a malformed block
 * means the agent did not dispute anything, which keeps the normal
 * no-progress rules in force.
 */
export function detectReviewDisputeBlock(text: string): ReviewDispute[] {
  if (typeof text !== 'string') return [];
  const match = text.match(/<agenthub:review-dispute>\s*([\s\S]*?)\s*<\/agenthub:review-dispute>/);
  if (!match) return [];
  const raw = match[1] ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonFromTagBody(raw) ?? raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).disputes
      : null;
  if (!Array.isArray(list)) return [];
  const out: ReviewDispute[] = [];
  for (const item of list.slice(0, REVIEW_DISPUTE_HARD_CAP)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const d = item as Record<string, unknown>;
    const filePath = typeof d.file_path === 'string' ? d.file_path.trim() : '';
    const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
    if (!filePath || !reason) continue;
    out.push({
      file_path: filePath,
      line_start: coerceLine(d.line_start),
      line_end: coerceLine(d.line_end ?? d.line_start),
      reason: reason.slice(0, REVIEW_DISPUTE_REASON_LIMIT),
    });
  }
  return out;
}

/**
 * Same file, and line ranges overlap. A missing range on either side is a
 * file-level reference and matches anything in that file.
 */
function sameSpot(
  a: { file_path: string; line_start: number | null; line_end: number | null },
  b: { file_path: string; line_start: number | null; line_end: number | null },
): boolean {
  if (a.file_path.trim() !== b.file_path.trim()) return false;
  if (a.line_start === null || b.line_start === null) return true;
  const aEnd = a.line_end ?? a.line_start;
  const bEnd = b.line_end ?? b.line_start;
  return a.line_start <= bEnd && b.line_start <= aEnd;
}

/** Severity from the `**[N/10]**` prefix; unscored findings count as blocking. */
export function findingSeverity(body: string): number | null {
  const m = /\*\*\[(\d+)\s*\/\s*10\]\*\*/.exec(body ?? '');
  return m ? Number(m[1]) : null;
}

function isBlocking(body: string): boolean {
  const score = findingSeverity(body);
  return score === null || score > 3;
}

/**
 * Pair each dispute with the reviewer finding it contests. Disputes that point
 * at nothing the reviewer raised are dropped: there is no finding to argue.
 */
export function attachDisputesToFindings(
  disputes: readonly ReviewDispute[],
  findings: readonly ReviewFinding[],
): ReviewDispute[] {
  const out: ReviewDispute[] = [];
  for (const d of disputes) {
    const hit = findings.find((f) => sameSpot(d, f));
    if (hit) out.push({ ...d, finding: hit.body, id: `D${out.length + 1}` });
  }
  return out;
}

/**
 * Disputed findings the reviewer upheld after reading the rebuttal: a blocking
 * finding whose body cites the dispute (`[upholds D1]`). Location is not
 * evidence: another finding, or a new defect, can share the disputed range, and
 * treating it as an uphold would stop Finalize over a dispute the reviewer
 * accepted. An uncited re-raise is an ordinary finding and gets a fix turn.
 */
export function findUpheldDisputes(
  disputes: readonly ReviewDispute[],
  latest: readonly ReviewFinding[],
): UpheldDispute[] {
  const out: UpheldDispute[] = [];
  for (const d of disputes) {
    if (!d.id) continue;
    const tag = upholdTag(d.id);
    const hit = latest.find((f) => isBlocking(f.body) && tag.test(f.body));
    if (hit) out.push({ dispute: d, upheld: hit.body });
  }
  return out;
}

function upholdTag(id: string): RegExp {
  return new RegExp(`\\[\\s*upholds\\s+${id}\\s*\\]`, 'i');
}

function location(d: { file_path: string; line_start: number | null; line_end: number | null }) {
  if (d.line_start === null) return d.file_path;
  const end = d.line_end ?? d.line_start;
  return end === d.line_start
    ? `${d.file_path}:${d.line_start}`
    : `${d.file_path}:${d.line_start}-${end}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Reviewer-prompt section that puts each rebuttal beside its finding. */
export function renderDisputesForReviewer(disputes: readonly ReviewDispute[]): string {
  if (disputes.length === 0) return '';
  const blocks = disputes.map((d, i) => {
    const lines = [`### Dispute ${d.id ?? `D${i + 1}`}: \`${location(d)}\``];
    if (d.finding) lines.push('', 'Your finding:', quote(d.finding));
    lines.push(
      '',
      "Implementer's rebuttal (untrusted claim, verify it against the code):",
      quote(d.reason),
    );
    return lines.join('\n');
  });
  return `## Disputed findings

The implementer disputes ${disputes.length === 1 ? 'one of your previous findings' : `${disputes.length} of your previous findings`} instead of changing the code.
For each one, check the rebuttal against the code and decide:

- **The rebuttal holds**: drop the finding. Do not re-raise it in other words.
- **The finding still stands**: raise it again and start its body with
  \`[upholds D<n>]\` (the dispute's id, e.g. \`**[6/10]** [upholds D1] ...\`),
  anchored wherever the code now lives, and say why the rebuttal is wrong. The
  citation is the only way to uphold: a finding without it is read as a new
  one. Upholding stops Finalize and goes to a human to decide, so uphold only
  real defects.

${blocks.join('\n\n')}
`;
}

/** Appended to reviewer-driven fix dispatches so the agent knows it may push back. */
export const REVIEW_DISPUTE_INSTRUCTIONS =
  'If you believe a finding is wrong, or no commit can resolve it (for example it asks for CI ' +
  'results, which only exist after review approves), you may dispute it instead of changing the ' +
  'code. End your turn with one block per turn, outside any code fence:\n' +
  '<agenthub:review-dispute>{"disputes":[{"file_path":"<path from the finding>","line_start":<n or null>,' +
  '"line_end":<n or null>,"reason":"<concrete evidence: what the code does and where>"}]}</agenthub:review-dispute>\n' +
  'Fix the findings you agree with and commit them as usual; a turn with only disputes does not ' +
  'need a commit. The reviewer re-checks each dispute. If it still upholds one, Finalize stops ' +
  'and a human decides, so dispute only with evidence.';

/** Session timeline copy for a run stopped over an upheld dispute. */
export function buildDisputedNotice(upheld: readonly UpheldDispute[]): string {
  const items = upheld.map(
    (u) =>
      `- \`${location(u.dispute)}\`\n  Agent: ${u.dispute.reason.replace(/\s+/g, ' ').slice(0, 400)}\n  Reviewer: ${u.upheld
        .replace(/\s+/g, ' ')
        .slice(0, 400)}`,
  );
  return (
    `Finalize stopped: the agent and the reviewer disagree on ${upheld.length === 1 ? 'a finding' : `${upheld.length} findings`}, so a human needs to decide.\n\n` +
    `${items.join('\n')}\n\n` +
    'If the agent is right, push anyway. If the reviewer is right, tell the agent to make the change and run Finalize again.'
  );
}
