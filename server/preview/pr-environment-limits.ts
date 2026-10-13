/**
 * Per-project cost controls for PR environments (pure).
 *
 * - `maxConcurrent`: live environments (queued, building, ready) a project may
 *   hold. Starting one more stops the least recently used live one first.
 * - `idleTtlMinutes`: a ready environment nobody has requested for this long
 *   is stopped as `idle`. The next request to its URL wakes it.
 * - `maxLifetimeDays`: an environment whose PR head has not moved for this
 *   long is stopped as `expired` and is not woken by requests. A push (or a
 *   manual start) brings it back.
 *
 * `0` turns a control off. Stored on the project as `prEnvironmentLimits`;
 * unset fields use the defaults below.
 */
import { z } from 'zod';

export interface PrEnvironmentLimits {
  maxConcurrent: number;
  idleTtlMinutes: number;
  maxLifetimeDays: number;
}

export const DEFAULT_PR_ENVIRONMENT_LIMITS: PrEnvironmentLimits = {
  maxConcurrent: 5,
  idleTtlMinutes: 60,
  maxLifetimeDays: 14,
};

/** Bounds; 0 always means "off". The idle floor matches the 5-minute sweep. */
export const PR_ENVIRONMENT_LIMIT_BOUNDS = {
  maxConcurrent: { min: 1, max: 100 },
  idleTtlMinutes: { min: 5, max: 7 * 24 * 60 },
  maxLifetimeDays: { min: 1, max: 365 },
} as const;

function limitField(key: keyof PrEnvironmentLimits) {
  const { min, max } = PR_ENVIRONMENT_LIMIT_BOUNDS[key];
  return z
    .number()
    .int()
    .refine((n) => n === 0 || (n >= min && n <= max), {
      message: `${key} must be 0 (off) or an integer between ${min} and ${max}`,
    });
}

/** What a project stores. `null` on a field resets it to the default. */
export const PrEnvironmentLimitsPatchSchema = z
  .object({
    maxConcurrent: limitField('maxConcurrent').nullable().optional(),
    idleTtlMinutes: limitField('idleTtlMinutes').nullable().optional(),
    maxLifetimeDays: limitField('maxLifetimeDays').nullable().optional(),
  })
  .strict();

export type PrEnvironmentLimitsPatch = z.infer<typeof PrEnvironmentLimitsPatchSchema>;
export type StoredPrEnvironmentLimits = Partial<PrEnvironmentLimits>;

/** Apply a validated patch to the stored overrides. Returns null when nothing is overridden. */
export function applyPrEnvironmentLimitsPatch(
  stored: StoredPrEnvironmentLimits | null | undefined,
  patch: PrEnvironmentLimitsPatch,
): StoredPrEnvironmentLimits | null {
  const next: StoredPrEnvironmentLimits = { ...(stored ?? {}) };
  for (const key of Object.keys(patch) as Array<keyof PrEnvironmentLimits>) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) delete next[key];
    else next[key] = v;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function valid(key: keyof PrEnvironmentLimits, raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw === 0) return 0;
  const { min, max } = PR_ENVIRONMENT_LIMIT_BOUNDS[key];
  return raw >= min && raw <= max ? raw : null;
}

