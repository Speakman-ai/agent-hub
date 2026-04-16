import crypto from 'crypto';
import path from 'path';
import { readFileSync, existsSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  Stmts,
  Project,
  Agent,
  KanbanCardRow,
  AppConfig,
  BroadcastFn,
  MessageRow,
} from './types.js';
import { resolveShouldAutoMerge } from './auto-merge.js';

const execAsync = promisify(exec);

// ─── Dependency Types ────────────────────────────────────────────────

interface AutoGitDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getConfig: () => AppConfig;
  DEFAULT_SKILLS_DIR: string;
}

interface SlashSkillResult {
  skillContent?: string;
  skillName: string;
  userArgs: string;
  error?: undefined;
}

interface SlashSkillError {
  error: string;
}

// ─── Module-level state ──────────────────────────────────────────────
let deps: AutoGitDeps | null = null;

function getDeps(): AutoGitDeps {
  if (!deps) throw new Error('auto-git: initAutoGit() must be called before use');
  return deps;
}

// ─── Initialisation ──────────────────────────────────────────────────

export function initAutoGit(d: AutoGitDeps): void {
  deps = d;
}

// ─── Slash-command skill resolution ─────────────────────────────────

export function resolveSlashSkill(
  agent: Agent,
  content: string,
  project: Project | undefined,
): SlashSkillResult | SlashSkillError | null {
  const ahw = project?.ahw || agent.ahw || (agent as Record<string, unknown>).workspace;
  if (!content.startsWith('/')) return null;

  const match = content.match(/^\/([a-zA-Z0-9_.-]+)(\s[\s\S]*)?$/);
  if (!match) return null;

  const skillName = match[1];
  const userArgs = match[2] ? match[2].trim() : '';

  const d = getDeps();
  const searchDirs: string[] = [];
  if (ahw) searchDirs.push(path.join(ahw as string, 'skills'));
  searchDirs.push(d.DEFAULT_SKILLS_DIR);

  for (const skillsDir of searchDirs) {
    if (!existsSync(skillsDir)) continue;

    const dirPath = path.join(skillsDir, skillName);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      const skillMd = path.join(dirPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        const raw = readFileSync(skillMd, 'utf-8');
        return { skillContent: raw, skillName, userArgs };
      }
    }

    const mdPath = skillName.endsWith('.md')
      ? path.join(skillsDir, skillName)
      : path.join(skillsDir, skillName + '.md');
    if (existsSync(mdPath) && !statSync(mdPath).isDirectory()) {
      const raw = readFileSync(mdPath, 'utf-8');
      return { skillContent: raw, skillName: skillName.replace('.md', ''), userArgs };
    }
  }

  return { error: `Skill "/${skillName}" not found` };
}

// ─── Auto-commit & PR on agent completion ───────────────────────────

/**
 * Move a card to the Review column and persist the PR URL on it.
 *
 * NOTE: This used to also dispatch the lead-review pipeline. As of the unified
 * reviewer refactor, PR review fires from the GitHub webhook on
 * `pull_request.opened` / `pull_request.synchronize`, so this function is now
 * purely a UI/state update — the dedicated Reviewer agent will be dispatched
 * by the webhook handler when GitHub announces the new PR/push.
 */
function moveCardToReview(card: KanbanCardRow, project: Project, prUrl: string | null): void {
  const d = getDeps();
  if (prUrl) {
    try {
      d.stmts.setCardPrUrl.run(prUrl, card.id);
    } catch (_e: unknown) {
      /* non-critical */
    }
  }

  const board = d.stmts.getKanbanBoard?.get(project.id) as { id: string } | undefined;
  if (board) {
    const cols = d.stmts.getKanbanColumns.all(board.id) as Array<{ id: string; name: string }>;
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    if (reviewCol) {
      d.stmts.moveKanbanCard.run(reviewCol.id, 0, card.id);
      d.broadcast({ type: 'kanban_update', projectId: project.id });
      console.log(`[auto-commit] Card "${card.title}" moved to Review`);
    }
  }
}

// ─── Build card description from session context ───────────────────

