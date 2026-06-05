// Shared, framework-free session lifecycle state model. Imported by the server
// (`server/session-state.ts`) and the web client so the resolver and the
// per-state icon metadata never drift between surfaces. The mobile client is
// intended to consume this same module too, but its `SessionStateIcon` surface
// is a follow-up and is not wired up yet.

/**
 * Canonical pipeline order (early → late). Stable wire strings persisted in
 * `sessions.state` and sent over the `session_state` WebSocket event.
 * @type {readonly string[]}
 */
export const SESSION_STATES = [
  'waiting_for_user_input',
  'working',
  'running_tests',
  'reviewing',
  'pending_checks',
  'pending_push',
  'pushed',
  'merged',
];

export const DEFAULT_SESSION_STATE = 'waiting_for_user_input';

/**
 * @param {unknown} v
 * @returns {boolean}
 */
export function isSessionState(v) {
  return typeof v === 'string' && SESSION_STATES.includes(v);
}

/**
 * Map a Finalize-run status string (as produced by
 * `lookupFinalizeStatusForSession` — partial single-phase parks already arrive
 * as `checks_passed` / `review_passed`) to the session state it implies, or
 * `null` when it does not determine one (terminal-failure / unknown statuses,
 * which leave the session back in the user's court).
 *
 * @param {string | null | undefined} finalizeStatus
 * @returns {string | null}
 */
export function finalizeStatusToState(finalizeStatus) {
  if (!finalizeStatus) return null;
  switch (finalizeStatus) {
    case 'pushed':
      return 'pushed';
    case 'pushing':
    case 'ready_to_push':
      return 'pending_push';
    case 'running':
      return 'running_tests';
    case 'reviewing':
      return 'reviewing';
    case 'queued':
    case 'rebasing':
    case 'dispatching':
      return 'pending_checks';
    default:
      // `checks_passed` / `review_passed`: one phase passed, full validation
      // still pending → still in the checks pipeline.
      if (finalizeStatus.endsWith('_passed')) return 'pending_checks';
      // failed / timed_out / infra_error / cancelled / stalled_no_response: no
      // state of its own — caller falls through to working/waiting.
      return null;
  }
}

/**
 * Pure resolver: map raw signals to exactly one session state.
 *
 * Precedence is "live activity first, terminal marker last":
 *   in-progress Finalize phase ▸ working ▸ merged ▸ settled `pushed` ▸ waiting.
 *
 * `merged` (the linked card parked in a Done column) is a *sticky* terminal
 * marker — it stays true forever once work lands. So it must NOT mask a session
 * that has been reopened and is actively working or re-running Finalize;
 * live signals win. It does, however, outrank a settled `pushed` (merged is the
 * later terminal state in the pipeline: push → merge).
 *
 * @param {{ finalizeStatus?: string | null, hasActiveTask?: boolean, merged?: boolean }} signals
 * @returns {string}
 */
export function resolveSessionState(signals) {
  const fromFinalize = finalizeStatusToState(signals && signals.finalizeStatus);
  // An in-progress Finalize phase reflects what is happening right now.
  if (fromFinalize && fromFinalize !== 'pushed') return fromFinalize;
  // Live chat activity outranks the sticky terminal `merged` marker.
  if (signals && signals.hasActiveTask) return 'working';
  if (signals && signals.merged) return 'merged';
  // Settled push that hasn't merged yet.
  if (fromFinalize === 'pushed') return 'pushed';
  return DEFAULT_SESSION_STATE;
}

/**
 * Per-state UI metadata — the single source of truth for the always-on status
 * icon shared by web and mobile. `icon` is a lucide-react / lucide icon name;
 * `color` is a semantic token mapped to a Tailwind class per surface; `anim`
 * is `'spin' | 'pulse' | 'none'`.
 * @type {Record<string, { label: string, short: string, icon: string, color: string, anim: string }>}
 */
export const SESSION_STATE_META = {
  waiting_for_user_input: {
    label: 'Waiting for user input',
    short: 'Waiting',
    icon: 'MessageCircleQuestion',
    color: 'amber',
    anim: 'none',
  },
  working: {
    label: 'Working',
    short: 'Working',
    icon: 'Loader2',
    color: 'indigo',
    anim: 'spin',
  },
  running_tests: {
    label: 'Running tests',
    short: 'Tests',
    icon: 'FlaskConical',
    color: 'violet',
    anim: 'pulse',
  },
  reviewing: {
    label: 'Reviewing',
    short: 'Reviewing',
    icon: 'ScanEye',
    color: 'sky',
    anim: 'pulse',
  },
  pending_checks: {
    label: 'Pending checks',
    short: 'Checks',
    icon: 'Clock',
    color: 'slate',
    anim: 'none',
  },
  pending_push: {
    label: 'Pending push',
    short: 'Push',
    icon: 'ArrowUpCircle',
    color: 'amber',
    anim: 'none',
  },
  pushed: {
    label: 'Pushed',
    short: 'Pushed',
    icon: 'CloudUpload',
    color: 'teal',
    anim: 'none',
  },
  merged: {
    label: 'Merged',
    short: 'Merged',
    icon: 'GitMerge',
    color: 'emerald',
    anim: 'none',
  },
};

/**
 * Resolve the UI metadata for any state, defaulting unknown values to the
 * waiting state so the icon is *always* present.
 * @param {string | null | undefined} state
 * @returns {{ label: string, short: string, icon: string, color: string, anim: string }}
 */
export function sessionStateMeta(state) {
  return SESSION_STATE_META[state] || SESSION_STATE_META[DEFAULT_SESSION_STATE];
}
