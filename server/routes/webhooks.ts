import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import config, { defaultModelForEngine } from '../config.js';
import { getOrCreateBoard } from './board.js';
import { createEscalation } from './escalations.js';
import type {
  RouteDeps,
  Stmts,
  BroadcastFn,
  ChatMessage,
  Project,
  Agent,
  KanbanCardRow,
  KanbanColumnRow,
  KanbanBoardRow,
  KanbanEpicRow,
  WebhookConfigRow,
  SessionRow,
  AppConfig,
} from '../types.js';

// ─── GitHub Payload Types ────────────────────────────────────────

interface GitHubUser {
  login: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  head?: { ref: string; sha: string };
  base?: { ref: string };
  body?: string;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  merged?: boolean;
  mergeable?: boolean | null;
}

interface GitHubCheckSuite {
  status?: string;
  conclusion?: string;
  pull_requests?: Array<{ number: number }>;
  app?: { name: string };
}

interface GitHubWebhookPayload {
  repository?: { full_name: string; html_url: string };
  sender?: GitHubUser;
  action?: string;
  pull_request?: GitHubPullRequest;
  issue?: {
    number: number;
    title: string;
    html_url: string;
    body?: string;
    labels?: Array<{ name: string }>;
  };
  comment?: {
    user?: GitHubUser;
    body?: string;
    path?: string;
    line?: number;
  };
  review?: {
    user?: GitHubUser;
    state: string;
    body?: string;
  };
  requested_reviewer?: GitHubUser;
  check_suite?: GitHubCheckSuite;
  check_run?: GitHubCheckSuite;
  ref?: string;
  commits?: Array<{ id: string; message: string }>;
}

interface DispatchFailureOpts {
  source: string;
  cardId?: string;
  cardTitle: string;
  projectId?: string;
  agentName?: string | null;
  reason: string;
  error?: unknown;
}

interface ReviewCommentEntry {
  path: string;
  line?: number;
  body?: string;
  author: string;
}

interface PendingReviewEntry {
  timer: ReturnType<typeof setTimeout> | null;
  comments: ReviewCommentEntry[];
  card: KanbanCardRow;
  project: Project;
  cols: KanbanColumnRow[];
  prNumber?: number;
  repoFullName?: string;
  sender: string;
}

interface BoardData {
  board: KanbanBoardRow;
  columns: KanbanColumnRow[];
  cards: KanbanCardRow[];
  epics: KanbanEpicRow[];
}

// ─── Shared helpers (used by multiple routes and index.js) ──────

export function getWebhookCallbackUrl(): string {
  const baseUrl = config.publicUrl || `http://localhost:${config.port}`;
  return `${baseUrl.replace(/\/+$/, '')}/api/webhooks/github`;
}

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) throw new Error('Cannot parse repo owner/name from URL');
  return { owner: match[1], repo: match[2] };
}

export function ghApi(...args: string[]): string {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf-8', timeout: 15000 });
}

export async function registerWebhookOnGitHub(webhookConfig: WebhookConfigRow): Promise<{
  ok: boolean;
  hookId: number;
  url: string;
  events: string[];
  updated: boolean;
}> {
  const { owner, repo } = parseGitHubRepo(webhookConfig.repo_url);
  const webhookUrl = getWebhookCallbackUrl();

  const events = Object.keys(JSON.parse(webhookConfig.events || '{}')).map((e) => e.split('.')[0]);
  const uniqueEvents = [...new Set(events)].filter(Boolean);
  if (uniqueEvents.length === 0) uniqueEvents.push('push', 'pull_request', 'issues');

  try {
    const existingRaw = ghApi(
      `repos/${owner}/${repo}/hooks`,
      '--jq',
      `[.[] | select(.config.url=="${webhookUrl}")]`,
    );
    const existing = JSON.parse(existingRaw || '[]') as Array<{ id: number }>;
    if (existing.length > 0) {
      const hookId = existing[0].id;
      const updateArgs = [
        `repos/${owner}/${repo}/hooks/${hookId}`,
        '--method',
        'PATCH',
        '--field',
        'active=true',
        '--field',
        `config[url]=${webhookUrl}`,
        '--field',
        'config[content_type]=json',
        '--field',
        `config[secret]=${webhookConfig.secret}`,
        ...uniqueEvents.flatMap((e) => ['--field', `events[]=${e}`]),
      ];
      const result = JSON.parse(ghApi(...updateArgs)) as { id: number };
      return { ok: true, hookId: result.id, url: webhookUrl, events: uniqueEvents, updated: true };
    }
  } catch {
    // If listing fails (permissions etc.), fall through to create
  }

  const createArgs = [
    `repos/${owner}/${repo}/hooks`,
    '--method',
    'POST',
    '--field',
    'name=web',
    '--field',
    'active=true',
    '--field',
    `config[url]=${webhookUrl}`,
    '--field',
    'config[content_type]=json',
    '--field',
    `config[secret]=${webhookConfig.secret}`,
    ...uniqueEvents.flatMap((e) => ['--field', `events[]=${e}`]),
  ];
  const result = JSON.parse(ghApi(...createArgs)) as { id: number };
  return { ok: true, hookId: result.id, url: webhookUrl, events: uniqueEvents, updated: false };
}

// ─── Dispatch Failure Observability ─────────────────────────────

