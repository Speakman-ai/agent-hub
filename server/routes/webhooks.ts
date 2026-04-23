import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import config, { defaultModelForEngine, fileConfig } from '../config.js';
import { getOrCreateBoard } from './board.js';
import { createEscalation } from './escalations.js';
import { runCapture, postPrComment } from '../capture-engine.js';
import { githubApiRequest, resolveInstallationId } from '../github-app.js';
import { dispatchPrEnvBuild, dispatchPrEnvTeardown } from '../container-pool/pr-env-dispatch.js';
import { getPrEnvBuilderDeps, readPrEnvConfig } from '../container-pool/pr-env-runtime.js';
import { readPrEnvConfigRow } from '../pr-env-store.js';
import { getDb } from '../db.js';
import {
  CHECK_RUN_NAME,
  DEFAULT_REVIEWER_PHASES,
  advancePhase,
  createCheckRun,
  finalizePhases,
  parseSqliteTimestampMs,
  renderProgressSummary,
  updateCheckRun,
  type CheckRunPhase,
} from '../check-runs.js';
import {
  cancelAnalyzePhaseTimer,
  clearAllAnalyzePhaseTimers,
  scheduleReviewerAnalyzePhaseTransition,
} from '../reviewer-analyze-phase-timer.js';
import { getProjectMode } from '../project-mode.js';
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
  WebhookEventRow,
  SessionRow,
  PrStateRow,
} from '../types.js';

// ─── GitHub Payload Types ────────────────────────────────────────

interface GitHubUser {
  login: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  user?: GitHubUser;
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
  id?: number;
  status?: string;
  conclusion?: string;
  head_sha?: string;
  pull_requests?: Array<{ number: number; head?: { sha: string }; base?: { sha: string } }>;
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

/**
 * HTML-comment sentinel we embed in bot-authored PR review / review-comment /
 * issue-comment bodies. Used as a body-content marker so downstream webhook
 * handlers can tell "posted by an Agent Hub bot" apart from "posted by the
 * human whose credentials the server happens to be running as." Identity
 * filters alone aren't enough: when the server's `gh` CLI auth is a human
 * personal account (the common case on single-maintainer deployments), every
 * manual review that human submits would be dropped as a self-trigger,
 * leaving the author agent unable to wake up on CHANGES_REQUESTED.
 */
export const AGENT_HUB_BOT_SENTINEL = '<!-- agent-hub-bot -->';

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

// ─── GitHub Commit Status ───────────────────────────────────────

/**
 * Set a GitHub commit status. Used for PR captures and other CI-like checks.
 * Uses GitHub App if available, falls back to `gh` CLI with bot token.
 */
export async function setCommitStatus(
  repoUrl: string,
  sha: string,
  state: 'pending' | 'success' | 'failure' | 'error',
  description: string,
  targetUrl: string | null,
): Promise<void> {
  const { owner, repo } = parseGitHubRepo(repoUrl);

  const body: Record<string, unknown> = {
    state,
    description: description.substring(0, 140), // GitHub limit
    context: 'agent-hub/capture',
  };
  if (targetUrl) {
    body.target_url = targetUrl;
  }

  // Try GitHub App first
  const app = config.githubApp;
  if (app?.appId && app?.privateKey) {
    const instId = resolveInstallationId(app, owner);
    if (instId) {
      try {
        await githubApiRequest(`/repos/${owner}/${repo}/statuses/${sha}`, {
          method: 'POST',
          body,
          appId: app.appId,
          privateKey: app.privateKey,
          installationId: instId,
        });
        console.log(`[Webhook/Status] Set ${state} on ${owner}/${repo}@${sha.substring(0, 7)}`);
        return;
      } catch (err) {
        console.warn(
          `[Webhook/Status] GitHub App failed, trying gh CLI: ${(err as Error).message.split('\n')[0]}`,
        );
      }
    }
  }

  // Fallback: gh CLI with bot token
  try {
    const ghEnv: Record<string, string | undefined> = { ...process.env };
    if (config.botGithubToken) {
      ghEnv.GH_TOKEN = config.botGithubToken;
    }

    const args = [
      'api',
      `repos/${owner}/${repo}/statuses/${sha}`,
      '--method',
      'POST',
      '--field',
      `state=${state}`,
      '--field',
      `description=${body.description as string}`,
      '--field',
      'context=agent-hub/capture',
    ];
    if (targetUrl) {
      args.push('--field', `target_url=${targetUrl}`);
    }

    execFileSync('gh', args, {
      encoding: 'utf-8',
      timeout: 15000,
      env: ghEnv as NodeJS.ProcessEnv,
    });
    console.log(
      `[Webhook/Status] Set ${state} on ${owner}/${repo}@${sha.substring(0, 7)} (gh CLI)`,
    );
  } catch (err) {
    console.error(
      `[Webhook/Status] Failed to set commit status: ${(err as Error).message.split('\n')[0]}`,
    );
  }
}

// Input validators — these must match capture-engine's guard. We refuse
// anything git could interpret as a flag, absolute path, or shell metachar
// before persisting to the DB.
const WEBHOOK_BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,255}$/;
const WEBHOOK_SHA_RE = /^[a-f0-9]{7,64}$/i;
const WEBHOOK_REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/;

/**
 * Trigger a PR capture (screenshot/video) when a PR is opened or updated.
 *
 * Called from webhook handlers on PR open or synchronize. Gated by
 * config.capturesEnabled. The full pipeline runs fire-and-forget:
 *   1. Validate inputs (refuse argument-injection attempts on branch/sha/url)
 *   2. Set GitHub commit status to `pending` under `agent-hub/capture`
 *   3. Run the capture (clone → build → serve → Playwright → DB)
 *   4. On success: post the PR comment with embedded screenshots + video
 *      link so the agent and reviewer can see the result.
 *   5. Update commit status to `success` / `failure` with the comment URL as
 *      the target_url (so GitHub's "Details" link goes straight to the
 *      capture comment).
 */
