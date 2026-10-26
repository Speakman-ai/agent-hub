/**
 * No Guardrails session mode.
 *
 * A project-gated session mode for one-off work (deploy builds, hotfix
 * branches, release tags) where the agent may run `git push` and
 * `gh pr create` directly instead of stopping at a local commit for Finalize.
 *
 * Two switches must both be on for the bypass to apply:
 *   1. the project opts in (`project.noGuardrails.enabled === true`, default off), and
 *   2. the session is in `session_mode = 'no-guardrails'`.
 *
 * The project check runs at every spawn, so turning the project toggle off
 * re-arms the direct-ship gate on the very next turn of any session still
 * sitting in this mode.
 */
import type { Project } from './types.js';
import { isWorkflowProject } from './project-mode-guards.js';
import { normalizeSessionMode } from './session-mode.js';

/** Spawn env flag the `git` / `gh` PATH shims read to skip the direct-ship gate. */
export const NO_GUARDRAILS_ENV = 'AGENT_HUB_NO_GUARDRAILS';

/** Whether the project allows No Guardrails sessions. Workflow projects never do. */
export function noGuardrailsEnabledForProject(project: Project | null | undefined): boolean {
  if (!project || isWorkflowProject(project)) return false;
  return project.noGuardrails?.enabled === true;
}

export function isNoGuardrailsModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'no-guardrails';
}

/** True only when the session is in the mode AND its project still allows it. */
export function sessionRunsWithoutGuardrails(
  project: Project | null | undefined,
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return isNoGuardrailsModeActive(session) && noGuardrailsEnabledForProject(project);
}

/**
 * Per-turn preamble. Sent on every turn (not only the first) so a session that
 * switches into the mode mid-conversation sees it, and it explicitly overrides
 * the no-direct-ship rules carried in the agent's own system prompt.
 */
export function buildNoGuardrailsPreamble(args: {
  branch?: string | null;
  pushTargetLabel: string;
}): string {
  const branch = args.branch ? ` (\`${args.branch}\`)` : '';
  return `## No Guardrails Session

The operator put this session in **No Guardrails** mode. For this session only, this section **overrides** every "do not push", "no direct ship", "commit locally and stop", and "Finalize owns shipping" rule elsewhere in your instructions, including the agent shipping contract.

- You may run \`git push\` and \`gh pr create\` (or the ${args.pushTargetLabel} PR API) whenever the work calls for it, without waiting for Finalize.
- Your session branch${branch} is still the branch to commit on. Push it, or push a ref from it (\`git push origin HEAD:<ref>\`, tags), as the task needs.
- Server-side branch protection on the default branch still applies. Do not force-push shared branches unless the user asked for it.
- Say what you pushed (remote, ref, commit) in your reply so the operator can follow along.`;
}
