/**
 * Auto-commit & PR module
 *
 * Handles post-session git automation: auto-committing uncommitted changes,
 * pushing branches, creating PRs, and triggering lead review.
 * Also provides slash-command skill resolution for chat messages.
 */

import path from 'path';
import { readFileSync, existsSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Module-level state ──────────────────────────────────────────────
let deps = null;

// ─── Initialisation ──────────────────────────────────────────────────

/**
 * Call once at startup to inject shared dependencies.
 *
 * @param {object} d
 * @param {object} d.stmts              - Prepared SQLite statements
 * @param {Function} d.broadcast         - WebSocket broadcast helper
 * @param {Function} d.triggerReviewForCard - Trigger lead review for a kanban card
 * @param {Function} d.leadReviewPR      - Trigger lead review for a PR directly
 * @param {Function} d.getConfig         - Returns the server config object
 * @param {string} d.DEFAULT_SKILLS_DIR  - Default skills directory path
 */
export function initAutoGit(d) {
  deps = d;
}

// ─── Slash-command skill resolution ─────────────────────────────────

/**
 * Resolve a slash-command (e.g. `/foo args`) to skill markdown
 * content, and wraps it so the agent receives skill context alongside
 * the user's remaining args.
 */
export function resolveSlashSkill(agent, content, project) {
  const ahw = project?.ahw || agent.ahw || agent.workspace;
  if (!content.startsWith('/')) return null;

  const match = content.match(/^\/([a-zA-Z0-9_.-]+)(\s[\s\S]*)?$/);
  if (!match) return null;

  const skillName = match[1];
  const userArgs = match[2] ? match[2].trim() : '';

  // Search in project skills first, then default skills
  const searchDirs = [];
  if (ahw) searchDirs.push(path.join(ahw, 'skills'));
  searchDirs.push(deps.DEFAULT_SKILLS_DIR);

  for (const skillsDir of searchDirs) {
    if (!existsSync(skillsDir)) continue;

    // Try directory-based skill (skills/foo/SKILL.md)
    const dirPath = path.join(skillsDir, skillName);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      const skillMd = path.join(dirPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        const raw = readFileSync(skillMd, 'utf-8');
        return { skillContent: raw, skillName, userArgs };
      }
    }

    // Try standalone .md file (skills/foo.md)
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
 * Move a kanban card to the "Review" column and trigger lead review.
 * Shared helper used in multiple code paths below.
 */
function moveCardToReviewAndTrigger(card, project, prUrl) {
  if (prUrl) {
    try {
      deps.stmts.setCardPrUrl.run(prUrl, card.id);
    } catch (_e) {
      /* non-critical */
    }
  }

  const board = deps.stmts.getKanbanBoard?.get(project.id);
  if (board) {
    const cols = deps.stmts.getKanbanColumns.all(board.id);
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    if (reviewCol) {
      deps.stmts.moveKanbanCard.run(reviewCol.id, 0, card.id);
      deps.broadcast({ type: 'kanban_update', projectId: project.id });
      console.log(`[auto-commit] Card "${card.title}" moved to Review`);
      deps.triggerReviewForCard(card.id, project);
    }
  }
}

/**
 * Trigger lead review for a PR — via card (preferred) or directly.
 */
function triggerReview(card, project, prUrl, agent) {
  if (card) {
    moveCardToReviewAndTrigger(card, project, prUrl);
  } else {
    deps.leadReviewPR(project, prUrl, null, agent).catch((err) => {
      console.error(`[Lead Review] Failed to start:`, err.message);
    });
  }
}

/**
 * Auto-commit uncommitted changes, push the branch, and create a PR.
 * Called after a session completes in a worktree with code changes.
 */
export async function autoCommitAndPR(
  sessionId,
  agentId,
  project,
  agent,
  effectiveCwd,
  _finalContent,
) {
  // Runs for ANY worktree session with code changes — GitHub is source of truth.
  // Questions/chat with no file changes are skipped automatically (no uncommitted/unpushed = early return).
  try {
    if (effectiveCwd === project.cwd) {
      console.log(`[auto-commit] Session ${sessionId} — skipping (not a worktree)`);
      return;
    }

    // Must be a git repo with a remote
    try {
      await execAsync('git remote -v', { cwd: effectiveCwd });
    } catch {
      console.log(`[auto-commit] Session ${sessionId} — skipping (no git remote)`);
      return;
    }

    const card = deps.stmts.getKanbanCardBySession?.get(sessionId);
    // Card is optional — ad-hoc work without a kanban card still gets PR'd

    // Check for uncommitted changes OR unpushed commits
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: effectiveCwd });
    const hasUncommitted = !!status.trim();

    // Also check for commits ahead of origin (agent may have already committed)
    let hasUnpushed = false;
    try {
      const { stdout: logOut } = await execAsync(
        'git log @{upstream}..HEAD --oneline 2>/dev/null',
        { cwd: effectiveCwd },
      );
      hasUnpushed = !!logOut.trim();
    } catch {
      // No upstream set yet — if we have any local commits different from main, treat as unpushed
      try {
        const { stdout: logOut2 } = await execAsync('git log main..HEAD --oneline 2>/dev/null', {
          cwd: effectiveCwd,
        });
        hasUnpushed = !!logOut2.trim();
      } catch {}
    }

    if (!hasUncommitted && !hasUnpushed) {
      console.log(
        `[auto-commit] Session ${sessionId} — skipping commit/push (no changes)${card ? ` [card: "${card.title}"]` : ''}`,
      );
      // The agent may have already committed, pushed, and created a PR itself.
      // Check for an existing open PR on this branch and trigger review if found.
      try {
        const { stdout: prOut } = await execAsync(
          `gh pr view --json url,state --jq 'select(.state == "OPEN") | .url'`,
          { cwd: effectiveCwd, timeout: 15000 },
        );
        const existingPrUrl = prOut.trim();
        if (existingPrUrl) {
          console.log(
            `[auto-commit] Found existing open PR: ${existingPrUrl} — triggering lead review`,
          );
          triggerReview(card, project, existingPrUrl, agent);
        }
      } catch {
        // No open PR for this branch — truly nothing to do
      }
      return;
    }

    console.log(
      `[auto-commit] Session ${sessionId} — uncommitted: ${hasUncommitted}, unpushed: ${hasUnpushed}`,
    );

    // Get the branch name
    const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: effectiveCwd,
    });
    const branch = branchOut.trim();

    // Derive commit/PR title — card title > session name > fallback
    const session = deps.stmts.getSession?.get(sessionId);
    const commitTitle = card?.title || session?.name || 'Agent task completion';

    // Only commit if there are uncommitted changes (agent may have already committed)
    if (hasUncommitted) {
      const commitBody = [
        card?.description ? `\n${card.description}` : null,
        `\nAgent: ${agent.name}`,
        card?.priority ? `Priority: ${card.priority}` : null,
        `\nCo-Authored-By: ${agent.name} <noreply@anthropic.com>`,
      ]
        .filter((line) => line != null)
        .join('\n');

      await execAsync("git add -A -- ':!node_modules' ':!*/node_modules'", { cwd: effectiveCwd });
      const fullMessage = `${commitTitle}\n${commitBody}`;
      await execAsync(`git commit -m ${JSON.stringify(fullMessage)}`, { cwd: effectiveCwd });
      console.log(`[auto-commit] Committed: ${commitTitle}`);
    } else {
      console.log(`[auto-commit] Agent already committed — skipping commit, will push + PR`);
    }

    // Push
    try {
      await execAsync(`git push -u origin ${JSON.stringify(branch)}`, {
        cwd: effectiveCwd,
        timeout: 30000,
      });
      console.log(`[auto-commit] Pushed branch ${branch}`);
    } catch (pushErr) {
      console.error(`[auto-commit] Push failed: ${pushErr.message}`);
      return; // Don't create PR if push failed
    }

    // Determine reviewer — cascade: agent.reviewer → project.defaultReviewer → config.defaultReviewer
    const config = deps.getConfig();
    const reviewer = agent.reviewer || project.defaultReviewer || config.defaultReviewer;
    // Validate reviewer if set — must be a safe GitHub username
    const reviewerFlag =
      reviewer && /^[a-zA-Z0-9_-]+$/.test(reviewer) ? `--reviewer ${reviewer}` : '';
    if (reviewer && !reviewerFlag) {
      console.warn(
        `[auto-commit] Invalid reviewer username "${reviewer}" — creating PR without reviewer`,
      );
    }

    // Create PR
    try {
      const prTitle = commitTitle.length > 70 ? commitTitle.substring(0, 67) + '...' : commitTitle;
      const prBodyLines = [
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
      const prBody = prBodyLines.filter((line) => line != null).join('\n');

      const { stdout: prOutput } = await execAsync(
        `gh pr create --head ${JSON.stringify(branch)} --title ${JSON.stringify(prTitle)} --body ${JSON.stringify(prBody)} ${reviewerFlag}`.trim(),
        { cwd: effectiveCwd, timeout: 30000 },
      );
      console.log(`[auto-commit] PR created: ${prOutput.trim()}`);

      // Try to extract PR URL from output
      const prUrl = prOutput.match(/https:\/\/github\.com\/.+\/pull\/\d+/)?.[0] || prOutput.trim();

      // Broadcast notification
      deps.broadcast({
        type: 'auto_pr_created',
        sessionId,
        agentId,
        prUrl,
        cardTitle: card?.title || commitTitle,
      });

      // Move kanban card to "Review" column (if card exists)
      // The move endpoint's review-column trigger will fire leadReviewPR
      triggerReview(card, project, prUrl, agent);
    } catch (prErr) {
      // Handle "PR already exists" — extract existing URL and continue the flow
      const existingMatch = prErr.message.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (existingMatch) {
        const prUrl = existingMatch[0];
        console.log(`[auto-commit] PR already exists: ${prUrl} — continuing flow`);
        triggerReview(card, project, prUrl, agent);
      } else {
        console.error(`[auto-commit] PR creation failed: ${prErr.message}`);
      }
      // Still good — changes are committed and pushed even if PR fails
    }
  } catch (err) {
    console.error(`[auto-commit] Failed: ${err.message}`);
  }
}