export async function triggerCaptureForPR(
  deps: { stmts: Stmts; broadcast: BroadcastFn },
  opts: {
    projectId: string;
    prNumber: number;
    prUrl: string;
    branch: string;
    commitSha: string | null;
    repoUrl: string;
  },
): Promise<void> {
  if (!config.capturesEnabled) {
    console.log(`[Webhook/Capture] Captures disabled — skipping PR #${opts.prNumber}`);
    return;
  }

  // Input validation — untrusted fields from GitHub webhook payload
  if (!WEBHOOK_BRANCH_RE.test(opts.branch)) {
    console.warn(
      `[Webhook/Capture] Rejecting PR #${opts.prNumber} — invalid branch name: ${opts.branch}`,
    );
    return;
  }
  if (opts.commitSha && !WEBHOOK_SHA_RE.test(opts.commitSha)) {
    console.warn(
      `[Webhook/Capture] Rejecting PR #${opts.prNumber} — invalid commit sha: ${opts.commitSha}`,
    );
    return;
  }
  if (!WEBHOOK_REPO_URL_RE.test(opts.repoUrl)) {
    console.warn(
      `[Webhook/Capture] Rejecting PR #${opts.prNumber} — invalid repo url: ${opts.repoUrl}`,
    );
    return;
  }

  const { stmts } = deps;
  const id = uuidv4();

  try {
    stmts.createPrCapture.run(
      id,
      opts.projectId,
      opts.prNumber,
      opts.prUrl,
      opts.branch,
      opts.commitSha,
      opts.repoUrl,
    );

    console.log(`[Webhook/Capture] Capture triggered for PR #${opts.prNumber} (${id})`);

    // Mark commit status as pending so GitHub reflects that a capture is in flight.
    if (opts.commitSha) {
      setCommitStatus(opts.repoUrl, opts.commitSha, 'pending', 'Capturing PR…', null).catch(
        (err) => {
          console.warn(`[Webhook/Capture] setCommitStatus(pending) failed: ${err.message}`);
        },
      );
    }

    // Fire-and-forget — the capture runs in the background. On completion we
    // post the PR comment and update the commit status.
    runCapture(id)
      .then(async (result) => {
        let commentUrl: string | null = null;
        if (result.status === 'done') {
          commentUrl = await postPrComment(id);
          if (!commentUrl) {
            console.warn(
              `[Webhook/Capture] PR #${opts.prNumber} capture done but postPrComment returned null`,
            );
          }
        }

        if (opts.commitSha) {
          const state = result.status === 'done' ? 'success' : 'failure';
          const description =
            result.status === 'done'
              ? `Captured ${result.screenshots.length} screenshot(s)`
              : (result.error || 'Capture failed').slice(0, 140);
          await setCommitStatus(opts.repoUrl, opts.commitSha, state, description, commentUrl).catch(
            (err) => {
              console.warn(`[Webhook/Capture] setCommitStatus(${state}) failed: ${err.message}`);
            },
          );
        }
      })
      .catch((err) => {
        console.error(
          `[Webhook/Capture] Capture failed for PR #${opts.prNumber}:`,
          (err as Error).message,
        );
        if (opts.commitSha) {
          setCommitStatus(
            opts.repoUrl,
            opts.commitSha,
            'error',
            `Capture error: ${(err as Error).message}`.slice(0, 140),
            null,
          ).catch(() => {});
        }
      });
  } catch (err) {
    console.error(
      `[Webhook/Capture] Failed to create capture for PR #${opts.prNumber}:`,
      (err as Error).message,
    );
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
  const { stmts, findAgent, handleChat, broadcast } = deps;
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
    const cardRaw = typeof card.assign_model === 'string' ? card.assign_model.trim() : '';
    const allowedForEngine = config.engineValidModels[engine] || [];
    const resolvedModel =
      cardRaw && allowedForEngine.includes(cardRaw)
        ? cardRaw
        : (agent.model as string | undefined) || defaultModelForEngine(engine);
    stmts.createSession.run(
      sessionId,
      agent.id,
      `Review fixes: ${card.title}`,
      engine,
      resolvedModel,
      1,
      0,
      1,
    );
    {
      const row = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (row) {
        broadcast({ type: 'session_created', agentId: agent.id, session: row });
      }
    }

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
      card.assign_model,
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

// ─── Per-webhook author allowlist ────────────────────────────────
//
// When two Agent Hub instances are both installed on the same repo (e.g. Kevin's
// Hub + mine on `mcsteen/surveytracker`), GitHub fans every `pull_request` event
// out to both webhook endpoints. Without a gate, both instances dispatch a
// reviewer for every PR — each reviewing each other's work.
//
// The allowlist solves this by letting each webhook config declare which PR
// authors it cares about. Stored as a JSON array of GitHub logins in
// `webhook_configs.author_allowlist`. Empty array = review-all (default,
// backwards compatible). Non-empty = only PRs whose `pull_request.user.login`
// matches any entry (case-insensitive) trigger the reviewer.

/**
 * Validate + normalize a user-supplied allowlist payload.
 * Returns the normalized array, or `null` if input is not a valid string[].
 * Accepts `undefined`/`null`/missing → empty array (review-all).
 * Trims each entry and drops empty strings.
 */
export function normalizeAuthorAllowlist(input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * Gate check for reviewer dispatch. Parses the webhook config's author_allowlist
 * JSON column and decides whether this PR's author should trigger a review from
 * this Agent Hub instance.
 *
 * - Empty allowlist → true (review-all, backwards compatible)
 * - Malformed JSON → treated as empty (review-all, fail-open)
 * - Non-empty allowlist + author in list (case-insensitive) → true
 * - Non-empty allowlist + author not in list / undefined → false
 */
export function shouldReviewPrAuthor(
  webhookConfig: Pick<WebhookConfigRow, 'author_allowlist'>,
  authorLogin: string | undefined,
): boolean {
  let allowlist: unknown;
  try {
    allowlist = JSON.parse(webhookConfig.author_allowlist || '[]');
  } catch {
    // Fail-open on parse error — safer than silently dropping reviews.
    return true;
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  if (!authorLogin) return false;
  const needle = authorLogin.toLowerCase();
  return allowlist.some(
    (entry) => typeof entry === 'string' && entry.trim().toLowerCase() === needle,
  );
}

// ─── Reviewer Agent Dispatch (PR opened / synchronize) ───────────
//
// Single trigger surface: every `pull_request.opened` or `pull_request.synchronize`
// webhook fires a Reviewer-agent session for the project's dedicated Reviewer.
// Multiple rapid pushes within a debounce window coalesce into one dispatch
// (the latest push wins) so a burst of force-pushes doesn't burn N sessions.

const REVIEWER_DEBOUNCE_MS = 30_000;
const reviewerDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** True while a debounced reviewer dispatch is waiting to fire for this PR. */
export function isReviewerDispatchPending(projectId: string, prNumber: number): boolean {
  return reviewerDebounceTimers.has(`${projectId}:${prNumber}`);
}

function reviewerTriggerDescription(reason: ReviewerDispatchOpts['reason']): string {
  switch (reason) {
    case 'opened':
      return 'PR was just opened';
    case 'synchronize':
      return 'New commits were pushed (synchronize)';
    case 'rerequested':
      return 'Checks were re-run from GitHub (check run or suite rerequested)';
    case 'manual-nudge':
      return 'Manual nudge from Agent Hub (user requested a formal review from the PR list)';
    default:
      return String(reason);
  }
}

/**
 * Without a fine-grained signal from the reviewer agent, we time-trigger the
 * `context → analyze` phase advance so the live panel actually animates
 * mid-run instead of jumping from "context spinning" straight to "all done."
 * Picked to land *after* a typical `gh pr diff` + first file read finish but
 * well before the `/api/pr/review` POST. Cancelled when the review completes.
 */

interface ReviewerDispatchOpts {
  prUrl: string;
  prNumber: number;
  prTitle: string;
  repoFullName: string;
  reason: 'opened' | 'synchronize' | 'rerequested' | 'manual-nudge';
  /**
   * Commit SHA of PR head. Required to create a GitHub Check Run (which is
   * commit-scoped, not PR-scoped). Optional for backward-compat with callers
   * that don't have it; the check-run overlay is simply skipped when missing.
   */
  headSha?: string;
}

/**
 * Reviewer deps that include `config` can publish the live progress panel as a
 * GitHub Check Run via the App installation. Tests that mock deps with only
 * the narrow set still work — the check-run path is feature-detected, not
 * required for the review itself to go out.
 */
type ReviewerDeps = Pick<RouteDeps, 'stmts' | 'handleChat' | 'broadcast' | 'findAgent'> & {
  config?: RouteDeps['config'];
};

/**
 * Create (or re-create, on each new head_sha) the "Agent Hub Reviewer" Check
 * Run in the PR's Checks tab, and persist the id on `pr_state`. Fire-and-forget
 * from the webhook path — any failure is logged but does not block the review.
 *
 * GitHub Check Runs are commit-scoped: each synchronize's `head_sha` gets its
 * own check run, and GitHub's Checks strip always shows the latest commit's
 * runs. So we upsert a fresh row on every call.
 */
async function ensureCheckRunForPR(
  deps: ReviewerDeps,
  project: Project,
  opts: ReviewerDispatchOpts,
): Promise<void> {
  const { stmts, config: depsConfig } = deps;
  if (!opts.headSha) return;
  if (!depsConfig?.githubApp?.appId || !depsConfig.githubApp.privateKey) return;
  if (!stmts.upsertPrState) return; // DB migration not yet applied

  const [owner, repo] = opts.repoFullName.split('/');
  if (!owner || !repo) return;

  const prStateId = `${opts.repoFullName}#${opts.prNumber}`;
  const phases: CheckRunPhase[] = DEFAULT_REVIEWER_PHASES.map((p, i) =>
    i === 0 ? { ...p, state: 'in_progress' } : p,
  );
  const summary = renderProgressSummary(phases, {
    headline: `Reviewing PR #${opts.prNumber} — _${opts.reason}_`,
  });

  // Seed the row as `queued` immediately (before the API call) so the
  // webhook-side `head_sha` / `project_id` link is recorded even if the
  // Check Runs POST fails (e.g. App missing `checks: write`).
  try {
    stmts.upsertPrState.run(
      prStateId,
      project.id,
      opts.repoFullName,
      opts.prNumber,
      opts.headSha,
      null,
      'queued',
      'queue',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CheckRun] Failed to seed pr_state for PR #${opts.prNumber}:`, msg);
    return;
  }

  try {
    const created = await createCheckRun(depsConfig, {
      owner,
      repo,
      headSha: opts.headSha,
      status: 'queued',
      output: {
        title: 'Reviewer scheduled',
        summary,
      },
      externalId: prStateId,
    });
    if (!created) {
      console.log(
        `[CheckRun] No App installation for owner "${owner}" — skipping check run for PR #${opts.prNumber}`,
      );
      return;
    }
    // Use the dedicated `attachCheckRunId` statement instead of a second
    // `upsertPrState` so that `started_at` is preserved (the upsert UPDATE
    // branch would otherwise reset the baseline used for elapsed timing).
    if (stmts.attachCheckRunId) {
      stmts.attachCheckRunId.run(created.id, prStateId);
    }
    console.log(
      `[CheckRun] Created Check Run #${created.id} for PR #${opts.prNumber} (${opts.repoFullName} @ ${opts.headSha.substring(0, 7)})`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[CheckRun] Failed to create Check Run for PR #${opts.prNumber}: ${msg.split('\n')[0]}`,
    );
  }
}

/**
 * PATCH the check run to reflect a new phase transition. Best-effort — the
 * review still proceeds even if GitHub is unreachable.
 *
 * Exported so `/api/pr/review` (the endpoint the reviewer agent posts to) can
 * advance the panel into the `post` phase right before completing the run.
 */
export async function patchCheckRunPhase(
  deps: ReviewerDeps,
  repoFullName: string,
  prNumber: number,
  phaseKey: 'context' | 'analyze' | 'post',
  opts: { headline?: string } = {},
): Promise<void> {
  const { stmts, config: depsConfig } = deps;
  if (!depsConfig?.githubApp?.appId) return;
  if (!stmts.getPrStateByRepoPr || !stmts.updatePrStatePhase) return;

  const row = stmts.getPrStateByRepoPr.get(repoFullName, prNumber) as PrStateRow | undefined;
  if (!row?.check_run_id) return;
  // Once the run is completed the PATCH will 422; skip the noisy attempt.
  // Also avoids a race where a slow `analyze` setTimeout fires after the
  // reviewer already posted its final review.
  if (row.status === 'completed') return;

  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return;

  const prStateId = `${repoFullName}#${prNumber}`;
  const startedAtMs = parseSqliteTimestampMs(row.started_at) ?? Date.now();
  const phases = advancePhase(DEFAULT_REVIEWER_PHASES, phaseKey, Date.now(), startedAtMs);
  const summary = renderProgressSummary(phases, { headline: opts.headline });

  try {
    stmts.updatePrStatePhase.run(phaseKey, 'in_progress', prStateId);
  } catch {
    /* non-critical */
  }

  try {
    await updateCheckRun(depsConfig, owner, repo, row.check_run_id, {
      status: 'in_progress',
      output: {
        title: `Reviewer: ${phaseKey}`,
        summary,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[CheckRun] PATCH failed for PR #${prNumber} (phase=${phaseKey}): ${msg.split('\n')[0]}`,
    );
  }
}

/**
 * Schedule a Reviewer agent dispatch for a PR. Coalesces rapid repeated
 * synchronizes into a single delayed run keyed by `${projectId}:${prNumber}`.
 * Returns true if a dispatch was scheduled, false if no Reviewer agent exists.
 *
 * Side-effect (fire-and-forget): creates/refreshes the "Agent Hub Reviewer"
 * GitHub Check Run so the live progress panel appears in the Checks tab as
 * soon as the webhook arrives, not only when the review lands 30s later.
 */
export function dispatchReviewerForPR(
  deps: ReviewerDeps,
  project: Project,
  opts: ReviewerDispatchOpts,
): boolean {
  const reviewer = project.agents.find((a) => a.role === 'reviewer');
  if (!reviewer) {
    console.log(
      `[Reviewer] No reviewer agent on project "${project.name}" — skipping dispatch for PR #${opts.prNumber}`,
    );
    return false;
  }

  if (getProjectMode(project) === 'workflow') {
    console.log(
      `[Reviewer] Project "${project.name}" is in workflow mode — skipping dispatch for PR #${opts.prNumber}`,
    );
    return false;
  }

  // Fire-and-forget: create the Check Run in the PR's Checks tab immediately so
  // the panel shows up before the debounce window closes.
  ensureCheckRunForPR(deps, project, opts).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CheckRun] ensureCheckRunForPR error: ${msg.split('\n')[0]}`);
  });

  const key = `${project.id}:${opts.prNumber}`;
  const existing = reviewerDebounceTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    reviewerDebounceTimers.delete(key);
    runReviewerDispatch(deps, project, reviewer, opts).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Reviewer] Dispatch failed for PR #${opts.prNumber}:`, msg);
    });
  }, REVIEWER_DEBOUNCE_MS);

  reviewerDebounceTimers.set(key, timer);
  console.log(
    `[Reviewer] Debounced dispatch scheduled for PR #${opts.prNumber} (${opts.reason}) on "${project.name}"`,
  );
  return true;
}

