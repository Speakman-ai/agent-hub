import { SESSION_CONTROL_OPTIONS } from './finalizeAutomation';

/**
 * Modes a background agent's session may start in. Mirrors
 * `BACKGROUND_SESSION_MODES` in server/background-agent-session.ts: the
 * session-control picker minus Design (needs a ready worktree) and VM (needs
 * Firecracker).
 */
export const BACKGROUND_SESSION_MODE_VALUES = [
  'manual',
  'review',
  'push',
  'merge',
  'consult',
  'scoping',
  'skill-builder',
  'autopilot',
];

const WORKFLOW_MODES = new Set(['consult', 'scoping', 'skill-builder']);

export const DEFAULT_BACKGROUND_SESSION_MODE = 'manual';
export const DEFAULT_WORKFLOW_BACKGROUND_SESSION_MODE = 'consult';

const INELIGIBLE_ROLES = new Set(['reviewer', 'docs', 'hub-assistant', 'skill-builder']);

export function backgroundSessionModeOptions(project: { mode?: string } | null | undefined) {
  const allowed =
    project?.mode === 'workflow'
      ? BACKGROUND_SESSION_MODE_VALUES.filter((v) => WORKFLOW_MODES.has(v))
      : BACKGROUND_SESSION_MODE_VALUES;
  return allowed
    .map((v) => SESSION_CONTROL_OPTIONS.find((o: any) => o.value === v))
    .filter(Boolean) as Array<{ value: string; label: string; description: string }>;
}

export function defaultBackgroundSessionMode(project: { mode?: string } | null | undefined) {
  return project?.mode === 'workflow'
    ? DEFAULT_WORKFLOW_BACKGROUND_SESSION_MODE
    : DEFAULT_BACKGROUND_SESSION_MODE;
}

/** Project agents that can host a background session (no docs/reviewer/etc). */
export function backgroundSessionAgents(project: { agents?: any[] } | null | undefined): any[] {
  return (project?.agents || []).filter(
    (a: any) =>
      a &&
      !INELIGIBLE_ROLES.has(
        String(a.role || '')
          .trim()
          .toLowerCase(),
      ),
  );
}