/** Effective limits for a project. A stored value out of bounds falls back to the default. */
export function resolvePrEnvironmentLimits(
  project: { prEnvironmentLimits?: unknown } | null | undefined,
): PrEnvironmentLimits {
  const stored =
    project?.prEnvironmentLimits && typeof project.prEnvironmentLimits === 'object'
      ? (project.prEnvironmentLimits as Record<string, unknown>)
      : {};
  const out = { ...DEFAULT_PR_ENVIRONMENT_LIMITS };
  for (const key of Object.keys(out) as Array<keyof PrEnvironmentLimits>) {
    const v = valid(key, stored[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

/**
 * The limits actually enforced. Idle sleep only makes sense when a request
 * can wake the environment, which needs the wildcard ingress (the proxy
 * records hits and wakes). Without it clients use the direct upstream URL,
 * which nobody observes, so idle sleep is off; the cap and max lifetime
 * still apply (a stopped env comes back with Start on the PR page).
 */
export function enforcedPrEnvironmentLimits(
  limits: PrEnvironmentLimits,
  wakeOnRequest: boolean,
): PrEnvironmentLimits {
  return wakeOnRequest ? limits : { ...limits, idleTtlMinutes: 0 };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** What the sweep and admission need to know about one environment. */
export interface PrEnvironmentUsage {
  id: string;
  status: 'queued' | 'building' | 'ready' | 'failed' | 'stopped';
  stopReason: string | null;
  cleanupPending: boolean;
  createdAt: number;
  readyAt: number | null;
  lastHitAt: number | null;
  /** When the lifetime clock last restarted: created, head moved, or started manually. */
  renewedAt: number;
}

export function isLive(env: Pick<PrEnvironmentUsage, 'status'>): boolean {
  return env.status === 'queued' || env.status === 'building' || env.status === 'ready';
}

/** Last sign of use: a proxied request, else the moment it became ready, else creation. */
export function lastActivityAt(env: PrEnvironmentUsage): number {
  return Math.max(env.lastHitAt ?? 0, env.readyAt ?? 0, env.createdAt);
}

/** Neither the PR head nor a manual start renewed it within the max lifetime. */
export function isExpired(
  env: PrEnvironmentUsage,
  limits: PrEnvironmentLimits,
  now: number,
): boolean {
  return limits.maxLifetimeDays > 0 && now - env.renewedAt >= limits.maxLifetimeDays * DAY;
}

/** A ready environment with no requests within the idle TTL. */
export function isIdle(env: PrEnvironmentUsage, limits: PrEnvironmentLimits, now: number): boolean {
  return (
    limits.idleTtlMinutes > 0 &&
    env.status === 'ready' &&
    now - lastActivityAt(env) >= limits.idleTtlMinutes * MINUTE
  );
}

/**
 * Which live environments to stop so at most `keep` remain. Ready ones go
 * first, least recently used first; a build in flight is only stopped when
 * there are not enough ready ones (stopping it wastes the work done so far).
 */
export function selectEvictions(live: PrEnvironmentUsage[], keep: number): PrEnvironmentUsage[] {
  const over = live.length - Math.max(0, keep);
  if (over <= 0) return [];
  const ranked = [...live].sort((a, b) => {
    const ra = a.status === 'ready' ? 0 : 1;
    const rb = b.status === 'ready' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const d = lastActivityAt(a) - lastActivityAt(b);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  return ranked.slice(0, over);
}

/** `action` is the stop to apply; `reason` is why it was planned. */
export type PrEnvironmentSweepAction = {
  id: string;
  action: 'idle' | 'expire';
  reason: 'expired' | 'idle' | 'cap';
};

/**
 * One sweep over a project's environments: expire stale ones, put idle ones
 * to sleep, then stop the least recently used until the cap holds.
 */
export function planPrEnvironmentSweep(
  envs: PrEnvironmentUsage[],
  limits: PrEnvironmentLimits,
  now: number,
): PrEnvironmentSweepAction[] {
  const actions: PrEnvironmentSweepAction[] = [];
  const stopped = new Set<string>();
  for (const env of envs) {
    if (env.status === 'stopped' && env.stopReason === 'idle') {
      // Asleep and stale: stop answering wake requests.
      if (isExpired(env, limits, now)) {
        actions.push({ id: env.id, action: 'expire', reason: 'expired' });
      }
      continue;
    }
    if (!isLive(env)) continue;
    if (isExpired(env, limits, now)) {
      actions.push({ id: env.id, action: 'expire', reason: 'expired' });
      stopped.add(env.id);
    } else if (isIdle(env, limits, now)) {
      actions.push({ id: env.id, action: 'idle', reason: 'idle' });
      stopped.add(env.id);
    }
  }
  if (limits.maxConcurrent > 0) {
    const remaining = envs.filter((e) => isLive(e) && !stopped.has(e.id));
    for (const e of selectEvictions(remaining, limits.maxConcurrent)) {
      actions.push({ id: e.id, action: 'idle', reason: 'cap' });
    }
  }
  return actions;
}
