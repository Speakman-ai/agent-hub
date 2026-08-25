// Pure helpers for the mobile Security screen's automatic-scan schedule control.
// Mirrors client/src/utils/securitySchedule.ts (web parity).
//
// The server persists a per-project `securityScan` config
// (`{ onPush?: boolean; schedule?: 'off' | 'daily' | 'weekly' }`) that the
// scheduled scanner reads: `off` opts out, `daily`/`weekly` set the cadence, and
// an UNSET schedule falls back to the Hub's default baseline (documented
// `weekly`). The UI only writes the three explicit values.

export type SecurityScanSchedule = 'off' | 'daily' | 'weekly';

export const SECURITY_SCHEDULE_OPTIONS: { value: SecurityScanSchedule; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'off', label: 'Off' },
];

export interface SecurityScheduleConfig {
  /** Persisted cadence, or '' when unset. */
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
 * An unset or unrecognised schedule becomes ''; `onPush` is coerced to a strict
 * boolean (defaults to false).
 */
export function readSecurityScheduleConfig(project: unknown): SecurityScheduleConfig {
  const raw = (project as { securityScan?: unknown } | null | undefined)?.securityScan as
    | { schedule?: unknown; onPush?: unknown }
    | null
    | undefined;
  const schedule = isSecurityScanSchedule(raw?.schedule)
    ? (raw!.schedule as SecurityScanSchedule)
    : '';
  return { schedule, onPush: raw?.onPush === true };
}

/**
 * Build the `securityScan` PATCH body for the FULL intended UI state (defensive
 * against the server ever replacing the object wholesale instead of merging).
 * The placeholder schedule ('' = unset) is omitted — the server only accepts
 * 'off' | 'daily' | 'weekly'. Mirrors the web helper.
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
 * Next config for a schedule change, or `null` when it's a no-op (unchanged or
 * not one of the three server-accepted cadences). Mirrors the web helper.
 */
export function nextScheduleConfig(
  config: SecurityScheduleConfig,
  value: string,
): SecurityScheduleConfig | null {
  if (!isSecurityScanSchedule(value) || value === config.schedule) return null;
  return { ...config, schedule: value };
}
