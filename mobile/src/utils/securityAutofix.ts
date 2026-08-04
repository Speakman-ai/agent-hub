// Pure helpers for the mobile Security screen's "fix findings automatically"
// control. Mirrors client/src/utils/securityAutofix.ts (web parity).
//
// The server persists a per-project `securityAutoPr` block
// (`{ enabled?: boolean; autoMerge?: boolean; actorUserId?: string }`). When
// `enabled` is set, every scan that surfaces new or reopened findings — the
// manual Rescan, the daily/weekly scheduled scan, and the on-push scan —
// dispatches an agent session to resolve them. `autoMerge` decides how far the
// session's Finalize pipeline goes on its own: off stops at an open pull
// request for a human, on lets the fix land unattended.
//
// The UI collapses those two booleans into one three-way choice, because
// `autoMerge` without `enabled` is meaningless (nothing dispatches to merge).

export type SecurityAutofixMode = 'off' | 'pr' | 'merge';

export interface SecurityAutofixConfig {
  enabled: boolean;
  autoMerge: boolean;
}

// Order is user-facing: opt-out first, then increasing autonomy.
export const SECURITY_AUTOFIX_OPTIONS: {
  value: SecurityAutofixMode;
  label: string;
  title: string;
}[] = [
  {
    value: 'off',
    label: 'Off',
    title: 'Scans only report findings. Use Autofix or Fix to resolve them by hand.',
  },
  {
    value: 'pr',
    label: 'Open PR',
    title:
      'Every scan that finds something new starts a session to fix it, then opens a pull request for review.',
  },
  {
    value: 'merge',
    label: 'Auto-merge',
    title:
      'Every scan that finds something new starts a session to fix it, opens a pull request, and merges it automatically once checks pass.',
  },
];

/** Read the persisted `securityAutoPr` block off a project record into UI state. */
export function readSecurityAutofixConfig(project: unknown): SecurityAutofixConfig {
  const raw = (project as { securityAutoPr?: unknown } | null | undefined)?.securityAutoPr as
    | { enabled?: unknown; autoMerge?: unknown }
    | null
    | undefined;
  return { enabled: raw?.enabled === true, autoMerge: raw?.autoMerge === true };
}

/**
 * Collapse the two persisted booleans into the single UI choice. `autoMerge`
 * without `enabled` is treated as off — the merge flag can only take effect
 * through a dispatched fix session.
 */
export function securityAutofixMode(config: SecurityAutofixConfig): SecurityAutofixMode {
  if (!config.enabled) return 'off';
  return config.autoMerge ? 'merge' : 'pr';
}

export function isSecurityAutofixMode(value: unknown): value is SecurityAutofixMode {
  return value === 'off' || value === 'pr' || value === 'merge';
}

/**
 * Build the `securityAutoPr` PATCH body for a chosen mode. Both keys are always
 * sent so switching Auto-merge → Open PR actually clears the merge flag (the
 * server deep-merges, so an omitted key would keep its old value).
 *
 * `actorUserId` is deliberately NOT sent: the server defaults the unattended
 * automation actor to the Admin making this request when the project has none.
 */
export function buildSecurityAutofixPatch(mode: SecurityAutofixMode): {
  enabled: boolean;
  autoMerge: boolean;
} {
  return { enabled: mode !== 'off', autoMerge: mode === 'merge' };
}

/** Next config for a mode change, or `null` when it's a no-op (unchanged / invalid). */
export function nextAutofixConfig(
  config: SecurityAutofixConfig,
  value: string,
): SecurityAutofixConfig | null {
  if (!isSecurityAutofixMode(value) || value === securityAutofixMode(config)) return null;
  return { enabled: value !== 'off', autoMerge: value === 'merge' };
}
