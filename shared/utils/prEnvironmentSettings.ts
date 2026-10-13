// Project settings list of PR environments: one row per environment with its
// status, age, last request, and whether Stop applies. Shared by web and mobile.

export interface PrEnvironmentListItem {
  id: string;
  prNumber: number;
  status: string;
  stopReason?: string | null;
  cleanupPending?: boolean;
  url?: string | null;
  headBranch?: string | null;
  createdAt: string;
  readyAt?: string | null;
  lastHitAt?: string | null;
}

export interface PrEnvironmentLimitsView {
  maxConcurrent: number;
  idleTtlMinutes: number;
  maxLifetimeDays: number;
}

export interface PrEnvironmentRowView {
  statusLabel: string;
  /** Tone for the status chip. */
  tone: 'ok' | 'busy' | 'error' | 'idle';
  /** How long since the environment was first created, e.g. "3d". */
  age: string;
  /** Time since the last request through its URL, or "never". */
  lastHit: string;
  /** Something is running, or a teardown is unconfirmed (Stop retries it). */
  canStop: boolean;
}

/** Compact duration: "now", "12m", "5h", "3d". */
export function formatShortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const STOPPED_LABELS: Record<string, string> = {
  idle: 'asleep',
  expired: 'expired',
  merged: 'merged',
  closed: 'closed',
  manual: 'stopped',
  no_preview_config: 'no preview',
};

export function prEnvironmentRowView(
  env: PrEnvironmentListItem,
  now: number,
): PrEnvironmentRowView {
  const since = (iso: string | null | undefined) =>
    iso ? formatShortDuration(now - Date.parse(iso)) : null;
  const cleanupPending = env.cleanupPending === true;
  let statusLabel = env.status;
  let tone: PrEnvironmentRowView['tone'] = 'idle';
  if (env.status === 'ready') tone = 'ok';
  else if (env.status === 'queued' || env.status === 'building') tone = 'busy';
  else if (env.status === 'failed') tone = 'error';
  else if (env.status === 'stopped') {
    statusLabel = STOPPED_LABELS[env.stopReason ?? ''] ?? 'stopped';
    if (cleanupPending) {
      statusLabel = 'teardown pending';
      tone = 'error';
    }
  }
  return {
    statusLabel,
    tone,
    age: since(env.createdAt) ?? 'now',
    lastHit: since(env.lastHitAt) ?? 'never',
    canStop: env.status !== 'stopped' || cleanupPending,
  };
}

/** One line describing the limits in effect. */
export function describePrEnvironmentLimits(l: PrEnvironmentLimitsView): string {
  const cap = l.maxConcurrent > 0 ? `at most ${l.maxConcurrent} running` : 'no cap';
  const idle =
    l.idleTtlMinutes > 0 ? `sleep after ${l.idleTtlMinutes} min idle` : 'never sleep when idle';
  const life =
    l.maxLifetimeDays > 0
      ? `stop after ${l.maxLifetimeDays} days without a push`
      : 'no max lifetime';
  return `${cap}, ${idle}, ${life}.`;
}

/**
 * The panel's summary line. Without wake-capable ingress (`wakeOnRequest`
 * false) the server does not enforce idle sleep, so say so instead of
 * promising a wake.
 */
export function prEnvironmentLimitsNote(data: {
  limits: PrEnvironmentLimitsView;
  enforced?: PrEnvironmentLimitsView;
  wakeOnRequest?: boolean;
}): string {
  const base = describePrEnvironmentLimits(data.enforced ?? data.limits);
  if (data.wakeOnRequest === false) {
    return `${base} Idle sleep is off on this Hub: without wildcard preview ingress nothing records requests or wakes a sleeping environment. A stopped one comes back with Start on its pull request.`;
  }
  return `${base} Opening the URL of an asleep environment starts it again.`;
}