async function runReviewerDispatch(
  deps: ReviewerDeps,
  project: Project,
  reviewer: Agent,
  opts: ReviewerDispatchOpts,
): Promise<void> {
  const { stmts, handleChat, broadcast } = deps;

  // Advance the Check Run to in_progress as soon as the debounce fires and the
  // reviewer session actually starts — this is what makes the panel animate
  // from "queued" to a running checklist in GitHub's Checks tab.
  patchCheckRunPhase(deps, opts.repoFullName, opts.prNumber, 'context', {
    headline: `Reviewing PR #${opts.prNumber} — gathering context`,
  }).catch(() => {
    /* best-effort */
  });

  // Schedule the `context → analyze` transition so the panel actually animates
  // mid-run. Cancelled by `cancelAnalyzePhaseTimer` when the formal review
  // lands (and `patchCheckRunPhase` itself short-circuits on completed runs as
  // a defense-in-depth backstop against the race window).
  scheduleReviewerAnalyzePhaseTransition({
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    onFire: () => {
      patchCheckRunPhase(deps, opts.repoFullName, opts.prNumber, 'analyze', {
        headline: `Reviewing PR #${opts.prNumber} — analyzing diff`,
      }).catch(() => {
        /* best-effort */
      });
    },
  });

  const sessionId = crypto.randomUUID();
  const engine = reviewer.engine || 'claude-code';
  const workflowModelRaw = project.githubWorkflow?.reviewerModel;
  const workflowModel =
    typeof workflowModelRaw === 'string' && workflowModelRaw.trim() ? workflowModelRaw.trim() : '';
  const agentModel =
    typeof reviewer.model === 'string' && reviewer.model.trim() ? reviewer.model.trim() : '';
  const sessionModel = workflowModel || agentModel || defaultModelForEngine(engine);
  stmts.createSession.run(
    sessionId,
    reviewer.id,
    `Review: PR #${opts.prNumber} ${opts.prTitle}`.substring(0, 200),
    engine,
    sessionModel,
    1,
    0,
    1,
  );
  {
    const row = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (row) {
      broadcast({ type: 'session_created', agentId: reviewer.id, session: row });
    }
  }

  const prompt = `# PR Review Request (${opts.reason})

You are reviewing pull request **#${opts.prNumber}** in repo \`${opts.repoFullName}\`.

- **PR URL**: ${opts.prUrl}
- **Title**: ${opts.prTitle}
- **Trigger**: ${reviewerTriggerDescription(opts.reason)}

## Progress markers (drives the in-Hub ProgressPanel + GitHub Check Run)

As you work, emit \`[[STEP:<status>:<label>]]\` markers on their own line at
phase boundaries. These are stripped from the rendered output and drive the
live Cursor-style checklist. Valid statuses: \`started\`, \`completed\`, \`failed\`.

Use these exact labels in order so the panel lines up with the GitHub Check Run:

1. \`Gather PR context\`
2. \`Analyze diff and files\`
3. \`Post formal review\`

Example:

    [[STEP:started:Gather PR context]]
    ...do the work...
    [[STEP:completed:Gather PR context]]
    [[STEP:started:Analyze diff and files]]
    ...
    [[STEP:completed:Analyze diff and files]]
    [[STEP:started:Post formal review]]
    ...POST to /api/pr/review...
    [[STEP:completed:Post formal review]]

## Your task
1. Fetch the PR metadata, diff, and recent commits using \`gh pr view ${opts.prNumber} --repo ${opts.repoFullName}\` and \`gh pr diff ${opts.prNumber} --repo ${opts.repoFullName}\`.
2. Read the changed files in context.
3. For every issue you find, **assign a severity score from 1 to 10** using the rubric below, then classify it as **blocking** or **non-blocking** based on that score.

   ### Severity rubric (1–10)
   - **1–2**: pure nit — whitespace, naming preference, wording in a comment, stylistic taste.
   - **3**: minor polish — small refactor opportunity, redundant code, slightly clearer API shape. No correctness impact.
   - **4–5**: real issue — missing test for non-trivial new logic, unclear error handling, moderate performance smell, convention violation that will propagate.
   - **6–7**: correctness concern — likely bug in an edge case, weak input validation, brittle assumption, subtle race, under-documented breaking change.
   - **8–9**: serious defect — reproducible bug on the happy path, real security hole, data-loss risk, breaking API change for public consumers.
   - **10**: showstopper — production will be down, credentials leaked, destructive migration, or a third-party API misuse that will fail immediately.

   ### Severity → classification
   - **Any finding scoring > 3 is BLOCKING.** There is no "non-blocking 4." A single finding scoring 4+ forces \`REQUEST_CHANGES\` for the whole review.
   - **Findings scoring ≤ 3 are non-blocking** and may be included under an \`APPROVE\`.
   - When in doubt about a score, **round up, not down.** Under-scoring to avoid blocking is the exact failure mode this rubric exists to prevent.

4. Choose an event using the decision tree below, then submit ONE formal GitHub review by POSTing to Agent Hub's \`/api/pr/review\` endpoint. This routes the review through the GitHub App installation so it lands with the App identity — \`gh pr review\` runs as your CLI user (usually the PR author) and GitHub silently downgrades APPROVE to COMMENTED for self-reviews.

## Event decision tree

Walk this in order and pick the **first** match — do not hedge:

1. **Does any finding score greater than 3 on the severity rubric?** → \`REQUEST_CHANGES\`. Body required: list every finding with its severity score (e.g. \`**[6/10]** server/foo.ts:42 — …\`), blockers (>3) first, then non-blocking (≤3). Even one finding scoring 4+ blocks the PR; do NOT downgrade to APPROVE because "the rest looked fine."
2. **Otherwise (every finding scored ≤ 3)** → \`APPROVE\`. **Body required** (Agent Hub rejects empty or placeholder-only reviews): write a substantive markdown summary — prefix each note with its score (\`**[2/10]** …\`) even when approving. \`APPROVE\` does not mean "zero thoughts" — it means the diff is **mergeable as-is** because nothing crossed the severity-3 threshold. Non-blocking comments under APPROVE are the normal, expected pattern.
3. **Only if you genuinely cannot decide** (e.g., you want the author's take on a design question before endorsing, or the diff is half-done and you want to flag direction without blocking) → \`COMMENT\`. Body required. This should be rare — most reviews are APPROVE or REQUEST_CHANGES.

**Hard rule (don't over-correct):** Non-blocking feedback does NOT require \`COMMENT\`. If nothing you wrote blocks merge, use \`APPROVE\` with your notes attached. \`COMMENT\` is for deliberate fence-sitting, not for "I had some suggestions." Defaulting every substantive-but-non-blocking review to COMMENT destroys the APPROVE signal just as badly as rubber-stamping everything to APPROVE did.

**Hard rule (don't rubber-stamp):** Conversely, if there's a real blocker, use \`REQUEST_CHANGES\` — do NOT bury a blocker in an APPROVE body. The event is the signal; the body is the detail.
${
  opts.reason === 'synchronize'
    ? `

## Re-approval after new commits (this run is a synchronize)

**The PR head SHA changed** since the last push. Many repos enable **"dismiss stale reviews"** — an older **APPROVE** no longer counts toward required reviews even if GitHub still shows it in the timeline ("previously approved…").

- A formal review whose JSON \`event\` is **\`COMMENT\`** is **never** an approving review for merge, even if the markdown body says "Approved for merge" or "LGTM."
- If every finding scores **≤ 3** (nothing blocking merge), you **must** submit **\`APPROVE\`**, not \`COMMENT\`, so GitHub records a fresh approval on the **current** head.
- Reserve \`COMMENT\` for the rare "genuinely cannot decide" case from the decision tree — not for "re-confirming" after a merge-conflict or autofix commit.
`
    : ''
}

