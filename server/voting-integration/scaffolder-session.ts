/**
 * Voting scaffolder session — identity + first-turn-prompt resolver.
 *
 * The "Set up voting in an app" launcher (Voting tab, cards 2019/2020) spawns a
 * normal Agent Hub session in a target project's workspace whose sole job is to
 * scaffold a voting UI. That session is:
 *
 *   - named with the `[Voting Setup]` prefix so the rest of the system can
 *     recognize it (this is the same mechanism setup-wizard sessions use);
 *   - seeded with the voting integration task pack as its first user message.
 *
 * `resolveVotingScaffolderFirstTurnPrompt` is the resolver the launcher calls:
 * given the target project (+ optional page-name hint / API base) it returns
 * the session name and the rendered first-turn prompt. `isVotingScaffolderSession`
 * is the predicate the chat turn builder uses to suppress the first-turn
 * workspace-memory carryover — exactly like `isSetupWizardSession` — so an
 * unrelated "Session Summary" in the agent's memory can't override the pack.
 */

import { renderVotingIntegrationTaskPack, type VotingTaskPackOptions } from './task-pack.js';

/** Session-name prefix that marks a spawned voting scaffolder session. */
export const VOTING_SCAFFOLDER_SESSION_PREFIX = '[Voting Setup]';

/**
 * True when the session is a voting scaffolder session whose seeded task pack
 * is the sole authoritative instruction. Used to suppress the first-turn
 * workspace-memory carryover that would otherwise bleed unrelated dev context
 * into the scaffold (see `omitWorkspaceMemory` in `buildEnrichedPrompt`).
 */
export function isVotingScaffolderSession(
  session: { name?: string | null } | null | undefined,
): boolean {
  const name = session?.name;
  if (typeof name !== 'string') return false;
  return name.startsWith(VOTING_SCAFFOLDER_SESSION_PREFIX);
}

/** Build the deterministic session name for a voting scaffolder session. */
export function buildVotingScaffolderSessionName(targetProjectId: string): string {
  return `${VOTING_SCAFFOLDER_SESSION_PREFIX} ${targetProjectId}`;
}

export interface ResolvedVotingScaffolderSession {
  /** Session name, carrying the `[Voting Setup]` prefix. */
  name: string;
  /** First-turn user message: the rendered voting integration task pack. */
  prompt: string;
}

/**
 * Resolver: return the session name + first-turn prompt for a spawned voting
 * scaffolder session. This is the single entry point the launcher uses; it
 * validates/sanitizes the (untrusted) options via the task-pack renderer and
 * throws if `targetProjectId` is not a valid project slug.
 */
export function resolveVotingScaffolderFirstTurnPrompt(
  options: VotingTaskPackOptions,
): ResolvedVotingScaffolderSession {
  const prompt = renderVotingIntegrationTaskPack(options);
  return {
    name: buildVotingScaffolderSessionName(options.targetProjectId.trim()),
    prompt,
  };
}
