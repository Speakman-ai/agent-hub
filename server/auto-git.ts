import path from 'path';
import { readFileSync, existsSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Stmts, Project, Agent, KanbanCardRow, AppConfig, BroadcastFn } from './types.js';

const execAsync = promisify(exec);

// ─── Dependency Types ────────────────────────────────────────────────

interface AutoGitDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  triggerReviewForCard: (cardId: string, project: Project) => void;
  leadReviewPR: (project: Project, prUrl: string, card: null, agent: Agent) => Promise<void>;
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

function moveCardToReviewAndTrigger(
  card: KanbanCardRow,
  project: Project,
  prUrl: string | null,
): void {
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
      d.triggerReviewForCard(card.id, project);
    }
  }
}

function triggerReview(
  card: KanbanCardRow | undefined,
  project: Project,
  prUrl: string,
  agent: Agent,
): void {
  const d = getDeps();
  if (card) {
    moveCardToReviewAndTrigger(card, project, prUrl);
  } else {
    d.leadReviewPR(project, prUrl, null, agent).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Lead Review] Failed to start:`, msg);
    });
  }
}

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

    const { stdout: status } = await execAsync('git status --porcelain', { cwd: effectiveCwd });
    const hasUncommitted = !!status.trim();

    let hasUnpushed = false;
    try {
      const { stdout: logOut } = await execAsync(
        'git log @{upstream}..HEAD --oneline 2>/dev/null',
        { cwd: effectiveCwd },
      );
      hasUnpushed = !!logOut.trim();
    } catch {
      try {
        const { stdout: logOut2 } = await execAsync('git log main..HEAD --oneline 2>/dev/null', {
          cwd: effectiveCwd,
        });
        hasUnpushed = !!logOut2.trim();
      } catch {
        // no upstream or main ref
      }
    }

    if (!hasUncommitted && !hasUnpushed) {
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
            `[auto-commit] Found existing open PR: ${existingPrUrl} — triggering lead review`,
          );
          triggerReview(card, project, existingPrUrl, agent);
        }
      } catch {
        // No open PR for this branch
      }
      return;
    }

    console.log(
      `[auto-commit] Session ${sessionId} — uncommitted: ${hasUncommitted}, unpushed: ${hasUnpushed}`,
    );

    const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: effectiveCwd,
    });
    const branch = branchOut.trim();

    const session = d.stmts.getSession?.get(sessionId) as { name?: string } | undefined;
    const commitTitle = card?.title || session?.name || 'Agent task completion';

    if (hasUncommitted) {
      const commitBody = [
        card?.description ? `\n${card.description}` : null,
        `\nAgent: ${agent.name}`,
        card?.priority ? `Priority: ${card.priority}` : null,
        `\nCo-Authored-By: ${agent.name} <noreply@anthropic.com>`,
      ]
        .filter((line): line is string => line != null)
        .join('\n');

      await execAsync("git add -A -- ':!node_modules' ':!*/node_modules'", { cwd: effectiveCwd });
      const fullMessage = `${commitTitle}\n${commitBody}`;
      await execAsync(`git commit -m ${JSON.stringify(fullMessage)}`, { cwd: effectiveCwd });
      console.log(`[auto-commit] Committed: ${commitTitle}`);
    } else {
      console.log(`[auto-commit] Agent already committed — skipping commit, will push + PR`);
    }

    try {
      await execAsync(`git push -u origin ${JSON.stringify(branch)}`, {
        cwd: effectiveCwd,
        timeout: 30000,
      });
      console.log(`[auto-commit] Pushed branch ${branch}`);
    } catch (pushErr: unknown) {
      const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.error(`[auto-commit] Push failed: ${msg}`);
      return;
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

    try {
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

      const { stdout: prOutput } = await execAsync(
        `gh pr create --head ${JSON.stringify(branch)} --title ${JSON.stringify(prTitle)} --body ${JSON.stringify(prBody)} ${reviewerFlag}`.trim(),
        { cwd: effectiveCwd, timeout: 30000 },
      );
      console.log(`[auto-commit] PR created: ${prOutput.trim()}`);

      const prUrl = prOutput.match(/https:\/\/github\.com\/.+\/pull\/\d+/)?.[0] || prOutput.trim();

      d.broadcast({
        type: 'auto_pr_created',
        sessionId,
        agentId,
        prUrl,
        cardTitle: card?.title || commitTitle,
      });

      triggerReview(card, project, prUrl, agent);
    } catch (prErr: unknown) {
      const errMsg = prErr instanceof Error ? prErr.message : String(prErr);
      const existingMatch = errMsg.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (existingMatch) {
        const prUrl = existingMatch[0];
        console.log(`[auto-commit] PR already exists: ${prUrl} — continuing flow`);
        triggerReview(card, project, prUrl, agent);
      } else {
        console.error(`[auto-commit] PR creation failed: ${errMsg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auto-commit] Failed: ${msg}`);
  }
}
