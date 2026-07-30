/**
 * run-summary-data.ts — pure shaping for the end-of-run Finalize summary.
 *
 * Kept free of git, DB, and network calls so the collection rules (which review
 * rounds count, how findings are clipped, what the markdown body reads like) are
 * unit-testable on plain values.
 *
 * Review history comes from the append-only `finalize_review_round` timeline
 * messages rather than `reviewer_threads`, because the orchestrator calls
 * `deleteReviewerThreadsForRun` between rounds — by the time a run reaches
 * ready-to-push the table only holds the final (usually empty) pass. The
 * timeline is the durable record of what the reviewer actually raised.
 */

import { NO_COMMITS_MESSAGE } from '../../shared/utils/finalizeSummaryCopy.js';
import { parseFinalizeTimelineMetadata } from './timeline-message.js';

/** Cap on findings kept per round — a 200-finding round is a wall, not a summary. */
export const MAX_FINDINGS_PER_ROUND = 25;
/** Cap on a single finding body in the persisted payload. */
export const MAX_FINDING_BODY_LEN = 800;
/** Cap on commit subjects kept in the persisted payload. */
export const MAX_COMMIT_SUBJECTS = 40;

export interface FinalizeReviewFinding {
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
}

export interface FinalizeReviewRoundSummary {
  round: number;
  verdict: string;
  findings: FinalizeReviewFinding[];
  /** Findings dropped by {@link MAX_FINDINGS_PER_ROUND}. */
  truncatedFindings: number;
}

export interface DiffStatTotals {
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

/** Minimal shape of a message row this module reads. */
export interface TimelineMessageLike {
  metadata?: string | null;
}

function clip(raw: string, max: number): string {
  const trimmed = raw.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function toNullableInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function normalizeFinding(raw: unknown): FinalizeReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const filePathRaw = t.file_path ?? t.filePath;
  const body = typeof t.body === 'string' ? t.body.trim() : '';
  if (!body) return null;
  return {
    filePath: typeof filePathRaw === 'string' && filePathRaw ? filePathRaw : '(unknown)',
    lineStart: toNullableInt(t.line_start ?? t.lineStart),
    lineEnd: toNullableInt(t.line_end ?? t.lineEnd),
    body: clip(body, MAX_FINDING_BODY_LEN),
  };
}

/**
 * Pull every review round this run went through out of the session's timeline
 * messages, oldest round first.
 *
 * A round number can legitimately repeat (a re-review after a fix turn writes a
 * fresh message for the same loop round); the later message wins, since it
 * reflects the reviewer's final position on that round.
 */
export function collectFinalizeReviewRounds(
  messages: readonly TimelineMessageLike[],
  runId: string,
): FinalizeReviewRoundSummary[] {
  const byRound = new Map<number, FinalizeReviewRoundSummary>();

  for (const message of messages ?? []) {
    const parsed = parseFinalizeTimelineMetadata(message?.metadata);
    if (!parsed || parsed.kind !== 'finalize_review_round') continue;
    const payload = parsed.payload;
    const messageRunId = payload.runId ?? payload.run_id;
    if (typeof messageRunId !== 'string' || messageRunId !== runId) continue;

    const round = toNullableInt(payload.round) ?? 0;
    const rawThreads = Array.isArray(payload.threads) ? payload.threads : [];
    const findings: FinalizeReviewFinding[] = [];
    for (const thread of rawThreads) {
      const finding = normalizeFinding(thread);
      if (finding) findings.push(finding);
    }

    byRound.set(round, {
      round,
      verdict: typeof payload.verdict === 'string' ? payload.verdict : 'changes_requested',
      findings: findings.slice(0, MAX_FINDINGS_PER_ROUND),
      truncatedFindings: Math.max(0, findings.length - MAX_FINDINGS_PER_ROUND),
    });
  }

  return Array.from(byRound.values()).sort((a, b) => a.round - b.round);
}

/**
 * Parse the trailing totals line of `git diff --stat`
 * (` 3 files changed, 40 insertions(+), 2 deletions(-)`). Any field git omitted
 * (a pure-addition diff has no deletions clause) comes back as null.
 */
export function parseDiffStatTotals(diffStat: string | null | undefined): DiffStatTotals {
  const empty: DiffStatTotals = { filesChanged: null, insertions: null, deletions: null };
  if (!diffStat) return empty;
  const lines = diffStat
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last || !/\bfiles? changed\b/.test(last)) return empty;
  const num = (re: RegExp): number | null => {
    const m = last.match(re);
    return m ? Number.parseInt(m[1] as string, 10) : null;
  };
  return {
    filesChanged: num(/(\d+)\s+files? changed/),
    insertions: num(/(\d+)\s+insertions?\(\+\)/),
    deletions: num(/(\d+)\s+deletions?\(-\)/),
  };
}

export function formatFindingAnchor(finding: {
  lineStart: number | null;
  lineEnd: number | null;
}): string {
  if (finding.lineStart == null) return 'file-level';
  if (finding.lineEnd == null || finding.lineEnd === finding.lineStart) {
    return `L${finding.lineStart}`;
  }
  return `L${finding.lineStart}-${finding.lineEnd}`;
}

