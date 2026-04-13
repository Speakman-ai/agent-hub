import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { Router } from 'express';
import config, { defaultModelForEngine } from '../config.js';
import { getOrCreateBoard } from './board.js';

// ─── Shared helpers (used by multiple routes and index.js) ──────────

export function getWebhookCallbackUrl() {
  const baseUrl = config.publicUrl || `http://localhost:${config.port}`;
  return `${baseUrl.replace(/\/+$/, '')}/api/webhooks/github`;
}

export function parseGitHubRepo(repoUrl) {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) throw new Error('Cannot parse repo owner/name from URL');
  return { owner: match[1], repo: match[2] };
}

export function ghApi(...args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf-8', timeout: 15000 });
}

export async function registerWebhookOnGitHub(webhookConfig) {
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
    const existing = JSON.parse(existingRaw || '[]');
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
      const result = JSON.parse(ghApi(...updateArgs));
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
  const result = JSON.parse(ghApi(...createArgs));
  return { ok: true, hookId: result.id, url: webhookUrl, events: uniqueEvents, updated: false };
}

// ─── Dispatch Failure Observability ─────────────────────────────────
// Centralized handler for dispatch failures — logs, broadcasts, comments
// on the kanban card, and optionally notifies Slack.

/**
 * Report a dispatch failure with full context.
 * @param {object} deps - { stmts, broadcast }
 * @param {object} opts
 * @param {string} opts.source - e.g. 'ReviewDispatch', 'Autonomous'
 * @param {string} opts.cardId - kanban card ID (if available)
 * @param {string} opts.cardTitle - card title for human-readable messages
 * @param {string} opts.projectId - project ID for WebSocket broadcast
 * @param {string} [opts.agentName] - agent name if known
 * @param {string} opts.reason - human-readable failure reason
 * @param {Error}  [opts.error] - original error object if available
 */
