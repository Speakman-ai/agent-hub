/**
 * Grok (and other non-resuming CLIs) default to "do not commit unless the
 * user asks." Agent Hub's contract is the opposite: a turn that changes
 * files must end with a local commit so Finalize can ship. The stock
 * shipping-contract block lives at the *head* of the enriched prompt, and
 * `applyArgvPromptCap` keeps the tail, so that contract is the first thing
 * dropped on a long Grok turn. Pin a short reminder at the end of
 * committable Grok/Gemini prompts (session worktree, not ask mode / Design)
 * so it survives the argv trim.
 */
import type { MessageRow } from './types.js';

export const LOCAL_COMMIT_REMINDER_MARKER = '<!-- agent-hub-local-commit -->';

export const LOCAL_COMMIT_REMINDER = `${LOCAL_COMMIT_REMINDER_MARKER}

## Commit before you stop (overrides CLI defaults)

The Grok/Gemini CLI habit of waiting for the user to say "commit" does NOT apply in Agent Hub.
If you changed any files this turn, you MUST \`git add\` and \`git commit\` on the current session branch before ending the turn. Do not ask. Do not wait.
\`git commit\` is required. \`git push\` and \`gh pr create\` remain forbidden.
Finalize Code Changes ships commits only. Uncommitted files cannot be finalized.`;

export const COMMIT_NUDGE_KIND = 'commit_nudge';

export const COMMIT_NUDGE_SYSTEM_MESSAGE = 'Commit required before Finalize';

export function withLocalCommitReminder(prompt: string): string {
  if (prompt.includes(LOCAL_COMMIT_REMINDER_MARKER)) return prompt;
  return `${prompt}\n\n${LOCAL_COMMIT_REMINDER}`;
}

/**
 * The local-commit suffix is only meaningful when the agent is writing into a
 * Finalize-tracked session worktree. Design Studio artifacts, ask/plan mode,
 * and project-cwd (no-worktree) sessions must not be told to `git commit`.
 */
export function shouldPinLocalCommitReminder(input: {
  hasWorktree: boolean;
  askMode?: boolean;
}): boolean {
  return input.hasWorktree && !input.askMode;
}

export function parseCommitNudgeMetadata(metadataString: string | null | undefined): {
  kind: typeof COMMIT_NUDGE_KIND;
} | null {
  if (metadataString == null) return null;
  try {
    const parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed as { kind?: unknown }).kind !== COMMIT_NUDGE_KIND) return null;
    return { kind: COMMIT_NUDGE_KIND };
  } catch {
    return null;
  }
}

/**
 * True when a commit_nudge already exists after the most recent user message.
 *
 * A nudge turn can persist a later `system` row (close-card rejection, ReAct
 * budget halt, error persistence). Keying only on the last non-assistant
 * message would then re-arm another auto-turn. Walking back to the last user
 * message keeps the one-nudge-per-user-turn contract even when those rows
 * land after the marker.
 */
export function hasCommitNudgeSinceLastUser(
  messages: Array<Pick<MessageRow, 'role' | 'metadata'>>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row.role === 'user') return false;
    if (parseCommitNudgeMetadata(row.metadata) !== null) return true;
  }
  return false;
}

export function buildCommitNudgeCliPrompt(args: { branch: string; porcelain?: string }): string {
  const lines = [
    `You left uncommitted changes on '${args.branch}' and there is no local commit that Finalize can ship.`,
    'Finalize reviews and pushes commits, not the working tree, so this work will not ship until you commit.',
    '',
    'Commit these changes on the current session branch now (do not switch branches, do not push). Then end your turn.',
  ];
  const porcelain = (args.porcelain ?? '').trim();
  if (porcelain) {
    lines.push('');
    lines.push('Uncommitted changes (git status --porcelain):');
    lines.push('```');
    lines.push(porcelain);
    lines.push('```');
  }
  return lines.join('\n');
}

export function shouldNudgeUncommittedCommit(input: {
  hasUncommitted: boolean;
  hasUnpushed: boolean;
  allowFinalizeAutoStart: boolean;
  askMode: boolean;
  alreadyNudged: boolean;
  awaitingAsk: boolean;
  role?: string | null;
}): boolean {
  if (input.role === 'reviewer') return false;
  if (!input.allowFinalizeAutoStart) return false;
  if (input.askMode) return false;
  if (input.awaitingAsk) return false;
  if (input.alreadyNudged) return false;
  return input.hasUncommitted && !input.hasUnpushed;
}
