/**
 * quarantine.ts — Finalize flaky-test quarantine lane (pure logic).
 *
 * The industry-standard alternative to silent retry-until-green: when a job
 * instance is flaky, instead of blocking the whole gate (the flake-recovery
 * gate's withhold-automation behaviour) you QUARANTINE that specific instance.
 * A quarantined instance still RUNS every round (so it keeps producing
 * monitoring data), but its failure / flake recovery no longer blocks the
 * gate. Quarantine is time-bounded (≤30 days) and carries a named owner so it
 * cannot become a permanent escape hatch — an expired entry is surfaced as
 * "overdue" until a human renews or removes it.
 *
 * This module owns the time math + the gate-excusal decision; the DB layer
 * (`finalize_quarantine` table) and the orchestrator wiring live elsewhere.
 */

import type { FlakeGateResult, JobFlakeVerdict } from './flake-recovery.js';

/** Hard ceiling on quarantine duration. Industry guidance: never open-ended. */
export const QUARANTINE_MAX_DAYS = 30;
/** Default quarantine duration when the caller does not specify one. */
export const QUARANTINE_DEFAULT_DAYS = 30;
/** Milliseconds in a day. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Clamp a requested quarantine duration to the allowed range. A missing /
 * non-finite / non-positive value falls back to {@link QUARANTINE_DEFAULT_DAYS};
 * anything above {@link QUARANTINE_MAX_DAYS} is capped. Fractional days are
 * floored so the expiry math stays on whole-day boundaries. The cap is a hard
 * invariant: the gate must never honour a quarantine that outlives the policy.
 */
export function clampQuarantineDays(days?: number | null): number {
  if (days == null || !Number.isFinite(days) || days <= 0) return QUARANTINE_DEFAULT_DAYS;
  return Math.min(Math.floor(days), QUARANTINE_MAX_DAYS);
}

/** Compute an expiry timestamp from a start time + (already-clamped) day count. */
export function computeExpiry(quarantinedAtMs: number, days: number): number {
  return quarantinedAtMs + clampQuarantineDays(days) * DAY_MS;
}

/** One quarantine-lane entry (a `finalize_quarantine` row, normalised). */
export interface QuarantineEntry {
  id: string;
  projectId: string;
  jobId: string;
  matrixKey: string;
  owner: string;
  reason: string | null;
  quarantinedAt: number;
  expiresAt: number;
  createdBy: string | null;
}

export type QuarantineStatus = 'active' | 'overdue';

/**
 * Status of a quarantine entry relative to `nowMs`:
 *   - `active`  — not yet expired; the gate excuses this instance.
 *   - `overdue` — past its expiry but still in the table; the gate NO LONGER
 *                 excuses it (fail-closed: an expired quarantine must not keep
 *                 laundering a flake), and it is surfaced for human action.
 */
export function quarantineStatus(entry: QuarantineEntry, nowMs: number): QuarantineStatus {
  return nowMs < entry.expiresAt ? 'active' : 'overdue';
}

/** True iff the entry is currently active (not expired). */
export function isQuarantineActive(entry: QuarantineEntry, nowMs: number): boolean {
  return quarantineStatus(entry, nowMs) === 'active';
}

/** Whole days (rounded toward zero, can be negative) until the entry expires. */
export function daysUntilExpiry(entry: QuarantineEntry, nowMs: number): number {
  return Math.trunc((entry.expiresAt - nowMs) / DAY_MS);
}

/** Split entries into active vs overdue buckets at `nowMs`. */
export function partitionQuarantine(
  entries: QuarantineEntry[],
  nowMs: number,
): { active: QuarantineEntry[]; overdue: QuarantineEntry[] } {
  const active: QuarantineEntry[] = [];
  const overdue: QuarantineEntry[] = [];
  for (const e of entries) {
    if (isQuarantineActive(e, nowMs)) active.push(e);
    else overdue.push(e);
  }
  return { active, overdue };
}

function sameInstance(entry: QuarantineEntry, jobId: string, matrixKey: string): boolean {
  return entry.jobId === jobId && entry.matrixKey === (matrixKey ?? '');
}

/**
 * Find the ACTIVE quarantine entry covering a given job instance, or null.
 * Overdue (expired) entries never match — they no longer excuse the instance.
 */
export function findActiveQuarantineForInstance(
  entries: QuarantineEntry[],
  jobId: string,
  matrixKey: string,
  nowMs: number,
): QuarantineEntry | null {
  for (const e of entries) {
    if (sameInstance(e, jobId, matrixKey) && isQuarantineActive(e, nowMs)) return e;
  }
  return null;
}

/** Is a job instance currently covered by an active quarantine? */
export function isInstanceQuarantined(
  entries: QuarantineEntry[],
  jobId: string,
  matrixKey: string,
  nowMs: number,
): boolean {
  return findActiveQuarantineForInstance(entries, jobId, matrixKey, nowMs) != null;
}

/** Outcome of {@link applyQuarantineToGate}. */
export interface QuarantinedGate {
  /**
   * The gate result after excusing quarantined instances. A
   * `flake_recovered` gate whose every flagged instance is quarantined is
   * downgraded to `clean` (automation proceeds). A `blocked` gate is NEVER
   * downgraded — `blocked` means classification could not be performed, so
   * there is no per-instance verdict a quarantine could excuse.
   */
  gate: FlakeGateResult;
  /** The flake-recovered verdicts that an active quarantine excused. */
  excused: JobFlakeVerdict[];
}

/**
 * Apply the quarantine lane to a flake-recovery gate result — the heart of
 * "replace silent retry with quarantine". Previously every `flake_recovered`
 * job withheld push automation. Now a flagged instance that is under an active
 * quarantine is EXCUSED: it still ran and its result was recorded for
 * monitoring, but it no longer blocks the gate.
 *
 *   - `flake_recovered` → remove excused instances from `jobs`. If none
 *     remain, the gate becomes `clean`; otherwise it stays `flake_recovered`
 *     with only the non-quarantined offenders.
 *   - `clean` / `blocked` → returned unchanged (nothing to excuse). `blocked`
 *     stays fail-closed.
 *
 * Pure: the caller loads the entries + supplies `nowMs`.
 */
export function applyQuarantineToGate(
  gate: FlakeGateResult,
  entries: QuarantineEntry[],
  nowMs: number,
): QuarantinedGate {
  if (gate.status !== 'flake_recovered') return { gate, excused: [] };

  const excused: JobFlakeVerdict[] = [];
  const remaining: JobFlakeVerdict[] = [];
  for (const v of gate.jobs) {
    if (isInstanceQuarantined(entries, v.jobId, v.matrixKey, nowMs)) excused.push(v);
    else remaining.push(v);
  }

  if (remaining.length === 0) {
    return { gate: { status: 'clean', jobs: [] }, excused };
  }
  return { gate: { status: 'flake_recovered', jobs: remaining }, excused };
}

/** One-line human summary of the entries an active quarantine excused. */
export function describeExcused(excused: JobFlakeVerdict[]): string {
  if (excused.length === 0) return 'no quarantined jobs excused';
  return excused.map((v) => (v.matrixKey ? `${v.jobId} [${v.matrixKey}]` : v.jobId)).join(', ');
}