export function buildCardDescription(messages: MessageRow[], diffStat: string): string {
  const lines: string[] = [];

  // Extract the first user message as the task/problem statement
  const firstUserMsg = messages.find((m) => m.role === 'user');
  if (firstUserMsg) {
    const taskText = firstUserMsg.content.trim();
    // Truncate long messages to a reasonable summary length
    const maxLen = 500;
    const truncated = taskText.length > maxLen ? taskText.substring(0, maxLen) + '...' : taskText;
    lines.push('### Task');
    lines.push(truncated);
  }

  // Add a "Changes" section from git diff --stat
  if (diffStat.trim()) {
    lines.push('');
    lines.push('### Changes');
    lines.push('```');
    // Limit to first 20 lines of diff stat to keep it concise
    const statLines = diffStat.trim().split('\n');
    const trimmedStat =
      statLines.length > 20
        ? [...statLines.slice(0, 19), `... and ${statLines.length - 19} more files`].join('\n')
        : statLines.join('\n');
    lines.push(trimmedStat);
    lines.push('```');
  }

  return lines.join('\n');
}

// ─── Worktree change detection ──────────────────────────────────────

export interface WorktreeChanges {
  hasUncommitted: boolean;
  hasUnpushed: boolean;
  branch: string;
}

export async function checkWorktreeChanges(cwd: string): Promise<WorktreeChanges> {
  const { stdout: status } = await execAsync('git status --porcelain', { cwd });
  const hasUncommitted = !!status.trim();

  let hasUnpushed = false;
  try {
    const { stdout: logOut } = await execAsync('git log @{upstream}..HEAD --oneline', {
      cwd,
    });
    hasUnpushed = !!logOut.trim();
  } catch {
    try {
      const { stdout: logOut2 } = await execAsync('git log main..HEAD --oneline', {
        cwd,
      });
      hasUnpushed = !!logOut2.trim();
    } catch {
      // no upstream or main ref
    }
  }

  const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });

  return { hasUncommitted, hasUnpushed, branch: branchOut.trim() };
}

// ─── Core commit + PR + review pipeline ─────────────────────────────

/**
 * Fire-and-forget enable of GitHub's native auto-merge on a PR.
 *
 * Resolves the auto-merge decision via `resolveShouldAutoMerge` (per-PR
 * override wins; otherwise the project's `githubWorkflow.autoMerge`).
 *
 * Failures here NEVER bubble up — they must not block PR creation:
 *   - Repo doesn't have "Allow auto-merge" enabled → logged, PR still succeeds
 *   - PR requirements not met → logged warning, PR still succeeds
 *   - Any other failure → logged, doesn't cascade
 */
async function enableAutoMergeIfNeeded(
  prUrl: string,
  project: Project,
  override: boolean | undefined,
  cwd: string,
): Promise<void> {
  if (!resolveShouldAutoMerge(override, project.githubWorkflow)) return;
  try {
    await execAsync(`gh pr merge --auto --squash ${JSON.stringify(prUrl)}`, {
      cwd,
      timeout: 15000,
    });
    console.log(`[auto-merge] Enabled GitHub native auto-merge for ${prUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-merge] Failed to enable auto-merge for ${prUrl}: ${msg}`);
  }
}

