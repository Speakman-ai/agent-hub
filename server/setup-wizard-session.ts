/**
 * Guided "setup wizard" sessions are system-spawned, single-task sessions whose
 * entire instruction is the kickoff prompt the wizard route delivers as the
 * first user message: the Preview / Finalize / RUM / Deploy setup walkthroughs.
 * Each is created on a worktree-backed session named `[<Wizard> Setup] <project>`.
 *
 * They run in the agent's normal workspace, so the generic memory carryover that
 * `buildEnrichedPrompt` injects on the first turn (MEMORY.md + today's/yesterday's
 * daily notes) lands in them too. That carryover can contain a
 * "Session Summary (just completed)" block from a completely unrelated dev
 * effort. On a focused wizard turn that competes with — and has been observed to
 * override — the actual wizard task: a Preview Setup session (a76feed4) ignored
 * its kickoff entirely and instead resumed an unrelated "Deputy timesheet
 * mapping" dev task pulled from the carried summary.
 *
 * For these scoped task sessions the kickoff prompt is authoritative; workspace
 * memory adds noise and a concrete context-bleed risk, so the prompt builder
 * suppresses it (see `omitWorkspaceMemory` in `buildEnrichedPrompt`).
 */
export const SETUP_WIZARD_SESSION_PREFIXES = [
  '[Preview Setup]',
  '[Dev Server Setup]',
  '[Finalize Setup]',
  '[RUM Setup]',
  '[Deploy Setup]',
  '[Logs Setup]',
  '[Infra Setup]',
] as const;

/**
 * True when the session is one of the guided setup-wizard sessions whose
 * kickoff prompt is the sole authoritative instruction. Used to suppress the
 * first-turn workspace-memory carryover that would otherwise bleed unrelated
 * dev context into the wizard.
 */
export function isSetupWizardSession(
  session: { name?: string | null } | null | undefined,
): boolean {
  const name = session?.name;
  if (typeof name !== 'string') return false;
  return SETUP_WIZARD_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix));
}