export function notifyDispatchFailure(
  deps,
  { source, cardId, cardTitle, projectId, agentName, reason, error },
) {
  const { stmts, broadcast } = deps;
  const fullMessage = `[${source}] Dispatch failed for "${cardTitle}"${agentName ? ` (agent: ${agentName})` : ''}: ${reason}`;

  // 1. Console error with full context
  if (error) {
    console.error(fullMessage, { cardId, projectId, stack: error.stack });
  } else {
    console.error(fullMessage, { cardId, projectId });
  }

  // 2. WebSocket broadcast so the UI can display it
  broadcast({
    type: 'dispatch_failure',
    source,
    cardId,
    cardTitle,
    projectId,
    agentName: agentName || null,
    reason,
    error: error?.message || null,
    timestamp: new Date().toISOString(),
  });

  // 3. Add a comment on the kanban card so it's visible on the board
  if (cardId) {
    try {
      const commentId = uuidv4();
      stmts.createKanbanCardComment.run(
        commentId,
        cardId,
        'system',
        `⚠️ **Dispatch failure** (${source})\n\n${reason}${error ? `\n\n\`\`\`\n${error.message}\n\`\`\`` : ''}`,
      );
      // dispatch_failure broadcast already triggers kanban refresh on the client
    } catch (commentErr) {
      console.error(`[${source}] Failed to add card comment:`, commentErr.message);
    }
  }

  // 4. Optional Slack notification for visibility
  if (config.slackWebhookUrl) {
    fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `⚠️ *Dispatch Failure* (${source})\n*Card:* ${cardTitle}\n${agentName ? `*Agent:* ${agentName}\n` : ''}*Reason:* ${reason}`,
      }),
    }).catch((slackErr) => {
      console.error(`[${source}] Failed to send Slack notification:`, slackErr.message);
    });
  }
}

// ─── Review Feedback Dispatch ───────────────────────────────────────
// Ensures every batch of review feedback reaches the responsible agent,
// even when the original session has ended or no session_id is set.

/**
 * Dispatch review feedback to the agent responsible for a card.
 * If the card has a valid session_id, reuses it (handleChat spawns a new CLI
 * process if needed). If session_id is missing/invalid, creates a fresh session
 * for the card's assignee agent.
 *
 * Returns the sessionId used (or null if dispatch failed).
 * @param {object} deps - { stmts, broadcast, findAgent, handleChat, getProjects }
 * @param {object} card
 * @param {object} project
 * @param {string} feedbackContent
 */
export function dispatchReviewFeedback(deps, card, project, feedbackContent) {
  const { stmts, findAgent, handleChat } = deps;
  try {
    // 1. Try existing session_id on the card
    if (card.session_id) {
      const existingSession = stmts.getSession.get(card.session_id);
      if (existingSession) {
        const agentExists = findAgent(existingSession.agent_id);
        if (agentExists) {
          handleChat(null, {
            agentId: existingSession.agent_id,
            sessionId: card.session_id,
            content: feedbackContent,
          });
          return card.session_id;
        }
      }
    }

    // 2. No valid session — find the responsible agent from card.assignee
    let agent = null;
    if (card.assignee) {
      agent = project.agents.find((a) => a.name === card.assignee);
    }
    // 3. Fallback: use any non-lead, non-docs agent on the project
    if (!agent) {
      agent = project.agents.find(
        (a) => a.role !== 'lead' && a.role !== 'docs' && a.role !== 'intake',
      );
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

    // 4. Create a new session and link it to the card
    const sessionId = crypto.randomUUID();
    const engine = agent.engine || 'claude-code';
    stmts.createSession.run(
      sessionId,
      agent.id,
      `Review fixes: ${card.title}`,
      engine,
      agent.model || defaultModelForEngine(engine),
      1,
      0,
    );

    // Update card's session_id so future dispatches reuse it
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

    handleChat(null, { agentId: agent.id, sessionId, content: feedbackContent });
    return sessionId;
  } catch (err) {
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

// ─── Review Comment Batching ────────────────────────────────────────
// Consolidates multiple inline comments arriving in quick succession
// (e.g., a reviewer posting 5 inline comments at once) into a single
// dispatch message.

export const pendingReviewComments = new Map(); // key: cardId → { timer, comments: [], card, project, payload }
const REVIEW_COMMENT_BATCH_DELAY_MS = 5000; // 5 seconds to batch

function enqueueReviewComment(deps, card, project, cols, payload, sender) {
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
    path: comment.path || '(general)',
    line: comment.line,
    body: comment.body,
    author: sender,
  });

  // Reset or set the debounce timer
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushReviewComments(deps, card.id), REVIEW_COMMENT_BATCH_DELAY_MS);

  pendingReviewComments.set(card.id, entry);
}

function flushReviewComments(deps, cardId) {
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

// ─── Webhook Context Builder ────────────────────────────────────────

function buildWebhookContext(event, action, payload) {
  const repo = payload.repository?.full_name || 'unknown';
  const sender = payload.sender?.login || 'unknown';
  const lines = [
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
    lines.push(`State: ${review?.state}`); // approved, changes_requested, commented
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

// ─── Kanban Board Webhook Lifecycle Handlers ────────────────────────
// These handle GitHub webhook events programmatically to drive the kanban
// board PR lifecycle — no Claude session needed. They run BEFORE the generic
// webhook handler so kanban actions happen immediately.

function handleKanbanWebhookEvent(deps, event, action, payload, webhookConfig) {
  const { stmts, broadcast, getProjects } = deps;
  const projects = getProjects();

  // Extract PR URL from the payload — different events store it differently
  let prUrl = null;
  if (payload.pull_request?.html_url) {
    prUrl = payload.pull_request.html_url;
  } else if (event === 'check_suite' || event === 'check_run') {
    // check_suite/check_run link PRs via the pull_requests array
    const prs = (payload.check_suite || payload.check_run)?.pull_requests;
    if (prs?.length) {
      // Reconstruct the PR URL from the repo + PR number
      const repoUrl = payload.repository?.html_url;
      if (repoUrl) prUrl = `${repoUrl}/pull/${prs[0].number}`;
    }
  }

  if (!prUrl) return false;

  // Find the kanban card linked to this PR
  const card = stmts.getKanbanCardByPrUrl?.get(prUrl);
  if (!card) return false;

  const project = projects.find((p) => p.id === webhookConfig.project_id);
  if (!project) return false;

  const boardData = getOrCreateBoard(stmts, project.id);
  if (!boardData?.board) return false;
  const cols = stmts.getKanbanColumns.all(boardData.board.id);

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

/**
 * Handle pull_request_review.submitted — a review was submitted on a PR.
 * If approved → move card toward Done (or stay in Review for human merge).
 * If changes_requested → send feedback to the original agent's session.
 */
function handleWebhookPrReview(deps, card, project, cols, payload, sender) {
  const { stmts, broadcast, getGhAuthenticatedUser, getGhBotUser } = deps;
  const review = payload.review;
  if (!review) return false;

  const ghAuthenticatedUser = getGhAuthenticatedUser();
  const ghBotUser = getGhBotUser();

  // Skip reviews from our own gh CLI user or the bot account — the lead agent's
  // reviews are already handled by handleReviewOutcome. Processing them here
  // too would cause duplicate feedback and card moves.
  if (
    (ghAuthenticatedUser && sender === ghAuthenticatedUser) ||
    (ghBotUser && sender === ghBotUser)
  ) {
    console.log(
      `[Webhook/Kanban] Skipping self-triggered review on "${card.title}" from ${sender}`,
    );
    return false;
  }

  const state = review.state; // 'approved', 'changes_requested', 'commented', 'dismissed'
  const prNumber = payload.pull_request?.number;
  const reviewBody = review.body || '';

  console.log(`[Webhook/Kanban] PR review on "${card.title}" — state: ${state}, by: ${sender}`);

  if (state === 'approved') {
    // Check if autonomous — autonomous cards get auto-merged by the lead,
    // so the merge event will handle moving to Done. For non-autonomous,
    // this confirms the PR is approved and ready for human merge.
    const isAutonomous = card.epic_id ? !!stmts.getKanbanEpic.get(card.epic_id)?.autonomous : false;

    if (!isAutonomous) {
      // Ensure card is in Review column (it should be already)
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
    // Send feedback to the original agent's session (or create new one)
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

    // Move card back to In Progress
    const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');
    if (inProgressCol) {
      stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
      broadcast({ type: 'kanban_update', projectId: project.id });
    }

    const sessionId = dispatchReviewFeedback(deps, card, project, feedbackMessage);
    console.log(
      `[Webhook/Kanban] Changes requested on "${card.title}" by ${sender} — dispatched to session ${sessionId || '(failed)'}`,
    );

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
    // "Commented" reviews with substantive body text (e.g., from Bugbot, human
    // reviewers who use "comment" instead of "request changes"). Short/empty
    // body reviews are noise — only dispatch reviews with real content.
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

  // 'dismissed' or 'commented' with no body — log but don't take kanban action
  return false;
}

/**
 * Handle pull_request.review_requested — a review was requested on a PR.
 * If the requested reviewer matches our lead/bot, trigger leadReviewPR.
 * This catches PRs where the agent added --reviewer but the server didn't
 * trigger the review internally (e.g. agent created the PR itself).
 */
function handleWebhookReviewRequested(deps, card, project, cols, payload, sender) {
  const {
    stmts,
    broadcast,
    getGhAuthenticatedUser,
    getGhBotUser,
    getReviewSessionCards,
    leadReviewPR,
  } = deps;
  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return false;

  const ghAuthenticatedUser = getGhAuthenticatedUser();
  const ghBotUser = getGhBotUser();

  const requestedReviewer = payload.requested_reviewer?.login;
  const reviewer = project.defaultReviewer || config.defaultReviewer;

  // Only trigger if the requested reviewer matches our configured reviewer or bot
  const isOurReviewer =
    (ghAuthenticatedUser && requestedReviewer === ghAuthenticatedUser) ||
    (ghBotUser && requestedReviewer === ghBotUser) ||
    (reviewer && requestedReviewer === reviewer);

  if (!isOurReviewer) {
    console.log(
      `[Webhook/Kanban] review_requested for "${requestedReviewer}" — not our reviewer, skipping`,
    );
    return false;
  }

  // Check if a review session is already running for this PR
  const reviewSessionCards = getReviewSessionCards();
  const existingReviewSession = [...reviewSessionCards.values()].find((r) => r.prUrl === prUrl);
  if (existingReviewSession) {
    console.log(`[Webhook/Kanban] Review session already exists for ${prUrl} — skipping`);
    return true; // Handled (already reviewing)
  }

  console.log(
    `[Webhook/Kanban] Review requested on "${card.title}" by ${sender} for ${requestedReviewer} — triggering lead review`,
  );

  // Find the sub-agent that created this PR (from the card's session)
  let subAgent = null;
  if (card.session_id) {
    const session = stmts.getSession?.get(card.session_id);
    if (session) {
      subAgent = project.agents?.find((a) => a.id === session.agent_id);
    }
  }

  // Move card to Review if not already there
  const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
  if (reviewCol && card.column_id !== reviewCol.id) {
    stmts.moveKanbanCard.run(reviewCol.id, 0, card.id);
    broadcast({ type: 'kanban_update', projectId: project.id });
  }

  leadReviewPR(project, prUrl, card, subAgent).catch((err) => {
    console.error(`[Lead Review] Failed to start from webhook:`, err.message);
  });

  return true;
}

/**
 * Handle pull_request.closed — PR was closed (possibly merged).
 * If merged → move card to Done.
 * If closed without merge → move card back to In Progress.
 */
function handleWebhookPrClosed(deps, card, project, cols, payload, sender) {
  const { stmts, broadcast, tryAutonomousDispatch } = deps;
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

    // Slot freed — try dispatching next autonomous card
    tryAutonomousDispatch();
    return true;
  } else {
    // PR closed without merge — unusual, move back to In Progress for triage
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

/**
 * Handle pull_request.synchronize — new commits pushed to a PR branch.
 * Broadcasts an event so the UI can show activity. If the card was in
 * "In Progress" (agent fixing review comments), this confirms the push happened.
 */
function handleWebhookPrSynchronize(deps, card, project, cols, payload, sender) {
  const { broadcast } = deps;
  const prNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha?.substring(0, 7);

  console.log(`[Webhook/Kanban] PR #${prNumber} updated (${headSha}) — card "${card.title}"`);

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

/**
 * Handle check_suite.completed — CI checks finished on a PR.
 * Broadcasts the result so the lead reviewer (or UI) knows CI status
 * without needing to poll `gh pr checks`.
 */
function handleWebhookCheckSuiteCompleted(deps, card, project, cols, payload, _sender) {
  const { stmts, broadcast, handleChat } = deps;
  const checkSuite = payload.check_suite;
  if (!checkSuite) return false;

  const conclusion = checkSuite.conclusion; // 'success', 'failure', 'neutral', 'cancelled', etc.
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

  // If CI failed and card is in Review, notify the original agent to fix
  if (conclusion === 'failure' && card.session_id) {
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    if (reviewCol && card.column_id === reviewCol.id) {
      const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');

      if (inProgressCol) {
        stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
        broadcast({ type: 'kanban_update', projectId: project.id });
      }

      const originalSession = stmts.getSession.get(card.session_id);
      if (originalSession) {
        console.log(
          `[Webhook/Kanban] CI failed — dispatching fix request to session ${card.session_id}`,
        );
        handleChat(null, {
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

/**
 * Handle pull_request_review_comment.created — a new inline comment on a PR.
 * Uses batching to consolidate rapid-fire comments into a single dispatch.
 * Creates new sessions if the card has no active session (feedback never gets dropped).
 */
function handleWebhookReviewComment(deps, card, project, cols, payload, sender) {
  const { broadcast, getGhAuthenticatedUser, getGhBotUser } = deps;
  const comment = payload.comment;
  const prNumber = payload.pull_request?.number;
  if (!comment) return false;

  const ghAuthenticatedUser = getGhAuthenticatedUser();
  const ghBotUser = getGhBotUser();

  // Don't react to our own comments or bot comments (prevent loops)
  const botUsers = ['github-actions[bot]', 'github-actions'];
  if (botUsers.includes(sender)) return false;
  if (ghAuthenticatedUser && sender === ghAuthenticatedUser) return false;
  if (ghBotUser && sender === ghBotUser) return false;

  // Skip comments that contain our agent marker (agent-posted replies)
  if (comment.body?.includes('<!-- agent-hub-bot -->')) return false;

  console.log(
    `[Webhook/Kanban] Review comment on "${card.title}" (PR #${prNumber}) by ${sender}: ${comment.body?.substring(0, 80)}`,
  );

  // Batch comments to avoid overwhelming the agent with individual dispatches.
  // Multiple comments arriving within REVIEW_COMMENT_BATCH_DELAY_MS get consolidated.
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

// ─── GitHub Webhook Handler (public — uses HMAC, not API key) ───────

export function createGithubWebhookHandler(deps) {
  const { stmts, broadcast, getProjects, runClaude } = deps;
  const router = Router();

  router.post('/api/webhooks/github', async (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    const event = req.headers['x-github-event'];
    const deliveryId = req.headers['x-github-delivery'];

    if (!event || !req.body) {
      return res.status(400).json({ error: 'Missing event or body' });
    }

    const repoFullName = req.body.repository?.full_name || '';

    const allConfigs = stmts.getWebhookConfigs.all().filter((c) => c.enabled);
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

    // Verify HMAC signature
    if (signature && webhookConfig.secret) {
      const expected =
        'sha256=' +
        crypto
          .createHmac('sha256', webhookConfig.secret)
          .update(req.rawBody || JSON.stringify(req.body))
          .digest('hex');

      try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          console.warn(`[Webhook] HMAC verification failed for ${repoFullName}`);
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } catch {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const action = req.body.action || '';
    const eventKey = action ? `${event}.${action}` : event;

    // ── Built-in kanban lifecycle handling (runs first, no Claude session needed) ──
    let kanbanHandled = false;
    try {
      kanbanHandled = handleKanbanWebhookEvent(deps, event, action, req.body, webhookConfig);
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
    } catch (err) {
      console.error(`[Webhook] Kanban lifecycle handler error for ${eventKey}:`, err.message);
    }

    // ── Custom event handler (runs even if kanban handled — they're independent) ──
    const eventConfigs = JSON.parse(webhookConfig.events || '{}');
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

    const contextPayload = buildWebhookContext(event, action, req.body);
    const fullPrompt = `${handler.prompt}\n\n## Webhook Context\n${contextPayload}`;

    const projects = getProjects();
    const project = projects.find((p) => p.id === webhookConfig.project_id);
    const cwd = project?.cwd || config.defaultCwd;

    try {
      const result = await runClaude(fullPrompt, cwd, undefined, {
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
    } catch (err) {
      const durationMs = Date.now() - startTime;
      stmts.updateWebhookLog.run('error', err.message, durationMs, logId);
      console.error(`[Webhook] ${eventKey} on ${repoFullName} failed:`, err.message);

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

// ─── Webhook CRUD routes (requires auth) ────────────────────────────

export default function createWebhookRoutes(deps) {
  const { stmts } = deps;
  const router = Router();

  router.get('/api/webhooks', (_req, res) => {
    res.json(stmts.getWebhookConfigs.all());
  });

  router.get('/api/webhooks/project/:projectId', (req, res) => {
    res.json(stmts.getWebhookConfigsByProject.all(req.params.projectId));
  });

  router.post('/api/webhooks', async (req, res) => {
    const { projectId, repoUrl, events, enabled, autoRegister } = req.body;
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

    const created = stmts.getWebhookConfig.get(result.lastInsertRowid);

    if (autoRegister) {
      try {
        const regResult = await registerWebhookOnGitHub(created);
        return res.json({ ...created, registration: regResult });
      } catch (err) {
        return res.json({ ...created, registration: { ok: false, error: err.message } });
      }
    }

    res.json(created);
  });

  router.put('/api/webhooks/:id', (req, res) => {
    const { repoUrl, events, enabled } = req.body;
    const existing = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Not found' });

    stmts.updateWebhookConfig.run(
      repoUrl || existing.repo_url,
      JSON.stringify(events || JSON.parse(existing.events)),
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      existing.id,
    );

    res.json(stmts.getWebhookConfig.get(existing.id));
  });

  router.delete('/api/webhooks/:id', (req, res) => {
    stmts.deleteWebhookConfig.run(parseInt(req.params.id));
    res.json({ ok: true });
  });

  router.get('/api/webhooks/:id/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    res.json(stmts.getWebhookLogs.all(parseInt(req.params.id), limit));
  });

  router.get('/api/webhooks/logs/recent', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    res.json(stmts.getRecentWebhookLogs.all(limit));
  });

  router.post('/api/webhooks/:id/register', async (req, res) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    try {
      const result = await registerWebhookOnGitHub(webhookConfig);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Failed to register webhook: ${err.message}` });
    }
  });

  router.delete('/api/webhooks/:id/register', async (req, res) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    let ownerRepo;
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
      const existing = JSON.parse(existingRaw || '[]');
      for (const hook of existing) {
        ghApi(`repos/${owner}/${repo}/hooks/${hook.id}`, '--method', 'DELETE');
      }
      res.json({ ok: true, removed: existing.length });
    } catch (err) {
      res.status(500).json({ error: `Failed to unregister webhook: ${err.message}` });
    }
  });

  router.get('/api/webhooks/:id/register', async (req, res) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    let ownerRepo;
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
      const hooks = JSON.parse(existingRaw || '[]');
      res.json({ registered: hooks.length > 0, hooks, webhookUrl });
    } catch (err) {
      res.json({ registered: false, error: err.message, webhookUrl });
    }
  });

  return router;
}
