/**
 * Pattern-aware fix dispatch — detect a reviewer finding cluster that recurs
 * across consecutive review rounds so the fix-dispatch prompt can escalate from
 * "address these lines" to "fix the root cause".
 *
 * The reviewer-thread rows are wiped and rewritten every review pass (the
 * dispatch body reflects the CURRENT pass only), so cross-round recurrence
 * cannot be read back from the DB. The orchestrator accumulates each round's
 * findings in-memory for the life of one run's fix loop and hands the history
 * here. This module is pure — no I/O — so it is unit-testable in isolation.
 *
 * A "cluster" is keyed by file path: the reviewer anchors every finding to a
 * file, and the failure mode this targets (one root-cause defect flagged at N
 * call sites in the same file/area over N rounds) is exactly a file that keeps
 * reappearing round after round.
 */

/** One reviewer thread, trimmed to the fields the tracker needs. */
export interface ReviewFinding {
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  body: string;
}

/** One review round's findings, in chronological order (latest round last). */
export interface ReviewRoundFindings {
  round: number;
  findings: ReviewFinding[];
}

export interface RootCauseEscalation {
  /** Recurring cluster keys (file paths), most-recently-flagged first. */
  clusters: string[];
  /** How many consecutive most-recent rounds the cluster(s) recurred. */
  rounds: number;
  /**
   * Formatted findings from the PRIOR rounds (every round except the latest)
   * for the recurring clusters — so the fix turn sees the whole pattern, not
   * just the current round's notes.
   */
  priorFindings: string[];
}

export const DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS = 2;

/**
 * Consecutive-round threshold for root-cause escalation. Default 2 (a cluster
 * flagged this round and the immediately previous round escalates). Override
 * with `FINALIZE_ROOTCAUSE_ESCALATION_ROUNDS` (integer ≥ 2; blank/invalid falls
 * back to the default). Read at call time so ops/tests can tune it.
 */
export function resolveRootCauseEscalationRounds(): number {
  const raw = process.env.FINALIZE_ROOTCAUSE_ESCALATION_ROUNDS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 2 && String(n) === raw) return n;
  }
  return DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS;
}

function clusterKey(finding: ReviewFinding): string {
  return (finding.file_path ?? '').trim();
}

/** Cluster keys present in a round (deduped, blanks dropped). */
function clustersInRound(round: ReviewRoundFindings): Set<string> {
  const set = new Set<string>();
  for (const f of round.findings) {
    const key = clusterKey(f);
    if (key) set.add(key);
  }
  return set;
}

function formatFinding(round: number, f: ReviewFinding): string {
  const start = f.line_start;
  const end = f.line_end;
  const loc =
    start != null && end != null && end !== start
      ? `${f.file_path}:${start}-${end}`
      : start != null
        ? `${f.file_path}:${start}`
        : f.file_path;
  const body = (f.body ?? '').replace(/\s+/g, ' ').trim();
  const snippet = body.length > 240 ? `${body.slice(0, 240)}…` : body;
  return `- round ${round}: ${loc} — ${snippet}`;
}

/**
 * Given the chronological review-round history (latest round last), return a
 * root-cause escalation when one or more clusters have been flagged for at
 * least `minConsecutiveRounds` consecutive most-recent rounds, else null.
 */
export function computeRootCauseEscalation(
  history: readonly ReviewRoundFindings[],
  minConsecutiveRounds: number = DEFAULT_ROOTCAUSE_ESCALATION_ROUNDS,
): RootCauseEscalation | null {
  const threshold = Math.max(2, Math.floor(minConsecutiveRounds));
  if (history.length < threshold) return null;

  const perRoundClusters = history.map(clustersInRound);
  const latestIdx = history.length - 1;
  const latest = perRoundClusters[latestIdx];

  // For each cluster in the latest round, count the consecutive most-recent
  // rounds (ending at the latest) that also contain it.
  const recurring: Array<{ cluster: string; streak: number }> = [];
  for (const cluster of latest) {
    let streak = 0;
    for (let i = latestIdx; i >= 0; i--) {
      if (perRoundClusters[i].has(cluster)) streak += 1;
      else break;
    }
    if (streak >= threshold) recurring.push({ cluster, streak });
  }
  if (recurring.length === 0) return null;

  // Report the longest streak among the recurring clusters.
  const rounds = recurring.reduce((max, r) => Math.max(max, r.streak), 0);
  const clusters = recurring.map((r) => r.cluster);
  const clusterSet = new Set(clusters);

  // Prior-round findings for the recurring clusters (every round except the
  // latest), oldest first, so the fix turn sees the whole pattern.
  const priorFindings: string[] = [];
  for (let i = 0; i < latestIdx; i++) {
    const r = history[i];
    for (const f of r.findings) {
      if (clusterSet.has(clusterKey(f))) priorFindings.push(formatFinding(r.round, f));
    }
  }

  return { clusters, rounds, priorFindings };
}