export function notifyDispatchFailure(
  deps: { stmts: Stmts; broadcast: BroadcastFn },
  { source, cardId, cardTitle, projectId, agentName, reason, error }: DispatchFailureOpts,
): void {
  const { stmts, broadcast } = deps;
  const errObj = error instanceof Error ? error : null;
  const errMessage = errObj?.message || (error ? String(error) : null);
  const fullMessage = `[${source}] Dispatch failed for "${cardTitle}"${agentName ? ` (agent: ${agentName})` : ''}: ${reason}`;

  if (error) {
    console.error(fullMessage, { cardId, projectId, stack: errObj?.stack });
  } else {
    console.error(fullMessage, { cardId, projectId });
  }

  broadcast({
    type: 'dispatch_failure',
    source,
    cardId,
    cardTitle,
    projectId,
    agentName: agentName || null,
    reason,
    error: errMessage,
    timestamp: new Date().toISOString(),
  });

  if (cardId) {
    try {
      const commentId = uuidv4();
      stmts.createKanbanCardComment.run(
        commentId,
        cardId,
        'system',
        `⚠️ **Dispatch failure** (${source})\n\n${reason}${errMessage ? `\n\n\`\`\`\n${errMessage}\n\`\`\`` : ''}`,
      );
    } catch (commentErr: unknown) {
      const msg = commentErr instanceof Error ? commentErr.message : String(commentErr);
      console.error(`[${source}] Failed to add card comment:`, msg);
    }
  }

  if (projectId) {
    try {
      createEscalation(
        { stmts, broadcast },
        {
          projectId,
          type: 'blocker',
          title: `Dispatch failed: ${cardTitle || source}`,
          description: `${reason}${errMessage ? `\n\nError: ${errMessage}` : ''}`,
          cardId: cardId || null,
          source: source || 'dispatch',
          skipSlack: true,
        },
      );
    } catch (escalationErr: unknown) {
      const msg = escalationErr instanceof Error ? escalationErr.message : String(escalationErr);
      console.error(`[${source}] Failed to create escalation:`, msg);
    }
  }

  if (config.slackWebhookUrl) {
    fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `⚠️ *Dispatch Failure* (${source})\n*Card:* ${cardTitle}\n${agentName ? `*Agent:* ${agentName}\n` : ''}*Reason:* ${reason}`,
      }),
    }).catch((slackErr: unknown) => {
      const msg = slackErr instanceof Error ? slackErr.message : String(slackErr);
      console.error(`[${source}] Failed to send Slack notification:`, msg);
    });
  }
}

// ─── Review Feedback Dispatch ───────────────────────────────────

interface ReviewDispatchDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  findAgent(agentId: string): { project: Project; agent: Agent } | null;
  handleChat(ws: unknown, msg: ChatMessage): Promise<void>;
}

export function dispatchReviewFeedback(
  deps: ReviewDispatchDeps,
  card: KanbanCardRow,
  project: Project,
  feedbackContent: string,
): string | null {
  const { stmts, findAgent, handleChat } = deps;
  try {
    if (card.session_id) {
      const existingSession = stmts.getSession.get(card.session_id) as SessionRow | undefined;
      if (existingSession) {
        const agentExists = findAgent(existingSession.agent_id);
        if (agentExists) {
          handleChat(null, {
            type: 'chat',
            agentId: existingSession.agent_id,
            sessionId: card.session_id,
            content: feedbackContent,
          });
          return card.session_id;
        }
      }
    }

    let agent: Agent | null = null;
    if (card.assignee) {
      agent = project.agents.find((a) => a.name === card.assignee) || null;
    }
    if (!agent) {
      agent =
        project.agents.find((a) => a.role !== 'lead' && a.role !== 'docs' && a.role !== 'intake') ||
        null;
    }
    if (!agent) {
      notifyDispatchFailure(deps, {
        source: 'ReviewDispatch',
        cardId: card.id,
        cardTitle: card.title,
        projectId: project.id,
        reason: `No eligible agent found (assignee: ${card.assignee || 'none'}, no fallback non-lead/non-docs/non-intake agent available)`,
      });
      return null;
    }

    const sessionId = crypto.randomUUID();
    const engine = agent.engine || 'claude-code';
    stmts.createSession.run(
      sessionId,
      agent.id,
      `Review fixes: ${card.title}`,
      engine,
      (agent.model as string | undefined) || defaultModelForEngine(engine),
      1,
      0,
    );

    stmts.updateKanbanCard.run(
      card.title,
      card.description,
      card.priority,
      card.assignee,
      card.labels,
      sessionId,
      card.github_issue_url,
      card.pr_url,
      card.epic_id,
      card.id,
    );

    console.log(
      `[ReviewDispatch] Created new session ${sessionId} for "${card.title}" → agent "${agent.name}"`,
    );

    handleChat(null, {
      type: 'chat',
      agentId: agent.id,
      sessionId,
      content: feedbackContent,
      hookSpecificOutput: { sessionTitle: `Review fixes: ${card.title}` },
    });
    return sessionId;
  } catch (err: unknown) {
    notifyDispatchFailure(deps, {
      source: 'ReviewDispatch',
      cardId: card?.id,
      cardTitle: card?.title || 'unknown',
      projectId: project?.id,
      agentName: card?.assignee,
      reason: 'Unexpected error during review feedback dispatch',
      error: err,
    });
    return null;
  }
}

// ─── Review Comment Batching ────────────────────────────────────

export const pendingReviewComments = new Map<string, PendingReviewEntry>();
const REVIEW_COMMENT_BATCH_DELAY_MS = 5000;

function enqueueReviewComment(
  deps: RouteDeps,
  card: KanbanCardRow,
  project: Project,
  cols: KanbanColumnRow[],
  payload: GitHubWebhookPayload,
  sender: string,
): void {
  const comment = payload.comment;
  const prNumber = payload.pull_request?.number;
  const repoFullName = payload.repository?.full_name;

  const entry = pendingReviewComments.get(card.id) || {
    timer: null,
    comments: [],
    card,
    project,
    cols,
    prNumber,
    repoFullName,
    sender,
  };

  entry.comments.push({
    path: comment?.path || '(general)',
    line: comment?.line,
    body: comment?.body,
    author: sender,
  });

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushReviewComments(deps, card.id), REVIEW_COMMENT_BATCH_DELAY_MS);

  pendingReviewComments.set(card.id, entry);
}

function flushReviewComments(deps: RouteDeps, cardId: string): void {
  const entry = pendingReviewComments.get(cardId);
  if (!entry || entry.comments.length === 0) return;
  pendingReviewComments.delete(cardId);

  const { card, project, comments, prNumber, repoFullName } = entry;
  const commentList = comments
    .map(
      (c, i) =>
        `### Comment ${i + 1}\n**File:** ${c.path}${c.line ? ` (line ${c.line})` : ''}\n**From:** ${c.author}\n> ${c.body}`,
    )
    .join('\n\n');

  const feedbackContent = `# New Review Comments on PR #${prNumber}

${comments.length} new inline comment(s) received. Please address each one:

${commentList}

## What to do:
1. Read each comment and make the necessary code changes
2. If a comment is a question or discussion point, respond with a comment on the PR
3. After addressing all comments, commit and push:
   \`\`\`bash
   git add -A -- ':!node_modules' ':!*/node_modules'
   git commit -m "Address review comments"
   git push
   \`\`\`
**Important:** Always prefix your comment body with \`<!-- agent-hub-bot -->\` so the system knows it was posted by an agent:
\`\`\`bash
gh api repos/${repoFullName}/pulls/${prNumber}/comments -f body="<!-- agent-hub-bot -->
Your response here"
\`\`\``;

  const sessionId = dispatchReviewFeedback(deps, card, project, feedbackContent);
  if (sessionId) {
    console.log(
      `[ReviewBatch] Flushed ${comments.length} comment(s) for card "${card.title}" → session ${sessionId}`,
    );
  }
}

// ─── Webhook Context Builder ────────────────────────────────────

function buildWebhookContext(event: string, action: string, payload: GitHubWebhookPayload): string {
  const repo = payload.repository?.full_name || 'unknown';
  const sender = payload.sender?.login || 'unknown';
  const lines: string[] = [
    `Event: ${event}${action ? '.' + action : ''}`,
    `Repository: ${repo}`,
    `Triggered by: ${sender}`,
  ];

  if (event === 'pull_request' && payload.pull_request) {
    const pr = payload.pull_request;
    lines.push(`PR #${pr.number}: ${pr.title}`);
    lines.push(`Branch: ${pr.head?.ref} → ${pr.base?.ref}`);
    lines.push(`URL: ${pr.html_url}`);
    if (pr.body) lines.push(`Description: ${pr.body.substring(0, 500)}`);
    lines.push(
      `Changed files: ${pr.changed_files}, Additions: ${pr.additions}, Deletions: ${pr.deletions}`,
    );
  } else if (event === 'issues' && payload.issue) {
    const issue = payload.issue;
    lines.push(`Issue #${issue.number}: ${issue.title}`);
    lines.push(`URL: ${issue.html_url}`);
    if (issue.body) lines.push(`Body: ${issue.body.substring(0, 500)}`);
    lines.push(`Labels: ${(issue.labels || []).map((l) => l.name).join(', ') || 'none'}`);
  } else if (event === 'push') {
    lines.push(`Branch: ${payload.ref}`);
    lines.push(`Commits: ${(payload.commits || []).length}`);
    (payload.commits || []).slice(0, 5).forEach((c) => {
      lines.push(`  - ${c.id.substring(0, 7)}: ${c.message.split('\n')[0]}`);
    });
  } else if (event === 'issue_comment' || event === 'pull_request_review_comment') {
    const comment = payload.comment;
    lines.push(`Comment by: ${comment?.user?.login}`);
    lines.push(`Body: ${(comment?.body || '').substring(0, 500)}`);
    if (payload.issue) lines.push(`On issue #${payload.issue.number}: ${payload.issue.title}`);
    if (payload.pull_request)
      lines.push(`On PR #${payload.pull_request.number}: ${payload.pull_request.title}`);
  } else if (event === 'pull_request_review') {
    const review = payload.review;
    const pr = payload.pull_request;
    lines.push(`PR #${pr?.number}: ${pr?.title}`);
    lines.push(`URL: ${pr?.html_url}`);
    lines.push(`Review by: ${review?.user?.login}`);
    lines.push(`State: ${review?.state}`);
    if (review?.body) lines.push(`Body: ${review.body.substring(0, 500)}`);
  } else if (event === 'check_suite' || event === 'check_run') {
    const check = payload.check_suite || payload.check_run;
    lines.push(`Status: ${check?.status}, Conclusion: ${check?.conclusion}`);
    if (check?.pull_requests?.length) {
      lines.push(`PRs: ${check.pull_requests.map((p) => '#' + p.number).join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ─── Kanban Board Webhook Lifecycle Handlers ────────────────────

function handleKanbanWebhookEvent(
  deps: RouteDeps,
  event: string,
  action: string,
  payload: GitHubWebhookPayload,
  webhookConfig: WebhookConfigRow,
): boolean {
  const { stmts, broadcast, getProjects } = deps;
  const projects = getProjects();

  let prUrl: string | null = null;
  if (payload.pull_request?.html_url) {
    prUrl = payload.pull_request.html_url;
  } else if (event === 'check_suite' || event === 'check_run') {
    const prs = (payload.check_suite || payload.check_run)?.pull_requests;
    if (prs?.length) {
      const repoUrl = payload.repository?.html_url;
      if (repoUrl) prUrl = `${repoUrl}/pull/${prs[0].number}`;
    }
  }

  if (!prUrl) return false;

  let card = stmts.getKanbanCardByPrUrl?.get(prUrl) as KanbanCardRow | undefined;

  if (!card && payload.pull_request?.head?.ref) {
    const branchSessionMatch = payload.pull_request.head.ref.match(/session-([a-f0-9]{8})/);
    if (branchSessionMatch) {
      const shortId = branchSessionMatch[1];
      const boardData = getOrCreateBoard(stmts, webhookConfig.project_id) as BoardData | null;
      if (boardData?.board) {
        const allCards = stmts.getKanbanCards.all(boardData.board.id) as KanbanCardRow[];
        card = allCards.find((c) => c.session_id && c.session_id.startsWith(shortId));
        if (card && !card.pr_url) {
          try {
            stmts.setCardPrUrl.run(prUrl, card.id);
            console.log(
              `[Webhook/Kanban] Auto-linked PR URL on card "${card.title}" via branch session ID`,
            );
          } catch (_e) {
            /* non-critical */
          }
        }
      }
    }
  }

  if (!card) return false;

  const project = projects.find((p) => p.id === webhookConfig.project_id);
  if (!project) return false;

  const boardData = getOrCreateBoard(stmts, project.id) as BoardData | null;
  if (!boardData?.board) return false;
  const cols = stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];

  const eventKey = action ? `${event}.${action}` : event;
  const sender = payload.sender?.login || 'unknown';

  switch (eventKey) {
    case 'pull_request_review.submitted':
      return handleWebhookPrReview(deps, card, project, cols, payload, sender);
    case 'pull_request.review_requested':
      return handleWebhookReviewRequested(deps, card, project, cols, payload, sender);
    case 'pull_request.closed':
      return handleWebhookPrClosed(deps, card, project, cols, payload, sender);
    case 'pull_request.synchronize':
      return handleWebhookPrSynchronize(deps, card, project, cols, payload, sender);
    case 'check_suite.completed':
      return handleWebhookCheckSuiteCompleted(deps, card, project, cols, payload, sender);
    case 'pull_request_review_comment.created':
      return handleWebhookReviewComment(deps, card, project, cols, payload, sender);
    default:
      return false;
  }
}

function handleWebhookPrReview(
  deps: RouteDeps,
  card: KanbanCardRow,
  project: Project,
  cols: KanbanColumnRow[],
  payload: GitHubWebhookPayload,
  sender: string,
): boolean {
  const { stmts, broadcast, getGhBotUser, getGhAppSlug } = deps;
  const getGhAuthenticatedUser = deps.getGhAuthenticatedUser as () => string | null;
  const review = payload.review;
  if (!review) return false;

  const ghAuthenticatedUser = getGhAuthenticatedUser();
  const ghBotUser = getGhBotUser();
  const ghAppSlug = getGhAppSlug();
  const appBotLogin = ghAppSlug ? `${ghAppSlug}[bot]` : null;

  if (
    (ghAuthenticatedUser && sender === ghAuthenticatedUser) ||
    (ghBotUser && sender === ghBotUser) ||
    (appBotLogin && sender === appBotLogin)
  ) {
    console.log(
      `[Webhook/Kanban] Skipping self-triggered review on "${card.title}" from ${sender}`,
    );
    return false;
  }

  const state = review.state;
  const prNumber = payload.pull_request?.number;
  const reviewBody = review.body || '';

  console.log(`[Webhook/Kanban] PR review on "${card.title}" — state: ${state}, by: ${sender}`);

  if (state === 'approved') {
    const isAutonomous = card.epic_id
      ? !!(stmts.getKanbanEpic.get(card.epic_id) as KanbanEpicRow | undefined)?.autonomous
      : false;

    if (!isAutonomous) {
      const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
      if (reviewCol && card.column_id !== reviewCol.id) {
        stmts.moveKanbanCard.run(reviewCol.id, 0, card.id);
        broadcast({ type: 'kanban_update', projectId: project.id });
      }
      console.log(
        `[Webhook/Kanban] Card "${card.title}" approved by ${sender} — ready for human merge`,
      );
    } else {
      console.log(
        `[Webhook/Kanban] Card "${card.title}" approved by ${sender} (autonomous — merge event will move to Done)`,
      );
    }

    broadcast({
      type: 'webhook_pr_review',
      projectId: project.id,
      cardId: card.id,
      cardTitle: card.title,
      state: 'approved',
      reviewer: sender,
      prNumber,
    });
    return true;
  } else if (state === 'changes_requested') {
    const feedbackMessage = `# PR Review Feedback (via GitHub)

**Reviewer:** ${sender}
**PR:** #${prNumber}

The reviewer has requested changes on your PR. Please address the feedback and push fixes.

## Review comment:
${reviewBody || '(No body — check inline comments on the PR)'}

## What to do:
1. Read the full review: \`gh pr view ${prNumber} --comments\`
2. Check for inline comments: \`gh api repos/${payload.repository?.full_name}/pulls/${prNumber}/comments\`
3. Address each issue — fix the code
4. Commit and push to the same branch:
   \`\`\`bash
   git add -A -- ':!node_modules' ':!*/node_modules'
   git commit -m "Address review feedback from ${sender}"
   git push
   \`\`\``;

    const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');
    if (inProgressCol) {
      stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
      broadcast({ type: 'kanban_update', projectId: project.id });
    }

    const sessionId = dispatchReviewFeedback(deps, card, project, feedbackMessage);
    console.log(
      `[Webhook/Kanban] Changes requested on "${card.title}" by ${sender} — dispatched to session ${sessionId || '(failed)'}`,
    );

    if (prNumber) {
      const existing = stmts.getRecentEscalationByTypeAndPr.get(
        project.id,
        'review_needed',
        prNumber,
      );
      if (!existing) {
        createEscalation(
          { stmts, broadcast },
          {
            projectId: project.id,
            type: 'review_needed',
            title: `Changes requested on PR #${prNumber} by ${sender}`,
            description: `A reviewer has requested changes on "${card.title}". The agent will attempt to address the feedback, but human review may be needed to verify the changes are correct.\n\n**Reviewer comment:**\n${reviewBody?.substring(0, 500) || '(see inline comments)'}`,
            prNumber,
            prUrl: payload.pull_request?.html_url || null,
            cardId: card.id,
            source: 'webhook',
          },
        );
      }
    }

    broadcast({
      type: 'webhook_pr_review',
      projectId: project.id,
      cardId: card.id,
      cardTitle: card.title,
      state: 'changes_requested',
      reviewer: sender,
      prNumber,
    });
    return true;
  } else if (state === 'commented' && reviewBody && reviewBody.trim().length > 20) {
    const feedbackMessage = `# PR Review Comment (via GitHub)

**Reviewer:** ${sender}
**PR:** #${prNumber}

A reviewer left comments on your PR. Please review and address if needed.

## Review comment:
${reviewBody}

## What to do:
1. Read the full review: \`gh pr view ${prNumber} --comments\`
2. Check for inline comments: \`gh api repos/${payload.repository?.full_name}/pulls/${prNumber}/comments\`
3. If changes are needed, fix the code and push
4. If it's informational, acknowledge with a comment on the PR

**Important:** Always prefix your comment body with \`<!-- agent-hub-bot -->\` so the system knows it was posted by an agent.`;

    const sessionId = dispatchReviewFeedback(deps, card, project, feedbackMessage);
    console.log(
      `[Webhook/Kanban] Commented review on "${card.title}" by ${sender} (substantive) — dispatched to session ${sessionId || '(failed)'}`,
    );

    broadcast({
      type: 'webhook_pr_review',
      projectId: project.id,
      cardId: card.id,
      cardTitle: card.title,
      state: 'commented',
      reviewer: sender,
      prNumber,
    });
    return true;
  }

  return false;
}

function handleWebhookReviewRequested(
  deps: RouteDeps,
  card: KanbanCardRow,
  project: Project,
  cols: KanbanColumnRow[],
  payload: GitHubWebhookPayload,
  sender: string,
): boolean {
  const { stmts, broadcast, getGhBotUser } = deps;
  const getGhAuthenticatedUser = deps.getGhAuthenticatedUser as () => string | null;
  const getReviewSessionCards = deps.getReviewSessionCards as () => Map<string, { prUrl: string }>;
  const leadReviewPR = deps.leadReviewPR as (
    project: Project,
    prUrl: string,
    card: KanbanCardRow,
    subAgent: Agent | null,
  ) => Promise<void>;
  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return false;

  const ghAuthenticatedUser = getGhAuthenticatedUser();
  const ghBotUser = getGhBotUser();
  const ghAppSlug = deps.getGhAppSlug?.();

  const requestedReviewer = payload.requested_reviewer?.login;
  const reviewer =
    ((project as Record<string, unknown>).defaultReviewer as string | undefined) ||
    config.defaultReviewer;

  // Match against all known bot identities including the GitHub App bot login (slug[bot])
  const appBotLogin = ghAppSlug ? `${ghAppSlug}[bot]` : null;
  const isOurReviewer =
    (ghAuthenticatedUser && requestedReviewer === ghAuthenticatedUser) ||
    (ghBotUser && requestedReviewer === ghBotUser) ||
    (reviewer && requestedReviewer === reviewer) ||
    (appBotLogin && requestedReviewer === appBotLogin);

  if (!isOurReviewer) {
    console.log(
      `[Webhook/Kanban] review_requested for "${requestedReviewer}" — not our reviewer, skipping`,
    );
    return false;
  }

  const reviewSessionCards = getReviewSessionCards();
  const existingReviewSession = [...reviewSessionCards.values()].find((r) => r.prUrl === prUrl);
  if (existingReviewSession) {
    console.log(`[Webhook/Kanban] Review session already exists for ${prUrl} — skipping`);
    return true;
  }

  console.log(
    `[Webhook/Kanban] Review requested on "${card.title}" by ${sender} for ${requestedReviewer} — triggering lead review`,
  );

  let subAgent: Agent | null = null;
  if (card.session_id) {
    const session = stmts.getSession?.get(card.session_id) as SessionRow | undefined;
    if (session) {
      subAgent = project.agents?.find((a) => a.id === session.agent_id) || null;
    }
  }

  const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
  if (reviewCol && card.column_id !== reviewCol.id) {
    stmts.moveKanbanCard.run(reviewCol.id, 0, card.id);
    broadcast({ type: 'kanban_update', projectId: project.id });
  }

  leadReviewPR(project, prUrl, card, subAgent).catch((err: Error) => {
    console.error(`[Lead Review] Failed to start from webhook:`, err.message);
  });

  return true;
}

function handleWebhookPrClosed(
  deps: RouteDeps,
  card: KanbanCardRow,
  project: Project,
  cols: KanbanColumnRow[],
  payload: GitHubWebhookPayload,
  sender: string,
): boolean {
  const { stmts, broadcast } = deps;
  const tryAutonomousDispatch = deps.tryAutonomousDispatch as () => void;
  const merged = payload.pull_request?.merged === true;
  const prNumber = payload.pull_request?.number;

  if (merged) {
    const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
    if (doneCol && card.column_id !== doneCol.id) {
      stmts.moveKanbanCard.run(doneCol.id, 0, card.id);
      broadcast({ type: 'kanban_update', projectId: project.id });
      console.log(`[Webhook/Kanban] PR #${prNumber} merged — card "${card.title}" moved to Done`);
    }

    broadcast({
      type: 'webhook_pr_merged',
      projectId: project.id,
      cardId: card.id,
      cardTitle: card.title,
      prNumber,
      mergedBy: sender,
    });

    tryAutonomousDispatch();
    return true;
  } else {
    const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');
    if (inProgressCol && card.column_id !== inProgressCol.id) {
      stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
      broadcast({ type: 'kanban_update', projectId: project.id });
      console.log(
        `[Webhook/Kanban] PR #${prNumber} closed without merge — card "${card.title}" moved to In Progress`,
      );
    }

    broadcast({
      type: 'webhook_pr_closed',
      projectId: project.id,
      cardId: card.id,
      cardTitle: card.title,
      prNumber,
      closedBy: sender,
    });
    return true;
  }
}

function handleWebhookPrSynchronize(
  deps: RouteDeps,
  card: KanbanCardRow,
  project: Project,
  _cols: KanbanColumnRow[],
  payload: GitHubWebhookPayload,
  sender: string,
): boolean {
  const { stmts, broadcast } = deps;
  const prNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha?.substring(0, 7);
  const mergeable = payload.pull_request?.mergeable;

  console.log(`[Webhook/Kanban] PR #${prNumber} updated (${headSha}) — card "${card.title}"`);

  if (mergeable === false && prNumber) {
    const existing = stmts.getRecentEscalationByTypeAndPr.get(
      project.id,
      'merge_conflict',
      prNumber,
    );
    if (!existing) {
      createEscalation(
        { stmts, broadcast },
        {
          projectId: project.id,
          type: 'merge_conflict',
          title: `Merge conflicts on PR #${prNumber}`,
          description: `PR "${card.title}" has merge conflicts that need to be resolved. The branch cannot be merged automatically.\n\nRebase or merge the base branch to resolve conflicts.`,
          prNumber,
          prUrl: payload.pull_request?.html_url || null,
          cardId: card.id,
          source: 'webhook',
        },
      );
    }
  }

  broadcast({
    type: 'webhook_pr_pushed',
    projectId: project.id,
    cardId: card.id,
    cardTitle: card.title,
    prNumber,
    headSha,
    pushedBy: sender,
  });
  return true;
}

function handleWebhookCheckSuiteCompleted(
  deps: RouteDeps,
  card: KanbanCardRow,
  project: Project,
  cols: KanbanColumnRow[],
  payload: GitHubWebhookPayload,
  _sender: string,
): boolean {
  const { stmts, broadcast, handleChat } = deps;
  const checkSuite = payload.check_suite;
  if (!checkSuite) return false;

  const conclusion = checkSuite.conclusion;
  const prs = checkSuite.pull_requests || [];
  const prNumber = prs[0]?.number;

  console.log(`[Webhook/Kanban] CI ${conclusion} on card "${card.title}" (PR #${prNumber || '?'})`);

  broadcast({
    type: 'webhook_ci_completed',
    projectId: project.id,
    cardId: card.id,
    cardTitle: card.title,
    prNumber,
    conclusion,
    checkSuiteName: checkSuite.app?.name || 'CI',
  });

  if (conclusion === 'failure' && card.session_id) {
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    if (reviewCol && card.column_id === reviewCol.id) {
      const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');

      if (inProgressCol) {
        stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
        broadcast({ type: 'kanban_update', projectId: project.id });
      }

      if (prNumber) {
        const existing = stmts.getAnyRecentEscalationByTypeAndPr.get(
          project.id,
          'ci_failure',
          prNumber,
        );
        if (existing) {
          console.log(
            `[Webhook/Kanban] Repeated CI failure on PR #${prNumber} — escalating to human`,
          );
          createEscalation(
            { stmts, broadcast },
            {
              projectId: project.id,
              type: 'ci_failure',
              title: `CI failing repeatedly on PR #${prNumber}`,
              description: `CI checks have failed multiple times on "${card.title}". The agent was unable to fix the issue automatically. Human intervention is needed to diagnose and resolve the failures.\n\nCheck suite: ${checkSuite.app?.name || 'CI'}`,
              prNumber,
              prUrl: payload.repository
                ? `https://github.com/${payload.repository.full_name}/pull/${prNumber}`
                : null,
              cardId: card.id,
              source: 'webhook',
            },
          );
        } else {
          createEscalation(
            { stmts, broadcast },
            {
              projectId: project.id,
              type: 'ci_failure',
              title: `CI failed on PR #${prNumber}`,
              description: `CI checks failed on "${card.title}". The agent has been notified to fix the issue.\n\nCheck suite: ${checkSuite.app?.name || 'CI'}`,
              prNumber,
              prUrl: payload.repository
                ? `https://github.com/${payload.repository.full_name}/pull/${prNumber}`
                : null,
              cardId: card.id,
              source: 'webhook',
              silent: true,
            },
          );
        }
      }

      const originalSession = stmts.getSession.get(card.session_id) as SessionRow | undefined;
      if (originalSession) {
        console.log(
          `[Webhook/Kanban] CI failed — dispatching fix request to session ${card.session_id}`,
        );
        handleChat(null, {
          type: 'chat',
          agentId: originalSession.agent_id,
          sessionId: card.session_id,
          content: `# CI Check Failed

The CI checks on your PR have **failed**. Please investigate and fix.

## What to do:
1. Check the failure details: \`gh pr checks ${prNumber || ''}\`
2. Read the logs for failing checks
3. Fix the issues in your code
4. Commit and push:
   \`\`\`bash
   git add -A -- ':!node_modules' ':!*/node_modules'
   git commit -m "Fix CI failures"
   git push
   \`\`\`

The CI will re-run automatically after you push.`,
        });
      }
    }
  }

  return true;
}

function handleWebhookReviewComment(
  deps: RouteDeps,
  card: KanbanCardRow,
  project: Project,
  cols: KanbanColumnRow[],
  payload: GitHubWebhookPayload,
  sender: string,
): boolean {
  const { broadcast, getGhBotUser } = deps;
  const getGhAuthenticatedUser = deps.getGhAuthenticatedUser as () => string | null;
  const comment = payload.comment;
  const prNumber = payload.pull_request?.number;
  if (!comment) return false;

  const ghAuthenticatedUser = getGhAuthenticatedUser();
  const ghBotUser = getGhBotUser();

  const botUsers = ['github-actions[bot]', 'github-actions'];
  if (botUsers.includes(sender)) return false;
  if (ghAuthenticatedUser && sender === ghAuthenticatedUser) return false;
  if (ghBotUser && sender === ghBotUser) return false;

  if (comment.body?.includes('<!-- agent-hub-bot -->')) return false;

  console.log(
    `[Webhook/Kanban] Review comment on "${card.title}" (PR #${prNumber}) by ${sender}: ${comment.body?.substring(0, 80)}`,
  );

  enqueueReviewComment(deps, card, project, cols, payload, sender);

  broadcast({
    type: 'webhook_review_comment',
    projectId: project.id,
    cardId: card.id,
    cardTitle: card.title,
    prNumber,
    commenter: sender,
    commentBody: comment.body?.substring(0, 200),
  });
  return true;
}

// ─── GitHub Webhook Handler (public — uses HMAC, not API key) ───

export function createGithubWebhookHandler(deps: RouteDeps): Router {
  const { stmts, broadcast, getProjects } = deps;
  const runClaudeFn = deps.runClaude as (
    prompt: string,
    cwd: string,
    model?: string,
    opts?: { timeoutMs: number },
  ) => Promise<string>;
  const router = Router();

  router.post('/api/webhooks/github', async (req: Request, res: Response) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!event || !req.body) {
      return res.status(400).json({ error: 'Missing event or body' });
    }

    const payload = req.body as GitHubWebhookPayload;
    const repoFullName = payload.repository?.full_name || '';

    const allConfigs = (stmts.getWebhookConfigs.all() as WebhookConfigRow[]).filter(
      (c) => c.enabled,
    );
    const webhookConfig = allConfigs.find((c) => {
      const stored = c.repo_url.replace(/\.git$/, '').toLowerCase();
      return (
        stored.includes(repoFullName.toLowerCase()) ||
        repoFullName.toLowerCase() ===
          stored
            .split('/')
            .slice(-2)
            .join('/')
            .replace(/^.*github\.com\//, '')
      );
    });

    if (!webhookConfig) {
      return res.status(404).json({ error: 'No webhook config found for this repository' });
    }

    if (signature && webhookConfig.secret) {
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      const expected =
        'sha256=' +
        crypto
          .createHmac('sha256', webhookConfig.secret)
          .update(rawBody || JSON.stringify(req.body))
          .digest('hex');

      try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          console.warn(
            `[Webhook] HMAC verification failed for ${repoFullName} — check that the webhook signing secret in GitHub repo/org settings matches Agent Hub’s webhook config for this repository (and that the server build includes raw-body HMAC verification).`,
          );
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } catch {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const action = payload.action || '';
    const eventKey = action ? `${event}.${action}` : event;

    let kanbanHandled = false;
    try {
      kanbanHandled = handleKanbanWebhookEvent(deps, event, action, payload, webhookConfig);
      if (kanbanHandled) {
        const logEntry = stmts.addWebhookLog.run(
          webhookConfig.id,
          eventKey,
          action,
          deliveryId || '',
          'success',
        );
        stmts.updateWebhookLog.run(
          'success',
          `Kanban lifecycle: ${eventKey}`,
          0,
          logEntry.lastInsertRowid,
        );
        console.log(`[Webhook] ${eventKey} on ${repoFullName} — kanban lifecycle handled`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Webhook] Kanban lifecycle handler error for ${eventKey}:`, msg);
    }

    const eventConfigs = JSON.parse(webhookConfig.events || '{}') as Record<
      string,
      { enabled?: boolean; prompt?: string } | undefined
    >;
    const handler = eventConfigs[eventKey] || eventConfigs[event];

    if (!handler || !handler.enabled) {
      if (kanbanHandled) {
        return res.json({ status: 'accepted', event: eventKey, kanban: true });
      }
      stmts.addWebhookLog.run(webhookConfig.id, eventKey, action, deliveryId || '', 'skipped');
      return res.json({ status: 'skipped', event: eventKey });
    }

    const logEntry = stmts.addWebhookLog.run(
      webhookConfig.id,
      eventKey,
      action,
      deliveryId || '',
      'running',
    );
    const logId = logEntry.lastInsertRowid;
    const startTime = Date.now();

    res.json({ status: 'accepted', event: eventKey, logId, kanban: kanbanHandled });

    const contextPayload = buildWebhookContext(event, action, payload);
    const fullPrompt = `${handler.prompt}\n\n## Webhook Context\n${contextPayload}`;

    const projects = getProjects();
    const project = projects.find((p) => p.id === webhookConfig.project_id);
    const cwd = project?.cwd || config.defaultCwd;

    try {
      const result = await runClaudeFn(fullPrompt, cwd, undefined, {
        timeoutMs: config.defaultTimeoutMs,
      });

      const durationMs = Date.now() - startTime;
      stmts.updateWebhookLog.run('success', result.substring(0, 10000), durationMs, logId);
      console.log(`[Webhook] ${eventKey} on ${repoFullName} completed (${durationMs}ms)`);

      broadcast({
        type: 'webhook_event',
        webhookConfigId: webhookConfig.id,
        event: eventKey,
        repo: repoFullName,
        status: 'success',
        logId,
      });
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      stmts.updateWebhookLog.run('error', msg, durationMs, logId);
      console.error(`[Webhook] ${eventKey} on ${repoFullName} failed:`, msg);

      broadcast({
        type: 'webhook_event',
        webhookConfigId: webhookConfig.id,
        event: eventKey,
        repo: repoFullName,
        status: 'error',
        logId,
      });
    }
  });

  return router;
}

// ─── Webhook CRUD routes (requires auth) ────────────────────────

export default function createWebhookRoutes(deps: RouteDeps): Router {
  const { stmts } = deps;
  const router = Router();

  router.get('/api/webhooks', (_req: Request, res: Response) => {
    res.json(stmts.getWebhookConfigs.all());
  });

  router.get('/api/webhooks/project/:projectId', (req: Request, res: Response) => {
    res.json(stmts.getWebhookConfigsByProject.all(req.params.projectId));
  });

  router.post('/api/webhooks', async (req: Request, res: Response) => {
    const { projectId, repoUrl, events, enabled, autoRegister } = req.body as {
      projectId?: string;
      repoUrl?: string;
      events?: Record<string, unknown>;
      enabled?: boolean;
      autoRegister?: boolean;
    };
    if (!projectId || !repoUrl)
      return res.status(400).json({ error: 'projectId and repoUrl required' });

    const secret = crypto.randomBytes(32).toString('hex');
    const result = stmts.createWebhookConfig.run(
      projectId,
      repoUrl,
      secret,
      JSON.stringify(events || {}),
      enabled !== false ? 1 : 0,
    );

    const created = stmts.getWebhookConfig.get(result.lastInsertRowid) as WebhookConfigRow;

    if (autoRegister) {
      try {
        const regResult = await registerWebhookOnGitHub(created);
        return res.json({ ...created, registration: regResult });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.json({ ...created, registration: { ok: false, error: msg } });
      }
    }

    res.json(created);
  });

  router.put('/api/webhooks/:id', (req: Request, res: Response) => {
    const { repoUrl, events, enabled } = req.body as {
      repoUrl?: string;
      events?: Record<string, unknown>;
      enabled?: boolean;
    };
    const existing = stmts.getWebhookConfig.get(parseInt(req.params.id as string)) as
      | WebhookConfigRow
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Not found' });

    stmts.updateWebhookConfig.run(
      repoUrl || existing.repo_url,
      JSON.stringify(events || JSON.parse(existing.events)),
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      existing.id,
    );

    res.json(stmts.getWebhookConfig.get(existing.id));
  });

  router.delete('/api/webhooks/:id', (req: Request, res: Response) => {
    stmts.deleteWebhookConfig.run(parseInt(req.params.id as string));
    res.json({ ok: true });
  });

  router.get('/api/webhooks/:id/logs', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    res.json(stmts.getWebhookLogs.all(parseInt(req.params.id as string), limit));
  });

  router.get('/api/webhooks/logs/recent', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    res.json(stmts.getRecentWebhookLogs.all(limit));
  });

  router.post('/api/webhooks/:id/register', async (req: Request, res: Response) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id as string)) as
      | WebhookConfigRow
      | undefined;
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    try {
      const result = await registerWebhookOnGitHub(webhookConfig);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to register webhook: ${msg}` });
    }
  });

  router.delete('/api/webhooks/:id/register', async (req: Request, res: Response) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id as string)) as
      | WebhookConfigRow
      | undefined;
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    let ownerRepo: { owner: string; repo: string };
    try {
      ownerRepo = parseGitHubRepo(webhookConfig.repo_url);
    } catch {
      return res.status(400).json({ error: 'Cannot parse repo from URL' });
    }

    const { owner, repo } = ownerRepo;
    const webhookUrl = getWebhookCallbackUrl();

    try {
      const existingRaw = ghApi(
        `repos/${owner}/${repo}/hooks`,
        '--jq',
        `[.[] | select(.config.url=="${webhookUrl}")]`,
      );
      const existing = JSON.parse(existingRaw || '[]') as Array<{ id: number }>;
      for (const hook of existing) {
        ghApi(`repos/${owner}/${repo}/hooks/${hook.id}`, '--method', 'DELETE');
      }
      res.json({ ok: true, removed: existing.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to unregister webhook: ${msg}` });
    }
  });

  router.get('/api/webhooks/:id/register', async (req: Request, res: Response) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id as string)) as
      | WebhookConfigRow
      | undefined;
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    let ownerRepo: { owner: string; repo: string };
    try {
      ownerRepo = parseGitHubRepo(webhookConfig.repo_url);
    } catch {
      return res.status(400).json({ error: 'Cannot parse repo from URL' });
    }

    const { owner, repo } = ownerRepo;
    const webhookUrl = getWebhookCallbackUrl();

    try {
      const existingRaw = ghApi(
        `repos/${owner}/${repo}/hooks`,
        '--jq',
        `[.[] | select(.config.url=="${webhookUrl}") | {id, active, events, config: {url: .config.url}, last_response: .last_response}]`,
      );
      const hooks = JSON.parse(existingRaw || '[]') as unknown[];
      res.json({ registered: hooks.length > 0, hooks, webhookUrl });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ registered: false, error: msg, webhookUrl });
    }
  });

  return router;
}