async function commitPushAndCreatePR(
  sessionId: string,
  agentId: string,
  project: Project,
  agent: Agent,
  effectiveCwd: string,
  card: KanbanCardRow | undefined,
  options?: { autoMergeOverride?: boolean },
): Promise<{ prUrl: string } | null> {
  const d = getDeps();

  const changes = await checkWorktreeChanges(effectiveCwd);

  if (!changes.hasUncommitted && !changes.hasUnpushed) {
    console.log(
      `[auto-commit] Session ${sessionId} — skipping commit/push (no changes)${card ? ` [card: "${card.title}"]` : ''}`,
    );
    try {
      const { stdout: prOut } = await execAsync(
        `gh pr view --json url,state --jq 'select(.state == "OPEN") | .url'`,
        { cwd: effectiveCwd, timeout: 15000 },
      );
      const existingPrUrl = prOut.trim();
      if (existingPrUrl) {
        console.log(
          `[auto-commit] Found existing open PR: ${existingPrUrl} — moving card to Review`,
        );
        if (card) moveCardToReview(card, project, existingPrUrl);
        // Re-apply auto-merge intent in case the user flipped the toggle ON
        // and re-clicked "Create PR" against a branch with no new changes.
        // Idempotent on GitHub's side if already enabled.
        enableAutoMergeIfNeeded(
          existingPrUrl,
          project,
          options?.autoMergeOverride,
          effectiveCwd,
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[auto-merge] Unexpected error enabling auto-merge: ${msg}`);
        });
        return { prUrl: existingPrUrl };
      }
    } catch {
      // No open PR for this branch
    }
    return null;
  }

  console.log(
    `[auto-commit] Session ${sessionId} — uncommitted: ${changes.hasUncommitted}, unpushed: ${changes.hasUnpushed}`,
  );

  const session = d.stmts.getSession?.get(sessionId) as { name?: string } | undefined;
  const commitTitle = card?.title || session?.name || 'Agent task completion';

  if (changes.hasUncommitted) {
    // Ensure git identity is configured (may be missing in shallow clones)
    try {
      await execAsync('git config user.name', { cwd: effectiveCwd });
    } catch {
      // Try to copy from the project's main repo, or fall back to defaults
      try {
        const { stdout: name } = await execAsync('git config user.name', { cwd: project.cwd });
        const { stdout: email } = await execAsync('git config user.email', { cwd: project.cwd });
        if (name.trim())
          await execAsync(`git config user.name ${JSON.stringify(name.trim())}`, {
            cwd: effectiveCwd,
          });
        if (email.trim())
          await execAsync(`git config user.email ${JSON.stringify(email.trim())}`, {
            cwd: effectiveCwd,
          });
      } catch {
        await execAsync('git config user.name "Agent Hub"', { cwd: effectiveCwd });
        await execAsync('git config user.email "agent@agent-hub.com"', { cwd: effectiveCwd });
      }
    }

    const commitBody = [
      card?.description ? `\n${card.description}` : null,
      `\nAgent: ${agent.name}`,
      card?.priority ? `Priority: ${card.priority}` : null,
      `\nCo-Authored-By: ${agent.name} <noreply@anthropic.com>`,
    ]
      .filter((line): line is string => line != null)
      .join('\n');

    await execAsync('git add -A', { cwd: effectiveCwd });
    const fullMessage = `${commitTitle}\n${commitBody}`;
    await execAsync(`git commit -m ${JSON.stringify(fullMessage)}`, { cwd: effectiveCwd });
    console.log(`[auto-commit] Committed: ${commitTitle}`);
  } else {
    console.log(`[auto-commit] Agent already committed — skipping commit, will push + PR`);
  }

  try {
    await execAsync(`git push -u origin ${JSON.stringify(changes.branch)}`, {
      cwd: effectiveCwd,
      timeout: 30000,
    });
    console.log(`[auto-commit] Pushed branch ${changes.branch}`);
  } catch (pushErr: unknown) {
    const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    console.error(`[auto-commit] Push failed: ${msg}`);
    return null;
  }

  const config = d.getConfig();
  const reviewer =
    agent.reviewer ||
    ((project as Record<string, unknown>).defaultReviewer as string | undefined) ||
    config.defaultReviewer;
  const reviewerFlag =
    reviewer && /^[a-zA-Z0-9_-]+$/.test(reviewer) ? `--reviewer ${reviewer}` : '';
  if (reviewer && !reviewerFlag) {
    console.warn(
      `[auto-commit] Invalid reviewer username "${reviewer}" — creating PR without reviewer`,
    );
  }

  const prTitle = commitTitle.length > 70 ? commitTitle.substring(0, 67) + '...' : commitTitle;
  const prBodyLines: Array<string | null> = [
    '## Summary',
    card?.description || `Task completed by ${agent.name}.`,
    '',
    `**Agent:** ${agent.name}`,
    card?.priority ? `**Priority:** ${card.priority}` : null,
    card?.labels ? `**Labels:** ${card.labels}` : null,
    '',
    '---',
    card ? `Automated PR from Agent Hub kanban task.` : `Automated PR from Agent Hub.`,
  ];
  const prBody = prBodyLines.filter((line): line is string => line != null).join('\n');

  const broadcastAndMove = async (prUrl: string) => {
    d.broadcast({
      type: 'auto_pr_created',
      sessionId,
      agentId,
      prUrl,
      cardTitle: card?.title || commitTitle,
    });

    // Persist a permanent "PR created" marker in the chat timeline as a
    // system-role message. This gives the user a timestamped receipt of the
    // action (manual click OR auto-PR at session end). Failure here is
    // non-fatal — the PR still exists and the auto_pr_created broadcast fires
    // regardless.
    try {
      let commitSha = '';
      try {
        const { stdout: shaOut } = await execAsync('git rev-parse HEAD', {
          cwd: effectiveCwd,
          timeout: 5000,
        });
        commitSha = shaOut.trim().substring(0, 12);
      } catch {
        /* commit SHA is best-effort — the marker is still useful without it */
      }
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;
      const msgId = crypto.randomUUID();
      const metadata = JSON.stringify({
        kind: 'pr_created',
        prUrl,
        prNumber,
        commitSha,
        commitTitle,
        cardId: card?.id ?? null,
        cardTitle: card?.title ?? null,
      });
      d.stmts.addMessage.run(
        msgId,
        sessionId,
        'system',
        'PR created from these changes',
        null,
        null,
        null,
        metadata,
      );
      const insertedMessage = (d.stmts.getMessageById?.get(msgId) as MessageRow | undefined) ?? {
        id: msgId,
        session_id: sessionId,
        role: 'system' as const,
        content: 'PR created from these changes',
        engine: null,
        model: null,
        attachments: null,
        metadata,
        created_at: new Date().toISOString(),
      };
      d.broadcast({ type: 'message_added', sessionId, message: insertedMessage });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-commit] Failed to persist PR-created marker: ${msg}`);
    }

    // Reconciliation: ensure card has pr_url linked
    if (card && !card.pr_url) {
      try {
        d.stmts.setCardPrUrl.run(prUrl, card.id);
        console.log(`[auto-commit] Linked PR URL to card "${card.title}": ${prUrl}`);
      } catch (_e: unknown) {
        /* non-critical */
      }
    }

    // Move the card to Review for visibility. The Reviewer agent will be
    // dispatched by the GitHub webhook handler when the PR opens/syncs.
    if (card) moveCardToReview(card, project, prUrl);

    // Fire-and-forget: enable GitHub native auto-merge if the project or
    // per-PR override requests it. Failure here never blocks PR creation.
    enableAutoMergeIfNeeded(prUrl, project, options?.autoMergeOverride, effectiveCwd).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[auto-merge] Unexpected error enabling auto-merge: ${msg}`);
      },
    );
  };

  try {
    const { stdout: prOutput } = await execAsync(
      `gh pr create --head ${JSON.stringify(changes.branch)} --title ${JSON.stringify(prTitle)} --body ${JSON.stringify(prBody)} ${reviewerFlag}`.trim(),
      { cwd: effectiveCwd, timeout: 30000 },
    );
    console.log(`[auto-commit] PR created: ${prOutput.trim()}`);

    const prUrl = prOutput.match(/https:\/\/github\.com\/.+\/pull\/\d+/)?.[0] || prOutput.trim();
    await broadcastAndMove(prUrl);
    return { prUrl };
  } catch (prErr: unknown) {
    const errMsg = prErr instanceof Error ? prErr.message : String(prErr);
    const existingMatch = errMsg.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (existingMatch) {
      const prUrl = existingMatch[0];
      console.log(`[auto-commit] PR already exists: ${prUrl} — continuing flow`);
      await broadcastAndMove(prUrl);
      return { prUrl };
    }

    console.error(`[auto-commit] PR creation failed: ${errMsg}`);
    // Fallback: try to discover PR by branch name
    try {
      const { stdout: prDiscovery } = await execAsync(
        `gh pr view ${JSON.stringify(changes.branch)} --json url,state --jq 'select(.state == "OPEN") | .url'`,
        { cwd: effectiveCwd, timeout: 15000 },
      );
      const discoveredUrl = prDiscovery.trim();
      if (discoveredUrl) {
        console.log(`[auto-commit] Discovered PR by branch name: ${discoveredUrl}`);
        await broadcastAndMove(discoveredUrl);
        return { prUrl: discoveredUrl };
      }
    } catch {
      // No PR found by branch name either
    }
    return null;
  }
}

// ─── Auto-commit & PR on agent completion ───────────────────────────

export async function autoCommitAndPR(
  sessionId: string,
  agentId: string,
  project: Project,
  agent: Agent,
  effectiveCwd: string,
  _finalContent: string,
): Promise<void> {
  const d = getDeps();
  try {
    if (agent.role === 'intake') {
      console.log(`[auto-commit] Session ${sessionId} — skipping (intake agent, no PR)`);
      return;
    }

    if (effectiveCwd === project.cwd) {
      console.log(`[auto-commit] Session ${sessionId} — skipping (not a worktree)`);
      return;
    }

    try {
      await execAsync('git remote -v', { cwd: effectiveCwd });
    } catch {
      console.log(`[auto-commit] Session ${sessionId} — skipping (no git remote)`);
      return;
    }

    const card = d.stmts.getKanbanCardBySession?.get(sessionId) as KanbanCardRow | undefined;

    // Ad-hoc sessions (no kanban card): two sub-cases.
    //   1. Existing PR on this branch → agent was likely fixing CI or a
    //      reviewer comment. Push (and commit if needed) so GitHub sees the
    //      fix. No new PR is opened.
    //   2. No existing PR → broadcast `changes_ready` so the "Create PR"
    //      button surfaces in the UI for the user to decide.
    if (!card) {
      const changes = await checkWorktreeChanges(effectiveCwd);
      if (!changes.hasUncommitted && !changes.hasUnpushed) {
        return;
      }

      // Does an open PR already exist for this branch?
      let existingPrUrl: string | null = null;
      try {
        const { stdout: prOut } = await execAsync(
          `gh pr view --json url,state --jq 'select(.state == "OPEN") | .url'`,
          { cwd: effectiveCwd, timeout: 15000 },
        );
        existingPrUrl = prOut.trim() || null;
      } catch {
        // No open PR for this branch — fall through to the banner path.
      }

      if (existingPrUrl) {
        console.log(
          `[auto-commit] Session ${sessionId} — ad-hoc with existing PR (${existingPrUrl}), pushing fix`,
        );
        // Reuse the card-driven path with no card: it commits (if needed),
        // pushes the branch, and gracefully handles "PR already exists" by
        // broadcasting `auto_pr_created` with the existing URL via the catch
        // branch in commitPushAndCreatePR. No new PR is opened.
        await commitPushAndCreatePR(sessionId, agentId, project, agent, effectiveCwd, undefined);
        d.stmts.clearSessionChangesReady.run(sessionId);
        return;
      }

      console.log(
        `[auto-commit] Session ${sessionId} — ad-hoc session with changes, broadcasting changes_ready`,
      );
      const changesReadyData = {
        agentId,
        branch: changes.branch,
        hasUncommitted: changes.hasUncommitted,
        hasUnpushed: changes.hasUnpushed,
      };
      d.stmts.updateSessionChangesReady.run(JSON.stringify(changesReadyData), sessionId);
      d.broadcast({
        type: 'changes_ready',
        sessionId,
        ...changesReadyData,
      });
      return;
    }

    // Autonomous/card-driven sessions: commit, push, create PR, move card to
    // Review. The Reviewer agent is dispatched separately by the GitHub
    // webhook handler when the PR opens or syncs.
    await commitPushAndCreatePR(sessionId, agentId, project, agent, effectiveCwd, card);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auto-commit] Failed: ${msg}`);
  }
}

