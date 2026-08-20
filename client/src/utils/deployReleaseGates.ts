// Pure helpers for the per-environment release-gate surface. Framework-free so
// they can be unit-tested and mirrored by the mobile screen. Backend contract
// lives in server/deploy/deployment-release-gate-store.ts (selection limits) and
// the CRUD API in server/routes/deployments.ts.

export type ReleaseGateSelectionState = 'complete' | 'pending' | 'missing';
export type ReleaseGateStatus = 'armed' | 'fired' | 'failed';

export interface ReleaseGateSelectionStatus {
  id: string;
  state: ReleaseGateSelectionState;
}

export interface ReleaseGateProgress {
  sessions: ReleaseGateSelectionStatus[];
  epics: ReleaseGateSelectionStatus[];
  sessionsComplete: number;
  sessionsTotal: number;
  epicsComplete: number;
  epicsTotal: number;
  blocked: boolean;
  satisfied: boolean;
}

export interface DeployReleaseGate {
  id: string;
  projectId: string;
  environmentName: string;
  ref: string;
  sessionIds: string[];
  epicIds: string[];
  ownerUserId: string | null;
  status: ReleaseGateStatus;
  enabled: boolean;
  firedDeploymentId: string | null;
  lastError: string | null;
  resolvedAt: string | null;
  progress: ReleaseGateProgress;
  meta: unknown;
  createdAt: string;
  updatedAt: string;
}

// Mirror the store limits so the client can reject before the round-trip
// (server/deploy/deployment-release-gate-store.ts).
export const RELEASE_GATE_REF_MAX_LENGTH = 255;
export const RELEASE_GATE_MAX_SELECTIONS = 100;

/** Deploy ref used when the operator does not specify one (mirrors the store). */
export const RELEASE_GATE_DEFAULT_REF = 'main';

export interface ReleaseGateDraft {
  ref: string;
  sessionIds: string[];
  epicIds: string[];
}

/**
 * Stable display order: armed first (they still matter), then failed, then
 * fired; within a status, newest first. Keeps the list from reshuffling on a
 * toggle.
 */
const STATUS_ORDER: Record<ReleaseGateStatus, number> = { armed: 0, failed: 1, fired: 2 };
export function sortReleaseGates<T extends { status: ReleaseGateStatus; createdAt: string }>(
  gates: T[],
): T[] {
  return [...gates].sort((a, b) => {
    if (a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** Human sentence for a gate, e.g. "Deploy main when 2 sessions + 1 epic complete". */
export function describeReleaseGate(gate: {
  ref: string;
  sessionIds: string[];
  epicIds: string[];
}): string {
  const parts: string[] = [];
  if (gate.sessionIds.length) {
    parts.push(`${gate.sessionIds.length} session${gate.sessionIds.length === 1 ? '' : 's'}`);
  }
  if (gate.epicIds.length) {
    parts.push(`${gate.epicIds.length} epic${gate.epicIds.length === 1 ? '' : 's'}`);
  }
  const when = parts.length ? parts.join(' + ') : 'nothing';
  return `Deploy ${gate.ref} when ${when} complete`;
}

/** Short progress label for a gate, e.g. "2/3 sessions · 1/2 epics". */
export function describeReleaseGateProgress(progress: {
  sessionsComplete: number;
  sessionsTotal: number;
  epicsComplete: number;
  epicsTotal: number;
}): string {
  const bits: string[] = [];
  if (progress.sessionsTotal) {
    bits.push(`${progress.sessionsComplete}/${progress.sessionsTotal} sessions`);
  }
  if (progress.epicsTotal) {
    bits.push(`${progress.epicsComplete}/${progress.epicsTotal} epics`);
  }
  return bits.join(' · ');
}

/**
 * Validate a create/edit draft. Returns an error string for display, or null
 * when acceptable. Mirrors the store guards (≥1 selection, ref length, count
 * cap) so the UI fails fast without a server round-trip.
 */
export function validateReleaseGateDraft(draft: ReleaseGateDraft): string | null {
  const ref = draft.ref.trim();
  if (ref.length > RELEASE_GATE_REF_MAX_LENGTH) {
    return `Ref must be ${RELEASE_GATE_REF_MAX_LENGTH} characters or fewer.`;
  }
  const total = draft.sessionIds.length + draft.epicIds.length;
  if (total === 0) {
    return 'Select at least one session or epic.';
  }
  if (draft.sessionIds.length > RELEASE_GATE_MAX_SELECTIONS) {
    return `A gate may watch at most ${RELEASE_GATE_MAX_SELECTIONS} sessions.`;
  }
  if (draft.epicIds.length > RELEASE_GATE_MAX_SELECTIONS) {
    return `A gate may watch at most ${RELEASE_GATE_MAX_SELECTIONS} epics.`;
  }
  return null;
}

/** Normalize a draft's ref to what the store would persist (default when blank). */
export function normalizeReleaseGateRef(ref: string): string {
  return ref.trim() || RELEASE_GATE_DEFAULT_REF;
}