## Submitting the review

\`\`\`bash
curl -sS -X POST "$AGENT_HUB_URL/api/pr/review" \\
  -H "X-API-Key: $AGENT_HUB_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prUrl":"${opts.prUrl}","event":"<EVENT>","body":"<markdown body>"}'
\`\`\`

Replace \`<EVENT>\` with exactly one of \`APPROVE\`, \`COMMENT\`, or \`REQUEST_CHANGES\` per the rubric above. **Every event requires a substantive \`body\`** (minimum length + not placeholder-only — trivial strings like \`test\` are rejected server-side). Use markdown with concrete file:line references.

Do **NOT** edit code. Do **NOT** merge. GitHub's native auto-merge handles landing approved PRs.`;

  console.log(
    `[Reviewer] Dispatching "${reviewer.name}" → PR #${opts.prNumber} (session ${sessionId})`,
  );

  await handleChat(null, {
    type: 'chat',
    agentId: reviewer.id,
    sessionId,
    content: prompt,
    hookSpecificOutput: {
      sessionTitle: `Review: PR #${opts.prNumber} ${opts.prTitle}`.substring(0, 200),
    },
  });
}

/** Test-only helper. */
export function _clearReviewerDebounce(): void {
  for (const t of reviewerDebounceTimers.values()) clearTimeout(t);
  reviewerDebounceTimers.clear();
  clearAllAnalyzePhaseTimers();
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
   git add -A
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

  const project = projects.find((p) => p.id === webhookConfig.project_id);

  // ─── Check Run / Check Suite "Re-run" ───────────────────────────
  // The user clicked the "Re-run" button in GitHub's Checks tab — either on our
  // specific check (`check_run.rerequested`) or on the whole suite
  // (`check_suite.rerequested`, the umbrella "Re-run all checks" button). Both
  // carry `pull_requests[]` and `head_sha`, so we can re-trigger the reviewer
  // without needing a kanban card to be linked.
  if (
    project &&
    payload.repository?.full_name &&
    ((event === 'check_run' && action === 'rerequested') ||
      (event === 'check_suite' && action === 'rerequested'))
  ) {
    const src = payload.check_run || payload.check_suite;
    const prs = src?.pull_requests || [];
    const headSha = src?.head_sha;
    const repoFullName = payload.repository.full_name;

    for (const pr of prs) {
      const prUrlFull = `${payload.repository.html_url}/pull/${pr.number}`;
      // Note: author_allowlist gate is intentionally SKIPPED for rerequest
      // events. The `check_run`/`check_suite` payloads don't carry PR author
      // login directly, and rerequests are manually triggered (rare + already
      // user-initiated), so fail-open here is safe. If this path becomes
      // high-volume we can fetch the PR via the GitHub API to apply the gate.
      dispatchReviewerForPR(deps, project, {
        prUrl: prUrlFull,
        prNumber: pr.number,
        prTitle: card?.title || `PR #${pr.number}`,
        repoFullName,
        reason: 'rerequested',
        headSha: headSha || pr.head?.sha,
      });
    }
    if (prs.length > 0) {
      console.log(
        `[Webhook/CheckRun] ${event}.rerequested → re-dispatched reviewer for ${prs.length} PR(s) on "${project.name}"`,
      );
      return true;
    }
  }

  // ─── PR-env Builder Dispatch (W2) ───────────────────────────────
  // opened / synchronize → build (or rebuild) a Docker-Compose preview env
  // bound to the PR. closed → tear it down. This sits ABOVE the
  // `if (!card && …) return false` short-circuit below because PR envs
  // belong to the PR itself, not the optional kanban card — synchronize
  // events on unlinked PRs still need to rebuild. Gated by the
  // `AGENT_HUB_PR_ENV_ENABLED` feature flag; `getPrEnvBuilderDeps()` returns
  // null when disabled and the dispatch becomes a no-op.
  if (
    event === 'pull_request' &&
    payload.pull_request &&
    payload.repository?.full_name &&
    (action === 'opened' || action === 'synchronize' || action === 'closed')
  ) {
    const pr = payload.pull_request;
    const repoFullName = payload.repository.full_name;
    const prEnvDispatchDeps = {
      db: getDb(),
      stmts,
      getBuilderDeps: () =>
        getPrEnvBuilderDeps(
          readPrEnvConfig(fileConfig, process.env, readPrEnvConfigRow()),
          getDb(),
        ),
    };
    if (action === 'closed') {
      void dispatchPrEnvTeardown(prEnvDispatchDeps, {
        repoFullName,
        prNumber: pr.number,
        card: card || null,
      });
    } else if (pr.head?.ref) {
      void dispatchPrEnvBuild(prEnvDispatchDeps, {
        repoFullName,
        prNumber: pr.number,
        branch: pr.head.ref,
        commitSha: pr.head.sha,
        card: card || null,
      });
    }
  }

  // Short-circuit: if no card and not a PR open event, nothing to do
  if (!card && !(event === 'pull_request' && action === 'opened')) return false;

  if (!project) return false;

  // ─── Unified Reviewer Dispatch ──────────────────────────────────
  // Every PR `opened` or `synchronize` event triggers the project's dedicated
  // Reviewer agent (debounced). This is the SINGLE trigger surface for review —
  // no longer tied to autonomous mode, kanban column moves, or review_requested.
  //
  // Gated by the webhook config's author_allowlist so two Agent Hub instances
  // installed on the same repo don't cross-review each other's PRs.
  if (
    event === 'pull_request' &&
    payload.pull_request &&
    payload.repository?.full_name &&
    (action === 'opened' || action === 'synchronize')
  ) {
    const pr = payload.pull_request;
    const authorLogin = pr.user?.login;
    if (!shouldReviewPrAuthor(webhookConfig, authorLogin)) {
      console.log(
        `[Webhook/Reviewer] skipping PR #${pr.number} on "${project.name}" — author "${authorLogin ?? '?'}" not in author_allowlist`,
      );
    } else {
      dispatchReviewerForPR(deps, project, {
        prUrl: pr.html_url,
        prNumber: pr.number,
        prTitle: pr.title,
        repoFullName: payload.repository.full_name,
        reason: action as 'opened' | 'synchronize',
        headSha: pr.head?.sha,
      });
    }
  }

  const boardData = getOrCreateBoard(stmts, project.id) as BoardData | null;
  if (!boardData?.board) return false;
  const cols = stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];

  // When a PR is opened with no card yet linked, try to find an existing card
  // by exact-title match and auto-link the PR URL to it. We intentionally do
  // NOT create a new card here — agent-authored PRs race with the agent's own
  // `PUT /cards/:id {pr_url}` call, which produced duplicate cards. Cards are
  // now created exclusively by agents (or the "Create PR" button), and external
  // PRs that don't match a card simply won't appear on the board.
  if (!card && event === 'pull_request' && action === 'opened' && payload.pull_request) {
    const pr = payload.pull_request;

    // Dedup: check for existing card with same title (case-insensitive) on this board
    const allCards = stmts.getKanbanCards.all(boardData.board.id) as KanbanCardRow[];
    const titleLower = pr.title.toLowerCase().trim();
    const existingByTitle = allCards.find((c) => c.title.toLowerCase().trim() === titleLower);
    if (existingByTitle) {
      // Link the PR URL to the existing card if not already set
      if (!existingByTitle.pr_url) {
        try {
          stmts.setCardPrUrl.run(prUrl, existingByTitle.id);
        } catch {
          /* non-critical */
        }
      }
      console.log(
        `[Webhook/Kanban] Linked PR #${pr.number} to existing card "${existingByTitle.title}" by title match`,
      );
      card = existingByTitle;

      // Still trigger capture for the PR even if card already exists
      const repoHtmlUrl = payload.repository?.html_url;
      if (repoHtmlUrl && pr.head?.ref) {
        triggerCaptureForPR(
          { stmts, broadcast },
          {
            projectId: project.id,
            prNumber: pr.number,
            prUrl: pr.html_url,
            branch: pr.head.ref,
            commitSha: pr.head.sha || null,
            repoUrl: repoHtmlUrl,
          },
        ).catch((err) => {
          console.error(`[Webhook/Capture] trigger on opened failed:`, (err as Error).message);
        });
      }

      return true;
    }

    console.log(
      `[Webhook/Kanban] PR #${pr.number} "${pr.title}" opened with no matching card — not auto-creating (by design)`,
    );
    return false;
  }

  if (!card) return false;

  const eventKey = action ? `${event}.${action}` : event;
  const sender = payload.sender?.login || 'unknown';

  switch (eventKey) {
    case 'pull_request_review.submitted':
      return handleWebhookPrReview(deps, card, project, cols, payload, sender);
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

export function handleWebhookPrReview(
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

  // Self-trigger filter.
  //
  // `ghBotUser` (bot PAT user) and `appBotLogin` (GitHub App bot) are
  // distinct bot identities — any review under them is unambiguously
  // automated and must be skipped to break the review→fix→review loop.
  //
  // `ghAuthenticatedUser` is the login of the server's default `gh` CLI
  // auth, which is typically a *human* personal account on single-maintainer
  // deployments. We can't skip all reviews from that identity — that was
  // silently dropping legitimate human CHANGES_REQUESTED reviews, leaving
  // the author agent permanently asleep. Instead, only skip when the review
  // body carries our bot sentinel, which is the same convention already used
  // for review/issue comments.
  const reviewBodyHasBotSentinel =
    typeof review.body === 'string' && review.body.includes(AGENT_HUB_BOT_SENTINEL);
  const isAutoReviewFromCliUser =
    !!ghAuthenticatedUser && sender === ghAuthenticatedUser && reviewBodyHasBotSentinel;

  if (
    isAutoReviewFromCliUser ||
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
   git add -A
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
  const repoFullName = payload.repository?.full_name;

  // Drop the per-PR check-run tracking row once the PR is terminal — keeps the
  // table tidy and cancels any pending in-memory phase timers so a late
  // setTimeout doesn't PATCH a check on a closed PR. Bounded by the unique
  // (repo_full_name, pr_number) index, so this is housekeeping not safety.
  if (repoFullName && typeof prNumber === 'number') {
    cancelAnalyzePhaseTimer(repoFullName, prNumber);
    if (stmts.deletePrStateByRepoPr) {
      try {
        stmts.deletePrStateByRepoPr.run(repoFullName, prNumber);
      } catch {
        /* non-critical */
      }
    }
  }

  if (merged) {
    const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
    if (doneCol && card.column_id !== doneCol.id) {
      stmts.moveKanbanCard.run(doneCol.id, 0, card.id);
      broadcast({ type: 'kanban_update', projectId: project.id });
      console.log(`[Webhook/Kanban] PR #${prNumber} merged — card "${card.title}" moved to Done`);
    }

    let mergeAgentId: string | undefined;
    if (card.session_id) {
      const sess = stmts.getSession.get(card.session_id) as { agent_id: string } | undefined;
      mergeAgentId = sess?.agent_id;
    }
    broadcast({
      type: 'webhook_pr_merged',
      projectId: project.id,
      cardId: card.id,
      cardTitle: card.title,
      prNumber,
      mergedBy: sender,
      prUrl: card.pr_url || (payload.pull_request?.html_url as string | undefined),
      sessionId: card.session_id || undefined,
      agentId: mergeAgentId,
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

    let closedAgentId: string | undefined;
    if (card.session_id) {
      const sess = stmts.getSession.get(card.session_id) as { agent_id: string } | undefined;
      closedAgentId = sess?.agent_id;
    }
    broadcast({
      type: 'webhook_pr_closed',
      projectId: project.id,
      cardId: card.id,
      cardTitle: card.title,
      prNumber,
      closedBy: sender,
      prUrl: card.pr_url || (payload.pull_request?.html_url as string | undefined),
      sessionId: card.session_id || undefined,
      agentId: closedAgentId,
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

  // Trigger capture on new commits
  if (prNumber && payload.pull_request?.head?.ref) {
    const repoHtmlUrl = payload.repository?.html_url;
    if (repoHtmlUrl) {
      triggerCaptureForPR(
        { stmts, broadcast },
        {
          projectId: project.id,
          prNumber,
          prUrl: payload.pull_request.html_url,
          branch: payload.pull_request.head.ref,
          commitSha: payload.pull_request.head.sha || null,
          repoUrl: repoHtmlUrl,
        },
      ).catch((err) => {
        console.error(`[Webhook/Capture] trigger on synchronize failed:`, (err as Error).message);
      });
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
   git add -A
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
//
// Design: FAST-ACK + BACKGROUND WORKER.
//
// The POST handler only does work that must happen synchronously inside the
// GitHub delivery window: signature check, config lookup, row insert. Kanban
// lifecycle updates and Claude prompt execution happen in webhook-worker.ts,
// which claims rows from the `webhook_events` queue with a strict concurrency
// cap.
//
// This replaced an earlier inline design in which `handleKanbanWebhookEvent`
// ran synchronously before the 200 response and `runClaude` was awaited on
// the HTTP request. A webhook stampede on 2026-04-16 (254 events in 3 min,
// handler latencies up to 292s) saturated the event loop and wedged the box
// until PM2 restarted it. Fast-ack keeps inline work in the <50ms range.

export function createGithubWebhookHandler(deps: RouteDeps): Router {
  const { stmts } = deps;
  const router = Router();

  router.post('/api/webhooks/github', (req: Request, res: Response) => {
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
      const bodyBuf = rawBody || Buffer.from(JSON.stringify(req.body));
      const appSecret = config.githubApp?.webhookSecret;

      const verifyAgainst = (secret: string): boolean => {
        const expected =
          'sha256=' + crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex');
        try {
          const sigBuf = Buffer.from(signature);
          const expBuf = Buffer.from(expected);
          if (sigBuf.length !== expBuf.length) return false;
          return crypto.timingSafeEqual(sigBuf, expBuf);
        } catch {
          return false;
        }
      };

      // Accept either the per-repo webhook secret OR the GitHub App's webhook
      // secret. Installed GitHub Apps deliver events to the same endpoint but
      // sign them with the App's secret rather than the repo webhook's secret,
      // so verifying only one source rejects legitimate App-delivered events.
      const matchedSource = verifyAgainst(webhookConfig.secret)
        ? 'repo'
        : appSecret && verifyAgainst(appSecret)
          ? 'github-app'
          : null;

      if (!matchedSource) {
        const eventLabel = payload.action ? `${event}.${payload.action}` : event;
        const triedSources = appSecret ? 'repo + github-app' : 'repo';
        console.warn(
          `[Webhook] HMAC verification failed for ${repoFullName} ` +
            `(event=${eventLabel}, delivery=${deliveryId || 'unknown'}, tried=${triedSources}) — ` +
            `check that the signing secret in GitHub repo/App settings matches Agent Hub’s ` +
            `webhook config (and that the server build includes raw-body HMAC verification).`,
        );
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const action = payload.action || '';
    const eventKey = action ? `${event}.${action}` : event;

    // Idempotency: GitHub retries deliveries on timeout (10s HTTP window).
    // If we already have a row for this delivery_id, respond 200 with the
    // existing id and skip re-enqueue. The partial unique index on
    // delivery_id is our last-resort safety net.
    if (deliveryId) {
      const existing = stmts.getWebhookEventByDelivery.get(deliveryId) as
        | { id: number }
        | undefined;
      if (existing) {
        return res.status(200).json({
          status: 'duplicate',
          id: existing.id,
          event: eventKey,
        });
      }
    }

    let insertResult: ReturnType<typeof stmts.insertWebhookEvent.run>;
    try {
      insertResult = stmts.insertWebhookEvent.run(
        webhookConfig.id,
        deliveryId || null,
        event,
        action || null,
        JSON.stringify(payload),
        signature || null,
      );
    } catch (err: unknown) {
      // UNIQUE constraint on delivery_id means a near-simultaneous duplicate
      // raced us past the SELECT check above. Treat as a dup, not an error.
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(msg) && deliveryId) {
        const existing = stmts.getWebhookEventByDelivery.get(deliveryId) as
          | { id: number }
          | undefined;
        if (existing) {
          return res.status(200).json({
            status: 'duplicate',
            id: existing.id,
            event: eventKey,
          });
        }
      }
      console.error('[Webhook] enqueue failed:', msg);
      return res.status(500).json({ error: 'enqueue failed' });
    }

    return res.status(202).json({
      status: 'queued',
      id: Number(insertResult.lastInsertRowid),
      event: eventKey,
    });
  });

  return router;
}

// ─── Background Processing Entry Point (called by webhook-worker) ───

/**
 * Process a single claimed webhook event row.
 *
 * This is the function the background worker calls per row. It does
 * everything the old inline handler did: kanban lifecycle, then (if the
 * event is enabled in the webhook config) Claude prompt execution, with
 * webhook_logs bookkeeping and broadcast notifications.
 *
 * Throws on hard failures so the worker can mark the row as 'error'.
 * Returns normally on success (including 'skipped' — i.e. no handler
 * enabled and no kanban effect — which is not a failure).
 */
export async function processWebhookEvent(
  deps: RouteDeps,
  row: WebhookEventRow,
): Promise<{ kanbanHandled: boolean; handlerRan: boolean; logId?: number }> {
  const { stmts, broadcast, getProjects } = deps;
  const runClaudeFn = deps.runClaude as (
    prompt: string,
    cwd: string,
    model?: string,
    opts?: { timeoutMs: number },
  ) => Promise<string>;

  const webhookConfig = stmts.getWebhookConfig.get(row.webhook_config_id) as
    | WebhookConfigRow
    | undefined;
  if (!webhookConfig) {
    // Config deleted since the event was enqueued. FK cascade should have
    // removed this row, but belt-and-suspenders: treat as a no-op.
    throw new Error(`webhook config ${row.webhook_config_id} no longer exists`);
  }

  const payload = JSON.parse(row.payload) as GitHubWebhookPayload;
  const event = row.event_type;
  const action = row.action || '';
  const eventKey = action ? `${event}.${action}` : event;
  const repoFullName = payload.repository?.full_name || '';
  const deliveryId = row.delivery_id || '';

  let kanbanHandled = false;
  try {
    kanbanHandled = handleKanbanWebhookEvent(deps, event, action, payload, webhookConfig);
    if (kanbanHandled) {
      const logEntry = stmts.addWebhookLog.run(
        webhookConfig.id,
        eventKey,
        action,
        deliveryId,
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
    // Intentionally continue — kanban failure shouldn't block the custom handler.
  }

  const eventConfigs = JSON.parse(webhookConfig.events || '{}') as Record<
    string,
    { enabled?: boolean; prompt?: string } | undefined
  >;
  const handler = eventConfigs[eventKey] || eventConfigs[event];

  if (!handler || !handler.enabled) {
    if (!kanbanHandled) {
      stmts.addWebhookLog.run(webhookConfig.id, eventKey, action, deliveryId, 'skipped');
    }
    return { kanbanHandled, handlerRan: false };
  }

  // Self-origin filter: drop events where the sender is the Agent Hub bot
  // itself (GitHub App installation user, authenticated `gh` CLI user, or
  // github-actions) before spawning the LLM handler.
  //
  // The kanban lifecycle handler above already ran, so state stays
  // consistent — we only gate the expensive Claude dispatch here. Without
  // this filter the bot's own pushes, reviews, and review comments
  // re-trigger autofix and reviewer sessions, producing a tight feedback
  // loop (bot push → synchronize → bot reviews → review.submitted → autofix
  // → bot push → …). `enqueueReviewComment` has the same guard for the
  // review-comment pipeline; this extends it to the generic handler path.
  const sender = payload.sender?.login || '';
  const ghBotUser = deps.getGhBotUser();
  const ghAuthenticatedUser = deps.getGhAuthenticatedUser?.() ?? null;
  const isSelfOrigin =
    sender === 'github-actions[bot]' ||
    sender === 'github-actions' ||
    (ghBotUser !== null && sender === ghBotUser) ||
    (ghAuthenticatedUser !== null && sender === ghAuthenticatedUser);

  if (isSelfOrigin) {
    // Use the existing 'skipped' status (the webhook_logs CHECK
    // constraint whitelists ['pending','running','success','error',
    // 'skipped']) and store the reason in `result` so operators can
    // distinguish no-handler skips from self-origin skips without a
    // schema migration. The `self-origin:<sender>` prefix is matched by
    // the scale-back regression tests.
    const selfOriginLog = stmts.addWebhookLog.run(
      webhookConfig.id,
      eventKey,
      action,
      deliveryId,
      'skipped',
    );
    stmts.updateWebhookLog.run(
      'skipped',
      `self-origin:${sender}`,
      0,
      selfOriginLog.lastInsertRowid,
    );
    console.log(
      `[Webhook] ${eventKey} on ${repoFullName} — skipping handler (self-origin: ${sender})`,
    );
    return { kanbanHandled, handlerRan: false };
  }

  const logEntry = stmts.addWebhookLog.run(
    webhookConfig.id,
    eventKey,
    action,
    deliveryId,
    'running',
  );
  const logId = Number(logEntry.lastInsertRowid);
  const startTime = Date.now();

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
    // Re-throw so the worker records an 'error' row status with our message.
    throw err instanceof Error ? err : new Error(msg);
  }

  return { kanbanHandled, handlerRan: true, logId };
}

// ─── Webhook CRUD routes (requires auth) ────────────────────────

export default function createWebhookRoutes(deps: RouteDeps): Router {
  const { stmts, ensureReviewerAgents, broadcast } = deps;
  const router = Router();

  router.get('/api/webhooks', (_req: Request, res: Response) => {
    res.json(stmts.getWebhookConfigs.all());
  });

  router.get('/api/webhooks/project/:projectId', (req: Request, res: Response) => {
    res.json(stmts.getWebhookConfigsByProject.all(req.params.projectId));
  });

  router.post('/api/webhooks', async (req: Request, res: Response) => {
    const { projectId, repoUrl, events, enabled, autoRegister, authorAllowlist } = req.body as {
      projectId?: string;
      repoUrl?: string;
      events?: Record<string, unknown>;
      enabled?: boolean;
      autoRegister?: boolean;
      authorAllowlist?: unknown;
    };
    if (!projectId || !repoUrl)
      return res.status(400).json({ error: 'projectId and repoUrl required' });

    const normalizedAllowlist = normalizeAuthorAllowlist(authorAllowlist);
    if (normalizedAllowlist === null) {
      return res.status(400).json({ error: 'authorAllowlist must be an array of strings' });
    }

    const secret = crypto.randomBytes(32).toString('hex');
    const result = stmts.createWebhookConfig.run(
      projectId,
      repoUrl,
      secret,
      JSON.stringify(events || {}),
      enabled !== false ? 1 : 0,
      JSON.stringify(normalizedAllowlist),
    );

    const created = stmts.getWebhookConfig.get(result.lastInsertRowid) as WebhookConfigRow;

    // Seed a Reviewer agent for the project now that GitHub integration exists.
    try {
      const reviewersChanged = ensureReviewerAgents();
      if (reviewersChanged) {
        // Let connected clients refresh the sidebar so the new Reviewer
        // shows up immediately after the webhook is configured.
        broadcast({ type: 'projects_updated', reason: 'webhook-configured' });
      }
    } catch (err: unknown) {
      console.warn(`[Webhooks] ensureReviewerAgents failed: ${(err as Error).message}`);
    }

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
    const { repoUrl, events, enabled, authorAllowlist } = req.body as {
      repoUrl?: string;
      events?: Record<string, unknown>;
      enabled?: boolean;
      authorAllowlist?: unknown;
    };
    const existing = stmts.getWebhookConfig.get(parseInt(req.params.id as string)) as
      | WebhookConfigRow
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Not found' });

    let allowlistJson = existing.author_allowlist || '[]';
    if (authorAllowlist !== undefined) {
      const normalized = normalizeAuthorAllowlist(authorAllowlist);
      if (normalized === null) {
        return res.status(400).json({ error: 'authorAllowlist must be an array of strings' });
      }
      allowlistJson = JSON.stringify(normalized);
    }

    stmts.updateWebhookConfig.run(
      repoUrl || existing.repo_url,
      JSON.stringify(events || JSON.parse(existing.events)),
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      allowlistJson,
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