// ─── Title sanitization ─────────────────────────────────────────────

/**
 * Check if a string looks like raw cron/heartbeat output rather than a clean title.
 * Raw output typically contains newlines, status symbols, timestamps, or markdown headers.
 */
export function isGarbageTitle(title: string): boolean {
  if (title.includes('\n')) return true;
  if (/^[✓✗⚠●]/.test(title)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(title)) return true;
  if (/^#{1,3}\s/.test(title)) return true;
  if (title.length > 120) return true;
  return false;
}

/**
 * Derive a clean PR title from the git log when the session name is unusable.
 * Falls back to a generic agent-based title.
 */
async function deriveCleanTitle(cwd: string, agentName: string): Promise<string> {
  try {
    // Use the most recent commit message on this branch vs main
    const { stdout } = await execAsync(
      'git log main..HEAD --format=%s --reverse 2>/dev/null | head -1',
      { cwd, timeout: 10000 },
    );
    const firstCommitMsg = stdout.trim();
    if (firstCommitMsg && !isGarbageTitle(firstCommitMsg)) {
      return firstCommitMsg.length > 70 ? firstCommitMsg.substring(0, 67) + '...' : firstCommitMsg;
    }
  } catch {
    // fall through
  }

  try {
    // Fall back to diffstat summary
    const { stdout } = await execAsync('git diff --stat main...HEAD 2>/dev/null | tail -1', {
      cwd,
      timeout: 10000,
    });
    const stat = stdout.trim();
    if (stat) {
      return `${agentName}: ${stat}`.substring(0, 70);
    }
  } catch {
    // fall through
  }

  return `${agentName}: ad-hoc changes`;
}

// ─── Manual commit & PR (triggered by user from UI) ─────────────────

export async function manualCommitAndPR(
  sessionId: string,
  agentId: string,
  project: Project,
  agent: Agent,
  effectiveCwd: string,
  options: { title?: string; autoMerge?: boolean },
): Promise<{ prUrl: string; cardId: string } | null> {
  const d = getDeps();

  // Create a kanban card for tracking
  const session = d.stmts.getSession?.get(sessionId) as { name?: string } | undefined;
  const rawName = options.title || session?.name || '';
  const cardTitle =
    rawName && !isGarbageTitle(rawName)
      ? rawName
      : await deriveCleanTitle(effectiveCwd, agent.name || 'Agent');
  const cardId = crypto.randomUUID();

  const board = d.stmts.getKanbanBoard?.get(project.id) as { id: string } | undefined;
  if (!board) {
    console.error(`[manual-pr] No kanban board found for project ${project.id}`);
    return null;
  }

  const cols = d.stmts.getKanbanColumns.all(board.id) as Array<{ id: string; name: string }>;
  const inProgressCol = cols.find((c) => c.name === 'In Progress');
  const targetCol = inProgressCol || cols[0];
  if (!targetCol) {
    console.error(`[manual-pr] No columns found on board`);
    return null;
  }

  // Build a rich description from session messages + git diff stat
  const messages = d.stmts.getMessages.all(sessionId) as MessageRow[];
  let diffStat = '';
  try {
    const { stdout } = await execAsync(
      'git diff --stat HEAD~1 HEAD 2>/dev/null || git diff --stat main...HEAD',
      {
        cwd: effectiveCwd,
        timeout: 10000,
      },
    );
    diffStat = stdout;
  } catch {
    // diff stat is optional — proceed without it
  }
  const cardDescription = buildCardDescription(messages, diffStat);

  // createKanbanCard params: (id, column_id, board_id, title, description, priority,
  //   assignee, labels, session_id, github_issue_url, created_by, position)
  d.stmts.createKanbanCard.run(
    cardId,
    targetCol.id,
    board.id,
    cardTitle,
    cardDescription,
    'medium',
    agent.name || '',
    '',
    sessionId,
    '',
    agent.name || '',
    0,
  );
  console.log(`[manual-pr] Created card "${cardTitle}" and linked to session ${sessionId}`);

  const card = d.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;

  const result = await commitPushAndCreatePR(
    sessionId,
    agentId,
    project,
    agent,
    effectiveCwd,
    card,
    { autoMergeOverride: options.autoMerge },
  );

  if (result?.prUrl) {
    d.broadcast({ type: 'kanban_update', projectId: project.id });
    return { prUrl: result.prUrl, cardId };
  }

  return null;
}
