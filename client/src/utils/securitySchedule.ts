// Pure helpers for the Security page's automatic-scan schedule control.
//
// The server persists a per-project `securityScan` config
// (`{ onPush?: boolean; schedule?: 'off' | 'daily' | 'weekly' }`) and the
// scheduled scanner (server/security-audit/scheduled-scan.ts) reads it: an
// explicit `off` opts out, `daily`/`weekly` set the cadence, and an UNSET
// schedule falls back to the Hub's default baseline (documented `weekly`).
// The UI only writes the three explicit values; it never needs to clear the
// field, so "unset" is surfaced as a placeholder rather than a writable state.

export type SecurityScanSchedule = 'off' | 'daily' | 'weekly';

// Options rendered in the schedule <select>, most-frequent cadence first with
// the opt-out last. Order is user-facing.
export const SECURITY_SCHEDULE_OPTIONS: { value: SecurityScanSchedule; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'off', label: 'Off' },
];

export interface SecurityScheduleConfig {
  /** Persisted cadence, or '' when unset (rendered as the default placeholder). */
  schedule: SecurityScanSchedule | '';
  /** Whether push-triggered scanning is enabled. Defaults to false. */
  onPush: boolean;
}

/** Type guard for the three server-accepted schedule values. */
export function isSecurityScanSchedule(value: unknown): value is SecurityScanSchedule {
  return value === 'off' || value === 'daily' || value === 'weekly';
}

/**
 * Read the persisted `securityScan` block off a project record into UI state.
 * An unset or unrecognised schedule becomes '' (the "Default" placeholder);
 * `onPush` is coerced to a strict boolean (defaults to false).
 */
export function readSecurityScheduleConfig(project: unknown): SecurityScheduleConfig {
  const raw = (project as { securityScan?: unknown } | null | undefined)?.securityScan as
    | { schedule?: unknown; onPush?: unknown }
    | null
    | undefined;
  const schedule = isSecurityScanSchedule(raw?.schedule) ? raw!.schedule : '';
  return { schedule, onPush: raw?.onPush === true };
}

/**
 * Build the `securityScan` PATCH body for the FULL intended UI state, rather
 * than a single changed key. The server route (server/routes/projects.ts)
 * deep-merges the incoming object, so a partial patch is correct today — but
 * sending the complete `{ onPush, schedule }` is defensive against the route
 * ever switching to wholesale replacement (which would otherwise silently drop
 * the untouched key). The placeholder schedule ('' = unset) is omitted, because
 * the server only accepts 'off' | 'daily' | 'weekly'.
 */
export function buildSecurityScanPatch(config: SecurityScheduleConfig): {
  onPush: boolean;
  schedule?: SecurityScanSchedule;
} {
  return {
    onPush: config.onPush,
    ...(config.schedule ? { schedule: config.schedule } : {}),
  };
}

/**
 * Next config for a schedule-select change, or `null` when it's a no-op — the
 * value is unchanged or not one of the three server-accepted cadences (e.g. the
 * "Default" placeholder). Keeps the write path from firing a redundant PATCH.
 */
export function nextScheduleConfig(
  config: SecurityScheduleConfig,
  value: string,
): SecurityScheduleConfig | null {
  if (!isSecurityScanSchedule(value) || value === config.schedule) return null;
  return { ...config, schedule: value };
}