export interface FinalizeRunSummaryPayload {
  runId: string;
  round: number;
  headSha: string | null;
  /** Prose describing the change. Empty when no LLM narrative was available. */
  summary: string;
  /** Where {@link summary} came from — drives the "generated" hint client-side. */
  summarySource: 'llm' | 'none';
  /** Newest-first commit subjects. */
  commits: string[];
  /** Commits dropped by {@link MAX_COMMIT_SUBJECTS}. */
  truncatedCommits: number;
  diffStat: string;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  reviewRounds: FinalizeReviewRoundSummary[];
  /** Total findings the reviewer raised across every round. */
  totalFindings: number;
  /** Reviewer's final verdict, or null when the run never went through review. */
  finalVerdict: string | null;
  /** LLM prose on what the reviewer raised. Empty when unavailable. */
  reviewNotes: string;
  manualTesting: string[];
}

export interface BuildRunSummaryPayloadArgs {
  runId: string;
  round: number;
  headSha?: string | null;
  commits: readonly { subject: string }[];
  diffStat?: string | null;
  reviewRounds: readonly FinalizeReviewRoundSummary[];
  narrative?: { summary: string; reviewNotes: string; manualTesting: string[] } | null;
}

export function buildFinalizeRunSummaryPayload(
  args: BuildRunSummaryPayloadArgs,
): FinalizeRunSummaryPayload {
  const subjects = (args.commits ?? [])
    .map((c) => (typeof c?.subject === 'string' ? c.subject.trim() : ''))
    .filter(Boolean);
  const diffStat = (args.diffStat ?? '').trim();
  const totals = parseDiffStatTotals(diffStat);
  const rounds = [...(args.reviewRounds ?? [])];
  const totalFindings = rounds.reduce((sum, r) => sum + r.findings.length + r.truncatedFindings, 0);
  const summary = args.narrative?.summary?.trim() ?? '';

  return {
    runId: args.runId,
    round: args.round,
    headSha: args.headSha ?? null,
    summary,
    summarySource: summary ? 'llm' : 'none',
    commits: subjects.slice(0, MAX_COMMIT_SUBJECTS),
    truncatedCommits: Math.max(0, subjects.length - MAX_COMMIT_SUBJECTS),
    diffStat,
    filesChanged: totals.filesChanged,
    insertions: totals.insertions,
    deletions: totals.deletions,
    reviewRounds: rounds,
    totalFindings,
    finalVerdict: rounds.length ? (rounds[rounds.length - 1]?.verdict ?? null) : null,
    reviewNotes: args.narrative?.reviewNotes?.trim() ?? '',
    manualTesting: args.narrative?.manualTesting ?? [],
  };
}

/**
 * Markdown body stored as the message `content`.
 *
 * The web client renders the structured payload instead, but mobile and any
 * plain-text consumer (notifications, transcript export) only ever see this
 * string — so it has to carry the whole summary on its own.
 */
export function renderFinalizeRunSummaryMarkdown(payload: FinalizeRunSummaryPayload): string {
  const out: string[] = ['## Finalize summary'];

  if (payload.summary) out.push(payload.summary);

  out.push('### What changed');
  const statLine = [
    payload.filesChanged != null
      ? `${payload.filesChanged} file${payload.filesChanged === 1 ? '' : 's'} changed`
      : null,
    payload.insertions != null ? `+${payload.insertions}` : null,
    payload.deletions != null ? `-${payload.deletions}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  if (statLine) out.push(statLine);
  if (payload.commits.length) {
    const commitLines = payload.commits.map((s) => `- ${s}`);
    if (payload.truncatedCommits > 0) {
      commitLines.push(`- …and ${payload.truncatedCommits} more commit(s)`);
    }
    out.push(commitLines.join('\n'));
  } else {
    out.push(NO_COMMITS_MESSAGE);
  }

  out.push('### Review');
  if (payload.reviewRounds.length === 0) {
    out.push('No review rounds recorded for this run.');
  } else {
    if (payload.reviewNotes) out.push(payload.reviewNotes);
    const roundLines: string[] = [];
    for (const round of payload.reviewRounds) {
      const verdict = round.verdict === 'approved' ? 'approved' : 'changes requested';
      const count = round.findings.length + round.truncatedFindings;
      roundLines.push(
        `- Round ${round.round}: ${verdict} (${count} finding${count === 1 ? '' : 's'})`,
      );
      for (const finding of round.findings) {
        const body = finding.body.replace(/\n+/g, ' ');
        roundLines.push(`  - \`${finding.filePath}\` ${formatFindingAnchor(finding)}: ${body}`);
      }
      if (round.truncatedFindings > 0) {
        roundLines.push(`  - …and ${round.truncatedFindings} more finding(s)`);
      }
    }
    out.push(roundLines.join('\n'));
  }

  out.push('### Manual testing');
  out.push(
    payload.manualTesting.length
      ? payload.manualTesting.map((step) => `- [ ] ${step}`).join('\n')
      : 'No manual testing steps were generated for this change.',
  );

  return out.join('\n\n');
}
