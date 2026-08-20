/**
 * Session mode — the user-selectable "what is this session for" dimension that
 * sits alongside `ask_mode` and `finalize_automation`.
 *
 * Background: Agent Hub's chat-mode controls historically meant two things:
 *   - `ask_mode` (read-only / plan) vs. normal build, and
 *   - the Finalize automation level (manual / review / push / merge).
 *
 * This module introduces a first-class **session mode** so "Design" can fold
 * into the same picker as the other modes instead of living in the standalone
 * Design Studio subsystem (separate `designs` table + `design:<id>` pseudo
 * sessions). A session in `design` mode runs in its own worktree, loads the
 * `design` skill, and produces the same HTML/CSS/JS artifacts the standalone
 * studio did — only now the artifacts live in the session worktree, so flipping
 * back to `chat` mode hands them to the build flow for free (same checkout).
 *
 * Scope of THIS module: the canonical value list, validation/normalization, and
 * a derived "is design behavior active" predicate. Spawn wiring (skill + system
 * prompt), the canvas pane, mobile/Electron parity, and the Design Studio
 * migration are tracked as separate follow-up cards — see the architecture spec
 * `design-mode-fold-into-session-mode-picker`.
 *
 * Storage: `sessions.session_mode TEXT NOT NULL DEFAULT 'chat'`. Pure
 * functions only here so they unit-test without a DB.
 */

/** Canonical, ordered list of session modes. Order is display order. */
export const SESSION_MODES = [
  'chat',
  'isolated',
  'design',
  'scoping',
  'skill-builder',
  'consult',
  'hub',
] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

/** Mode assumed for legacy rows, missing values, and anything unrecognized. */
export const DEFAULT_SESSION_MODE: SessionMode = 'chat';

/** Narrowing type guard: true iff `value` is exactly one of SESSION_MODES. */
export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === 'string' && (SESSION_MODES as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary input to a valid SessionMode. NULL / undefined / unknown
 * strings collapse to DEFAULT_SESSION_MODE so callers never have to special-case
 * legacy rows (the column was added with a DEFAULT 'chat', but row objects read
 * before the migration ran — or from other code paths — may carry null/absent).
 */
export function normalizeSessionMode(value: unknown): SessionMode {
  return isSessionMode(value) ? value : DEFAULT_SESSION_MODE;
}

/**
 * Whether design-mode behavior (design skill load, artifact canvas) should be
 * active for a session row. Accepts the raw row shape so callers can pass a
 * `SessionRow` directly without threading the column out.
 */
export function isDesignModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'design';
}

/**
 * Whether scoping-mode behavior (kanban flowchart panel, phase/ticket planning)
 * should be active for a session row.
 */
export function isScopingModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'scoping';
}

/**
 * Whether skill-builder mode (conversational skill authoring) should be active.
 * Replaces the legacy per-project Skill Builder agent — same coach behavior,
 * folded into the session mode picker on any dev agent.
 */
export function isSkillBuilderModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'skill-builder';
}

/**
 * Whether isolated / VM mode is active. Same ship surface as `chat` (Finalize
 * allowed), but the session env adapter is forced to Firecracker when that
 * backend is registered — see `resolveSessionEnvAdapterForSession`.
 */
export function isIsolatedModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'isolated';
}

/**
 * Modes that share chat's ship / Finalize surface (Build → Auto Merge allowed;
 * entering them must not clear finalize automation).
 */
export function isShippingCompatibleSessionMode(
  mode: SessionMode | string | null | undefined,
): boolean {
  const normalized = normalizeSessionMode(mode);
  return normalized === 'chat' || normalized === 'isolated';
}

/**
 * Whether consult-mode behavior (Hub-only Q&A + project mutations, no code ship)
 * should be active. Available on dev and workflow projects; code ship and
 * Finalize are blocked while consult behavior is active.
 */
export function isConsultModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'consult';
}

/**
 * Whether Hub-assistant mode is active. Hub sessions answer personal/org
 * operating questions and mutate Hub data (board, todos, support, sessions)
 * without code ship or Finalize. Distinct from Consult: Consult is
 * project-scoped; Hub is the org/user home surface.
 */
export function isHubModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'hub';
}

/** Consult behavior: explicit consult mode, or legacy ask_mode rows (Ask retired). */
export function isConsultBehaviorActive(
  session: { session_mode?: string | null; ask_mode?: number | null } | null | undefined,
): boolean {
  return isConsultModeActive(session) || Number(session?.ask_mode ?? 0) !== 0;
}

/**
 * No code ship / Finalize: Consult, Hub, or legacy ask_mode. Used by spawn
 * and the session chrome so Hub and Consult share the non-shipping surface
 * without treating Hub as a project Consult session.
 */
export function isNonShippingSessionBehavior(
  session: { session_mode?: string | null; ask_mode?: number | null } | null | undefined,
): boolean {
  return isHubModeActive(session) || isConsultBehaviorActive(session);
}

/** Default session_mode for newly created user-facing sessions. */
export function defaultSessionModeForProject(
  project: { mode?: string | null } | null | undefined,
): SessionMode {
  return project?.mode === 'workflow' ? 'consult' : 'chat';
}

/**
 * Agent roles that may NOT run Skill Builder mode. Skill Builder prepends a
 * dev-oriented coach prompt and force-loads skill-authoring skills, so it only
 * makes sense on a regular dev agent — running it on a docs / reviewer / legacy
 * skill-builder helper applies the wrong prompt + role assumptions.
 */
export const SKILL_BUILDER_INELIGIBLE_ROLES: readonly string[] = [
  'skill-builder',
  'reviewer',
  'docs',
  'hub-assistant',
];

/**
 * Whether an agent (by role) is eligible to run Skill Builder mode. The single
 * source of truth shared by the entry points (App.handleStartSkillBuilderMode,
 * extract-skill), the server mode-update guards, and the web/mobile mode pickers
 * so eligibility never drifts between where the option is offered and where the
 * mode is persisted.
 */
export function isSkillBuilderEligibleAgent(
  agent: { role?: string | null } | null | undefined,
): boolean {
  if (!agent) return false;
  return !SKILL_BUILDER_INELIGIBLE_ROLES.includes(agent.role ?? '');
}

/**
 * Whether a session has an isolated worktree usable for design mode — the single
 * source of truth shared by the mode route (which refuses to persist `design`
 * for a worktree-less session) and the chat spawn path (which disables design
 * behavior in the same case). Design mode writes artifacts under `design/` in
 * the session worktree and must NEVER fall back to the shared project checkout,
 * so "usable worktree" means a non-empty `worktree_path`. Keeping both callers
 * on this predicate prevents the accept-side and run-side checks from drifting.
 */
export function sessionHasUsableWorktree(
  session: { worktree_path?: string | null } | null | undefined,
): boolean {
  return !!(session?.worktree_path ?? '').trim();
}
