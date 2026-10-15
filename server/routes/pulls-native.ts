/**
 * Create a native pull request on an Agent Hub-hosted
 * project. The write counterpart of the read surface in pr-list.ts
 * (which branches to native data for hosted projects).
 *
 * Used by agents from the `create-ticket-and-pr` skill (via `ah-api.sh`)
 * after pushing their session branch to the Hub — the hosted-repo
 * replacement for `gh pr create`. Idempotent: an open PR for the same
 * head branch is reused and refreshed, mirroring the GitHub flow's
 * `gh pr view` pre-check.
 */

import { Router, type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Project, PullRequestRow, RouteDeps } from '../types.js';
import { readNativePrState } from '../preview/pr-environment-native.js';
import { githubRepoOf } from '../preview/pr-environment-github.js';
import type { PrEnvironmentDto } from '../preview/pr-environments.js';
import type { AuthenticatedRequest } from '../auth.js';
import { isAgentHubHosted, bareRepoPath, hostedRepoExists } from '../native-pr/host.js';
import { hostedRepoDefaultBranch } from '../git-host/repo-store.js';
import { isSafeBranchName } from '../git-host/repo-read.js';
import { git, prCommits, prDiff, prDiffStat, prFiles, revParse } from '../native-pr/git-read.js';
import { NativePrError } from '../native-pr/errors.js';
import { tryAutoMergeArmedNativePr } from '../native-pr/auto-merge-armed.js';
import { zonedWallTimeToUtcMs, ZonedTimeError } from '../native-pr/zoned-time.js';
import { maybeRunPrAutoReview } from '../native-pr/auto-review.js';
import { resolveNativePrAuthorUserId } from '../native-pr/author-user.js';
import { resolveCardSessionId } from '../kanban-caller-session.js';
import config from '../config.js';
import { getAuthRecord } from '../auth-store.js';
import { z, registerPath } from '../openapi/registry.js';

const execFileP = promisify(execFile);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const MAX_BRANCH_CHANGE_FILES = 100;

/** Cap diff text fed into the model — huge diffs get summarized headers. */
const GENERATE_DIFF_BUDGET = 30_000;

type PrTextGenerator = (
  prompt: string,
  systemPrompt: string,
  cwd: string,
  userId: string | null,
) => Promise<string>;

/**
 * Default generator: a one-shot CLI print run with the REQUESTING USER's
 * stored account credentials (same resolution as chat sessions — without it
 * the spawn gets the credential-less host-creds HOME and the CLI answers
 * "Not logged in"). Claude is preferred, but when the user has no Claude
 * account connected we fall back to whichever agent engine they do have
 * (Cursor / Codex / Grok) via `resolveOneShotEngine` instead of hard-failing.
 * Lazy imports keep this route free of the engine modules' load-time side
 * effects. Tests inject a fake.
 */
let generatorOverride: PrTextGenerator | null = null;
export function __setPrTextGeneratorForTests(fn: PrTextGenerator | null): void {
  generatorOverride = fn;
}

export async function generatePrText(
  prompt: string,
  systemPrompt: string,
  cwd: string,
  userId: string | null,
): Promise<string> {
  if (generatorOverride) return generatorOverride(prompt, systemPrompt, cwd, userId);
  const [
    { runOneShotPrompt },
    { resolveOneShotEngine },
    { resolveSessionCliSpawnEnv },
    { default: config },
  ] = await Promise.all([
    import('../one-shot-spawn.js'),
    import('../engine-resolver.js'),
    import('../per-user-cli-spawn.js'),
    import('../config.js'),
  ]);
  // Prefer Claude, but fall back to any agent engine the acting user has
  // connected. Throws NoEnginesAvailableError when the user has none — the
  // route surfaces it as a friendly 400. The availability probe keys off the
  // same per-account creds that `resolveSessionCliSpawnEnv` reads, so the
  // resolved engine is guaranteed to pass the credential guard below.
  const resolved = await resolveOneShotEngine(config, { preferred: 'claude-code', userId });
  const spawnEnv = resolveSessionCliSpawnEnv({
    cfg: config,
    ownerId: userId,
    credsOwnerId: userId,
    sessionId: null,
    engine: resolved.engine,
  });
  return runOneShotPrompt(
    {
      engine: resolved.engine,
      model: resolved.model,
      prompt,
      systemPrompt,
      cwd,
      timeoutMs: 90_000,
      env: spawnEnv,
    },
    config,
  );
}

/** Parse the model's TITLE:/BODY: response with fallbacks for sloppiness. */
export function parseGeneratedPrText(raw: string): { title: string; body: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const titleMatch = text.match(/^TITLE:\s*(.+)$/m);
  const bodyMatch = text.match(/^BODY:\s*$/m);
  let title = titleMatch?.[1]?.trim() ?? '';
  let body = '';
  if (bodyMatch && bodyMatch.index !== undefined) {
    body = text.slice(bodyMatch.index + bodyMatch[0].length).trim();
  } else if (titleMatch) {
    body = text
      .slice((titleMatch.index ?? 0) + titleMatch[0].length)
      .replace(/^BODY:\s*/m, '')
      .trim();
  }
  if (!title) {
    // No TITLE: marker — treat the first non-empty line as the title.
    const lines = text.split('\n').filter((l) => l.trim());
    title = (lines[0] ?? '').replace(/^#+\s*/, '').trim();
    body = lines.slice(1).join('\n').trim();
  }
  if (!title) return null;
  if (title.length > 90) title = `${title.slice(0, 87)}…`;
  return { title, body };
}

const PrErrorSchema = z.object({ error: z.string() });

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls',
  tags: ['Projects'],
  summary: 'Create (or reuse) a native pull request on an Agent Hub-hosted project',
  description:
    'Creates a DB-backed Hub PR for a branch already pushed to the hosted repo. Idempotent per open head branch. 400 for projects not hosted on Agent Hub — use gh pr create there.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          headBranch: z.string(),
          baseBranch: z
            .string()
            .optional()
            .openapi({ description: 'Defaults to the default branch.' }),
          title: z.string().min(1),
          body: z.string().optional(),
          sessionId: z.string().nullable().optional().openapi({
            description:
              'Acting session id used to attribute the PR author to the session owner when the caller has no per-user identity (e.g. the global break-glass apiKey). Falls back to the X-Agent-Hub-Session-Id header / spawn-creds key.',
          }),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: {
      description: 'PR created (or reused when one was already open for the branch).',
      content: jsonContent(
        z.object({
          prUrl: z.string(),
          number: z.number(),
          created: z.boolean(),
        }),
      ),
    },
    400: {
      description: 'Not Hub-hosted, invalid branch, or missing fields.',
      content: jsonContent(z.object({ error: z.string() })),
    },
    404: {
      description: 'Unknown project or head branch not pushed.',
      content: jsonContent(z.object({ error: z.string() })),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/branch-changes',
  tags: ['Projects'],
  summary: 'Preview branch changes for a native pull request',
  description:
    'Returns file-level changes for a branch pushed to an Agent Hub-hosted repo before creating a native PR. Base defaults to the hosted repo default branch.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          headBranch: z.string(),
          baseBranch: z.string().optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Branch file changes.',
      content: jsonContent(
        z.object({
          headBranch: z.string(),
          baseBranch: z.string(),
          stats: z.object({
            changedFiles: z.number(),
            additions: z.number(),
            deletions: z.number(),
          }),
          files: z.array(
            z.object({
              filename: z.string(),
              status: z.enum(['added', 'removed', 'modified', 'renamed']),
              additions: z.number(),
              deletions: z.number(),
            }),
          ),
          truncated: z.boolean(),
        }),
      ),
    },
    400: { description: 'Invalid branch or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project or branch.', content: jsonContent(PrErrorSchema) },
    502: { description: 'Git diff failed.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/pulls/{number}',
  tags: ['Projects'],
  summary: 'Edit the title/body/base branch of an open native pull request',
  description:
    'Agent Hub-hosted projects only. Closed/merged PRs are immutable (409). At least one of title/body/baseBranch must be supplied. baseBranch retargets the PR onto a different base that exists on the hosted repo (the diff recomputes on the next read).',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          title: z.string().min(1).optional(),
          body: z.string().optional(),
          baseBranch: z.string().min(1).optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated PR summary (same shape as the list rows).',
      content: jsonContent(z.object({ pr: z.record(z.string(), z.unknown()) })),
    },
    400: {
      description: 'Invalid input or not Hub-hosted.',
      content: jsonContent(z.object({ error: z.string() })),
    },
    404: {
      description: 'Unknown project or PR.',
      content: jsonContent(z.object({ error: z.string() })),
    },
    409: { description: 'PR is not open.', content: jsonContent(z.object({ error: z.string() })) },
  },
});

const PrActionOkSchema = z.object({ pr: z.record(z.string(), z.unknown()) });

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/reopen',
  tags: ['Projects'],
  summary: 'Reopen a closed native pull request',
  description: 'Closed → open. Merged PRs are immutable (409). Agent Hub-hosted projects only.',
  request: { params: z.object({ projectId: z.string(), number: z.string() }) },
  responses: {
    200: { description: 'Reopened PR summary.', content: jsonContent(PrActionOkSchema) },
    400: { description: 'Not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is merged or already open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/auto-merge',
  tags: ['Projects'],
  summary: 'Arm or disarm auto-merge on a native pull request',
  description:
    'Arms (or disarms) auto-merge on an open Agent Hub-hosted PR. An armed PR merges once its head checks pass and it is otherwise mergeable; if it is already green and mergeable, it merges immediately (response `merged: true`). Same behaviour as `git push -o automerge`. Agent Hub-hosted projects only; merged/closed PRs are rejected (409).',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(z.object({ enabled: z.boolean() })),
    },
  },
  responses: {
    200: {
      description: 'The updated PR summary plus whether an immediate merge fired.',
      content: jsonContent(
        z.object({ pr: z.record(z.string(), z.unknown()), merged: z.boolean() }),
      ),
    },
    400: { description: 'Not Hub-hosted or invalid body.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is merged or closed.', content: jsonContent(PrErrorSchema) },
  },
});

const ScheduleAutoMergeBodySchema = z.object({
  localDateTime: z.string().nullable().openapi({
    description:
      'Wall-clock time the user picked in their browser, `YYYY-MM-DDTHH:mm`. `null` clears the schedule.',
    example: '2026-10-13T09:30',
  }),
  timeZone: z.string().optional().openapi({
    description:
      "The browser's IANA time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Required unless clearing.",
    example: 'America/Chicago',
  }),
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/pulls/{number}/auto-merge/schedule',
  tags: ['Projects'],
  summary: 'Schedule auto-merge on a native pull request for a date and time',
  description:
    'Schedules auto-merge for a browser-local date/time; the server converts it to UTC using the given IANA zone. Until that time the PR is not armed, so checks passing early do not merge it. At the scheduled time the Hub arms auto-merge and merges if the PR is mergeable; otherwise it stays armed and merges once checks pass. Arming or disarming via `POST .../auto-merge` cancels the schedule. Agent Hub-hosted projects only; the time must be in the future and within one year.',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: { content: jsonContent(ScheduleAutoMergeBodySchema) },
  },
  responses: {
    200: {
      description: 'The updated PR summary; `pr.auto_merge_at` is the scheduled UTC instant.',
      content: jsonContent(
        z.object({
          pr: z.record(z.string(), z.unknown()),
          autoMergeAt: z
            .string()
            .nullable()
            .openapi({ description: 'Scheduled time, UTC ISO 8601.' }),
        }),
      ),
    },
    400: {
      description: 'Not Hub-hosted, invalid time/zone, or time not in the future.',
      content: jsonContent(PrErrorSchema),
    },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is merged or closed.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/revert',
  tags: ['Projects'],
  summary: 'Revert a merged native pull request',
  description:
    "Commits the inverse of the PR's merge commit on its base branch and pushes the moved branch to the GitHub mirror, so the change is undone on both. History is not rewritten — a revert commit is added, matching `git revert` and GitHub's Revert button. Merged PRs only, once per PR.",
  request: { params: z.object({ projectId: z.string(), number: z.string() }) },
  responses: {
    200: {
      description: 'The revert commit sha and the updated PR summary.',
      content: jsonContent(
        z.object({ revertSha: z.string(), pr: z.record(z.string(), z.unknown()) }),
      ),
    },
    400: { description: 'Not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: {
      description: 'Unknown project/PR, or the merge commit is gone from the repo.',
      content: jsonContent(PrErrorSchema),
    },
    409: {
      description:
        'PR is not merged, was already reverted, is no longer on the base branch, or the revert conflicts with later commits.',
      content: jsonContent(PrErrorSchema),
    },
    503: {
      description: 'The base branch kept moving; retry.',
      content: jsonContent(PrErrorSchema),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/update-branch',
  tags: ['Projects'],
  summary: 'Update a native pull request branch with its base',
  description:
    'GitHub\'s "Update branch": merges the base branch into the PR head branch in the hosted repo (a merge commit on the head; the base is untouched), then mirrors the head and reruns PR-level CI. Open Agent Hub-hosted PRs only. Refused when the merge would conflict or the head already contains the base.',
  request: { params: z.object({ projectId: z.string(), number: z.string() }) },
  responses: {
    200: {
      description: 'The new head sha and the updated PR row.',
      content: jsonContent(
        z.object({ headSha: z.string(), pr: z.record(z.string(), z.unknown()) }),
      ),
    },
    400: {
      description: 'Not Hub-hosted or invalid PR number.',
      content: jsonContent(PrErrorSchema),
    },
    404: {
      description: 'Unknown project/PR, or the base/head branch is gone.',
      content: jsonContent(PrErrorSchema),
    },
    409: {
      description:
        'PR is not open, the head already contains the base, the merge conflicts, or the head moved during the update.',
      content: jsonContent(PrErrorSchema),
    },
  },
});

export const PrEnvironmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: z.enum(['native', 'github']),
  prNumber: z.number().int(),
  headSha: z.string(),
  headBranch: z.string().nullable(),
  status: z.enum(['queued', 'building', 'ready', 'failed', 'stopped']),
  url: z
    .string()
    .nullable()
    .describe(
      'Where the environment is served once ready. With wildcard preview ingress configured this is `https://pr-<n>--<project>.<previewBase>/` (the app at `/`, websockets proxied); otherwise the direct upstream, `http://localhost:<port>` on a local Hub.',
    ),
  error: z.string().nullable(),
  stopReason: z
    .enum(['merged', 'closed', 'manual', 'no_preview_config', 'idle', 'expired'])
    .nullable()
    .describe(
      '`idle`: asleep after the idle TTL or evicted by the project cap; the next request to its URL wakes it. `expired`: the head went unchanged past the max lifetime; a push or Start brings it back.',
    ),
  runnerRef: z.string().nullable(),
  cleanupPending: z.boolean(),
  logTail: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  readyAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  lastHitAt: z
    .string()
    .nullable()
    .describe('Last request through the environment URL, recorded at most once a minute.'),
  renewedAt: z
    .string()
    .describe('Start of the max-lifetime clock: created, head moved, or started manually.'),
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/preview/start',
  tags: ['Projects'],
  summary: 'Start (or rebuild) the PR environment for a pull request',
  description:
    "Queues the PR environment at the PR's current head commit. Environments are keyed by the pull request, not by any chat session, so any head branch works. Requires a `preview:` block in `.agent-hub/deploy.yaml` at the head commit. A failed or stopped environment is rebuilt; an active one at the same commit is returned unchanged. Works for Agent Hub-hosted PRs and for GitHub-hosted projects with `githubRepo` set (PR state read from the GitHub API with a project Owner's token). Environments are opt-in: opening a PR never starts one, only this call does. Once started, a new push rebuilds it (immediately for Hub-hosted PRs, on the periodic re-check for GitHub-hosted ones) and a merge or close stops it.",
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({ route: z.string().optional(), reason: z.string().optional() }).partial(),
      ),
    },
  },
  responses: {
    200: {
      description: 'Environment queued (or already active at this commit).',
      content: jsonContent(z.object({ ok: z.literal(true), environment: PrEnvironmentSchema })),
    },
    400: {
      description:
        'Neither Hub-hosted nor a GitHub-hosted project with githubRepo, or invalid PR number.',
      content: jsonContent(PrErrorSchema),
    },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: {
      description:
        'The PR is not open, its head has no `preview:` block, or its head commit could not be read (retry later).',
      content: jsonContent(PrErrorSchema),
    },
    501: {
      description: 'PR environments are not available on this deployment.',
      content: jsonContent(PrErrorSchema),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/preview/stop',
  tags: ['Projects'],
  summary: 'Stop the PR environment for a pull request',
  description:
    'Tears down the PR environment and marks it `stopped` (reason `manual`). When an earlier teardown failed (`cleanupPending`), stopping again retries it. New commits do not restart a manually stopped environment until it is started again. Idempotent: `stopped` is false when nothing was running. Environments also stop automatically when the PR merges or closes.',
  request: { params: z.object({ projectId: z.string(), number: z.string() }) },
  responses: {
    200: {
      description: 'Stop processed.',
      content: jsonContent(
        z.object({
          ok: z.literal(true),
          stopped: z.boolean(),
          environment: PrEnvironmentSchema.nullable(),
        }),
      ),
    },
    400: {
      description:
        'Neither Hub-hosted nor a GitHub-hosted project with githubRepo, or invalid PR number.',
      content: jsonContent(PrErrorSchema),
    },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    501: {
      description: 'PR environments are not available on this deployment.',
      content: jsonContent(PrErrorSchema),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/pulls/{number}/preview/state',
  tags: ['Projects'],
  summary: 'Read the PR environment for a pull request',
  description:
    'Returns the PR environment row (status queued/building/ready/failed/stopped, url, error, log tail), or `environment: null` when the PR never had one.',
  request: { params: z.object({ projectId: z.string(), number: z.string() }) },
  responses: {
    200: {
      description: 'Environment (or null).',
      content: jsonContent(z.object({ environment: PrEnvironmentSchema.nullable() })),
    },
    400: {
      description:
        'Neither Hub-hosted nor a GitHub-hosted project with githubRepo, or invalid PR number.',
      content: jsonContent(PrErrorSchema),
    },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    501: {
      description: 'PR environments are not available on this deployment.',
      content: jsonContent(PrErrorSchema),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/request-review',
  tags: ['Projects'],
  summary: 'Request a review on a native pull request (human flag and/or agent)',
  description:
    "With requested=true: kind='human' flips the human-review flag only; kind='agent' dispatches the project Reviewer agent only, leaving the flag untouched; kind='both' (the default when omitted) does both, preserving legacy behavior. requested=false always clears the human-review flag and never dispatches, regardless of kind.",
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          requested: z.boolean().optional(),
          kind: z.enum(['agent', 'human', 'both']).optional(),
        }),
      ),
      required: false,
    },
  },
  responses: {
    200: {
      description:
        'Updated PR summary. agent_review_dispatched is true only when a Reviewer agent session was actually dispatched (present only for agent/both requests).',
      content: jsonContent(
        z.object({
          pr: z.record(z.string(), z.unknown()),
          agent_review_dispatched: z.boolean().optional(),
          agent_review_reason: z.string().optional().openapi({
            description:
              "Why an agent dispatch did not occur, e.g. 'already_in_flight', 'no_reviewer', 'engine_unavailable'.",
          }),
        }),
      ),
    },
    400: {
      description: "Not Hub-hosted, or kind is not one of 'agent' | 'human' | 'both'.",
      content: jsonContent(PrErrorSchema),
    },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is not open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/reviews',
  tags: ['Projects'],
  summary: 'Submit a human review on a native pull request',
  description:
    'state: approved | changes_requested | commented. A verdict (approve/request changes) clears any outstanding review-request flag. Reviews render in the PR detail and feed the Autofix context.',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          state: z.enum(['approved', 'changes_requested', 'commented']),
          body: z.string().optional(),
          reviewer: z
            .string()
            .optional()
            .openapi({ description: 'Reviewer-name override (agent reviews).' }),
          session_id: z.string().nullable().optional().openapi({
            description:
              'Acting session id (also accepted via the X-Agent-Hub-Session-Id header). A verdict clears the in-flight agent-review claim only when this matches the session that owns it.',
          }),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: {
      description: 'The recorded review (GitHub review-object shape).',
      content: jsonContent(z.object({ review: z.record(z.string(), z.unknown()) })),
    },
    400: { description: 'Invalid state or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is not open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/reviews/{reviewId}/dismiss',
  tags: ['Projects'],
  summary: 'Dismiss a submitted review on a native pull request',
  description:
    'GitHub-style "Dismiss review": the review row is kept for history but its verdict stops counting toward the review decision and renders collapsed with the dismissal note. Only approved / changes_requested reviews can be dismissed (a comment review has no verdict). A reason is required. Allowed on closed and merged PRs.',
  request: {
    params: z.object({ projectId: z.string(), number: z.string(), reviewId: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          reason: z.string().min(1).openapi({ description: 'Why the review is being dismissed.' }),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'The dismissed review (GitHub review-object shape).',
      content: jsonContent(z.object({ review: z.record(z.string(), z.unknown()) })),
    },
    400: {
      description: 'Missing reason, comment review, or not Hub-hosted.',
      content: jsonContent(PrErrorSchema),
    },
    404: { description: 'Unknown project/PR/review.', content: jsonContent(PrErrorSchema) },
    409: { description: 'Review is already dismissed.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/comments',
  tags: ['Projects'],
  summary: 'Add an inline (per-line) diff comment to a native pull request',
  description:
    "Anchored to a file + line in the PR diff. side 'new' = post-image line number (additions/context), 'old' = pre-image (deletions). Rendered inside the Files-changed diff and included in the Autofix context.",
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          filePath: z.string().min(1),
          line: z.coerce.number().int().min(1),
          side: z.enum(['old', 'new']).optional(),
          body: z.string().min(1),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: {
      description: 'The recorded comment.',
      content: jsonContent(z.object({ comment: z.record(z.string(), z.unknown()) })),
    },
    400: { description: 'Invalid input or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(PrErrorSchema) },
    409: { description: 'PR is not open.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/comment-threads/resolve',
  tags: ['Projects'],
  summary: 'Resolve or unresolve an inline comment thread on a native pull request',
  description:
    'A thread is the set of inline comments sharing an anchor (filePath + line + side); resolution is stored against that anchor, so a later reply joins an already-resolved thread. Resolved threads render collapsed in the Files-changed diff. Allowed on closed and merged PRs.',
  request: {
    params: z.object({ projectId: z.string(), number: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          filePath: z.string().min(1),
          line: z.coerce.number().int().min(1),
          side: z.enum(['old', 'new']).optional(),
          resolved: z.boolean(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'The thread anchor and its new resolution state.',
      content: jsonContent(z.object({ thread: z.record(z.string(), z.unknown()) })),
    },
    400: { description: 'Invalid input or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: {
      description: 'Unknown project/PR, or no comment at that anchor.',
      content: jsonContent(PrErrorSchema),
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/pulls/{number}/comments/{commentId}',
  tags: ['Projects'],
  summary: 'Delete an inline diff comment from a native pull request',
  request: {
    params: z.object({ projectId: z.string(), number: z.string(), commentId: z.string() }),
  },
  responses: {
    200: { description: 'Deleted.', content: jsonContent(z.object({ ok: z.boolean() })) },
    400: { description: 'Not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project/PR/comment.', content: jsonContent(PrErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/generate-description',
  tags: ['Projects'],
  summary: 'Generate a PR title and description from a branch diff (AI)',
  description:
    'Runs the configured model over the branch diff + commit subjects and returns a suggested title and body. Used by the optional "Generate" button on the PR creation form — fields stay editable.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      content: jsonContent(
        z.object({
          headBranch: z.string(),
          baseBranch: z.string().optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Suggested PR text.',
      content: jsonContent(z.object({ title: z.string(), body: z.string() })),
    },
    400: { description: 'Invalid branch or not Hub-hosted.', content: jsonContent(PrErrorSchema) },
    404: { description: 'Unknown project or branch.', content: jsonContent(PrErrorSchema) },
    502: { description: 'Model invocation failed.', content: jsonContent(PrErrorSchema) },
  },
});

export default function createPullsNativeRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.post('/api/projects/:projectId/pulls', async (req: Request, res: Response) => {
    const project = deps.findProject(req.params.projectId as string) as Project | null;
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isAgentHubHosted(project) || !hostedRepoExists(project.id)) {
      return res.status(400).json({
        error:
          'Project is not hosted on Agent Hub — create the pull request on GitHub (gh pr create).',
      });
    }
    if (!deps.nativePr) {
      return res.status(503).json({ error: 'Native PR service not available' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const prBody = typeof body.body === 'string' ? body.body : '';
    const baseRaw = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
    if (!headBranch || !isSafeBranchName(headBranch)) {
      return res.status(400).json({ error: 'headBranch is required (a branch pushed to the Hub)' });
    }
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (baseRaw && !isSafeBranchName(baseRaw)) {
      return res.status(400).json({ error: 'invalid baseBranch' });
    }

    const repoPath = bareRepoPath(project.id);
    let headSha = '';
    try {
      const { stdout } = await execFileP(
        'git',
        ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${headBranch}^{commit}`],
        { timeout: 15_000 },
      );
      headSha = stdout.trim();
    } catch {
      return res.status(404).json({
        error: `Branch "${headBranch}" not found on the hosted repo — push it first (git push -u origin ${headBranch}).`,
      });
    }

    const baseBranch = baseRaw || (await hostedRepoDefaultBranch(project.id)) || 'main';
    const areq = req as AuthenticatedRequest;

    // Resolve the Hub user to stamp on the PR. The JWT / per-user-apiKey path
    // sets `authUserId` directly. The global break-glass apiKey path (agents
    // calling via `ah-api.sh`) sets no user id, so fall back to the acting
    // session's owner — resolved from the body `sessionId`, the
    // `X-Agent-Hub-Session-Id` header, or the spawn-creds key, same precedence
    // as kanban card linking. No-auth / local-bundled deployments attribute to
    // the synthetic `local` Owner (see resolveNativePrAuthorUserId).
    const rawSessionId = (body as { sessionId?: unknown }).sessionId;
    const bodySessionId =
      typeof rawSessionId === 'string' ? rawSessionId : rawSessionId === null ? null : undefined;
    const sessionId = resolveCardSessionId(req, bodySessionId);
    let authorUserId: string;
    try {
      authorUserId = resolveNativePrAuthorUserId({
        explicitUserId: areq.authUserId,
        sessionId,
      });
    } catch {
      const authRequired = Boolean(config.apiKey || getAuthRecord());
      return res.status(authRequired ? 401 : 400).json({
        error: authRequired
          ? 'Authentication required to create a pull request'
          : 'Pull request creation requires an attributed Hub user',
      });
    }
    try {
      const { row, prUrl, created } = deps.nativePr.createOrGetOpenPr({
        project,
        headBranch,
        baseBranch,
        headSha,
        title,
        body: prBody,
        author: authorUserId,
      });
      return res.status(201).json({ prUrl, number: row.number, created });
    } catch (err: unknown) {
      const status = err instanceof NativePrError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(status).json({ error: msg });
    }
  });

  router.post(
    '/api/projects/:projectId/pulls/branch-changes',
    async (req: Request, res: Response) => {
      const project = deps.findProject(req.params.projectId as string) as Project | null;
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!isAgentHubHosted(project) || !hostedRepoExists(project.id)) {
        return res.status(400).json({ error: 'Project is not hosted on Agent Hub' });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : '';
      const baseRaw = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
      if (!headBranch || !isSafeBranchName(headBranch)) {
        return res.status(400).json({ error: 'headBranch is required' });
      }
      if (baseRaw && !isSafeBranchName(baseRaw)) {
        return res.status(400).json({ error: 'invalid baseBranch' });
      }

      const repoPath = bareRepoPath(project.id);
      const baseBranch = baseRaw || (await hostedRepoDefaultBranch(project.id)) || 'main';
      const headSha = await revParse(repoPath, `refs/heads/${headBranch}`);
      const baseSha = await revParse(repoPath, `refs/heads/${baseBranch}`);
      if (!headSha || !baseSha) {
        return res.status(404).json({ error: 'Branch not found on the hosted repo' });
      }

      try {
        const mergeBaseSha = (await git(repoPath, ['merge-base', baseSha, headSha])).trim();
        // PR preview must match GitHub-style file sets, not a direct base-tip
        // vs head-tip diff. Resolving merge-base first keeps branches behind
        // base from showing reverse changes introduced on base after branching.
        const [stats, files] = await Promise.all([
          prDiffStat(repoPath, mergeBaseSha, headSha),
          prFiles(repoPath, mergeBaseSha, headSha),
        ]);
        const trimmedFiles = files.slice(0, MAX_BRANCH_CHANGE_FILES).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
        }));
        return res.json({
          headBranch,
          baseBranch,
          stats,
          files: trimmedFiles,
          truncated: files.length > trimmedFiles.length,
        });
      } catch (err: unknown) {
        return res.status(502).json({
          error: `Failed to read branch changes: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  );

  router.patch('/api/projects/:projectId/pulls/:number', async (req: Request, res: Response) => {
    const project = deps.findProject(req.params.projectId as string) as Project | null;
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isAgentHubHosted(project)) {
      return res.status(400).json({ error: 'Project is not hosted on Agent Hub' });
    }
    const number = Number.parseInt(String(req.params.number), 10);
    if (!Number.isFinite(number) || number <= 0) {
      return res.status(400).json({ error: 'Invalid PR number' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : undefined;
    const prBody = typeof body.body === 'string' ? body.body : undefined;
    const baseBranch = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : undefined;
    if (title === undefined && prBody === undefined && baseBranch === undefined) {
      return res.status(400).json({ error: 'Provide title, body, and/or baseBranch' });
    }
    if (title !== undefined && !title) {
      return res.status(400).json({ error: 'title cannot be empty' });
    }

    const row = deps.stmts.getPullRequestByNumber.get(project.id, number) as
      | { id: string; title: string; body: string; status: string }
      | undefined;
    if (!row) return res.status(404).json({ error: `PR #${number} not found` });
    if (row.status !== 'open') {
      return res.status(409).json({ error: `PR #${number} is ${row.status} — edits are locked` });
    }

    // Retarget the base branch first — it validates the ref against the hosted
    // repo and can 404/400, so we don't want a title/body write to land before
    // an invalid base rejects the whole PATCH.
    if (baseBranch !== undefined) {
      if (!deps.nativePr) {
        return res.status(503).json({ error: 'Native PR service not available' });
      }
      try {
        await deps.nativePr.retargetBase({ project, number, baseBranch });
      } catch (err: unknown) {
        return sendNativeError(res, err);
      }
    }

    if (title !== undefined || prBody !== undefined) {
      // Re-read the row here (after the awaited retarget) so an OMITTED
      // title/body field is written from the current value, not the pre-await
      // snapshot. `row` was read before `retargetBase`'s ref validation, and a
      // concurrent title-only PATCH can land during that await — writing the
      // stale `row.title`/`row.body` would clobber it. The read and the
      // UPDATE below are both synchronous (better-sqlite3), so nothing can
      // interleave between them.
      const fresh = deps.stmts.getPullRequestByNumber.get(project.id, number) as
        | { id: string; title: string; body: string; status: string }
        | undefined;
      if (!fresh || fresh.status !== 'open') {
        return res
          .status(409)
          .json({ error: `PR #${number} is no longer open — edits are locked` });
      }
      deps.stmts.updatePullRequestText.run(
        title ?? fresh.title,
        prBody ?? fresh.body,
        Date.now(),
        fresh.id,
      );
      deps.broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'edited',
      });
    }
    const updated = deps.stmts.getPullRequestByNumber.get(project.id, number);
    return res.json({ pr: updated });
  });

  /** Shared guard for the action sub-routes below. */
  const resolveActionContext = (
    req: Request,
    res: Response,
  ): { project: Project; number: number } | null => {
    const project = deps.findProject(req.params.projectId as string) as Project | null;
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    if (!isAgentHubHosted(project) || !deps.nativePr) {
      res.status(400).json({ error: 'Project is not hosted on Agent Hub' });
      return null;
    }
    const number = Number.parseInt(String(req.params.number), 10);
    if (!Number.isFinite(number) || number <= 0) {
      res.status(400).json({ error: 'Invalid PR number' });
      return null;
    }
    return { project, number };
  };

  /**
   * Parse the (filePath, line, side) anchor shared by the inline-comment and
   * thread-resolution routes, enforcing the registered Zod schema at runtime.
   *
   * Both fields are strict on purpose. `Number.parseInt` would accept `1.5`
   * and `"1junk"` and quietly truncate them to a different line than the
   * caller named, and coercing every unrecognised `side` to `'new'` would
   * silently retarget the write — GitHub's own review API spells these sides
   * `LEFT`/`RIGHT`, so a client copying that vocabulary is a realistic way to
   * hit it. A wrong anchor is worse than a 400 because it lands on a real
   * neighbouring thread.
   */
  const parseCommentAnchor = (
    body: Record<string, unknown>,
  ):
    | { ok: true; anchor: { filePath: string; line: number; side: 'old' | 'new' } }
    | { ok: false; error: string } => {
    const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
    if (!filePath) return { ok: false, error: 'filePath is required' };
    // Strings stay acceptable (agents post JSON by hand), but only when they
    // name an exact integer — Number('1junk') is NaN, Number('1.5') is 1.5.
    const raw = body.line;
    const line =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : Number.NaN;
    if (!Number.isInteger(line) || line <= 0) {
      return { ok: false, error: 'line must be a positive integer' };
    }
    if (body.side !== undefined && body.side !== 'old' && body.side !== 'new') {
      return { ok: false, error: "side must be 'old' or 'new'" };
    }
    return { ok: true, anchor: { filePath, line, side: body.side === 'old' ? 'old' : 'new' } };
  };

  const sendNativeError = (res: Response, err: unknown): void => {
    const status = err instanceof NativePrError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  };

  router.post('/api/projects/:projectId/pulls/:number/reopen', (req: Request, res: Response) => {
    const ctx = resolveActionContext(req, res);
    if (!ctx) return;
    try {
      const { row } = deps.nativePr!.reopen({ project: ctx.project, number: ctx.number });
      res.json({ pr: row });
    } catch (err: unknown) {
      sendNativeError(res, err);
    }
  });

  router.post(
    '/api/projects/:projectId/pulls/:number/auto-merge',
    async (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled (boolean) is required' });
      }
      try {
        const { row } = deps.nativePr!.setAutoMerge({
          project: ctx.project,
          number: ctx.number,
          enabled: body.enabled,
        });
        // Arming a PR that is already green + mergeable merges it now rather
        // than waiting for the next checks-passed event.
        if (body.enabled) {
          const outcome = await tryAutoMergeArmedNativePr(
            { stmts: deps.stmts, nativePr: deps.nativePr! },
            { project: ctx.project, number: ctx.number },
          );
          if (outcome.merged) {
            const merged = deps.stmts.getPullRequestByNumber.get(ctx.project.id, ctx.number);
            return res.json({ pr: merged, merged: true });
          }
        }
        return res.json({ pr: row, merged: false });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  router.put(
    '/api/projects/:projectId/pulls/:number/auto-merge/schedule',
    (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const parsed = ScheduleAutoMergeBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'localDateTime (string or null) is required' });
      }
      const { localDateTime, timeZone } = parsed.data;
      let at: number | null = null;
      if (localDateTime !== null) {
        if (!timeZone) return res.status(400).json({ error: 'timeZone is required' });
        try {
          at = zonedWallTimeToUtcMs(localDateTime, timeZone);
        } catch (err: unknown) {
          if (err instanceof ZonedTimeError) return res.status(400).json({ error: err.message });
          throw err;
        }
      }
      try {
        const { row } = deps.nativePr!.scheduleAutoMerge({
          project: ctx.project,
          number: ctx.number,
          at,
        });
        const atMs = row.auto_merge_at ?? null;
        return res.json({
          pr: row,
          autoMergeAt: atMs === null ? null : new Date(atMs).toISOString(),
        });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/pulls/:number/update-branch',
    async (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const areq = req as AuthenticatedRequest;
      try {
        const result = await deps.nativePr!.updateBranch({
          project: ctx.project,
          number: ctx.number,
          actor: areq.authUser ?? areq.authUserId ?? 'user',
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        const pr = deps.stmts.getPullRequestByNumber.get(ctx.project.id, ctx.number);
        return res.json({ headSha: result.headSha, pr });
      } catch (err: unknown) {
        sendNativeError(res, err);
        return;
      }
    },
  );

  router.post(
    '/api/projects/:projectId/pulls/:number/revert',
    async (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const areq = req as AuthenticatedRequest;
      try {
        const result = await deps.nativePr!.revert({
          project: ctx.project,
          number: ctx.number,
          actor: areq.authUser ?? areq.authUserId ?? 'user',
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        const pr = deps.stmts.getPullRequestByNumber.get(ctx.project.id, ctx.number);
        return res.json({ revertSha: result.revertSha, pr });
      } catch (err: unknown) {
        sendNativeError(res, err);
        return;
      }
    },
  );

  // PR environments
  // Keyed by pull request (`pr_environments`), never by the authoring session,
  // so a PR on any head branch can have one. For Agent Hub-hosted PRs, open
  // state and head come from the PR row and the hosted ref; GitHub-hosted
  // projects use the same routes with state read from the GitHub API.
  type PreviewCtx =
    | { project: Project; number: number; source: 'native'; pr: PullRequestRow }
    | { project: Project; number: number; source: 'github' };

  // Clients get the public environment URL, never the internal upstream.
  const present = (env: PrEnvironmentDto): PrEnvironmentDto =>
    deps.presentPrEnvironment ? deps.presentPrEnvironment(env) : env;

  const resolvePreviewContext = (req: Request, res: Response): PreviewCtx | null => {
    const project = deps.findProject(req.params.projectId as string) as Project | null;
    if (project && !isAgentHubHosted(project) && githubRepoOf(project)) {
      const number = Number.parseInt(String(req.params.number), 10);
      if (!Number.isFinite(number) || number <= 0) {
        res.status(400).json({ error: 'Invalid PR number' });
        return null;
      }
      if (!deps.prEnvironments || !deps.readGithubPrState) {
        res.status(501).json({ error: 'PR environments are not available on this deployment.' });
        return null;
      }
      return { project, number, source: 'github' };
    }
    const ctx = resolveActionContext(req, res);
    if (!ctx) return null;
    if (!deps.prEnvironments) {
      res.status(501).json({ error: 'PR environments are not available on this deployment.' });
      return null;
    }
    const pr = deps.stmts.getPullRequestByNumber.get(ctx.project.id, ctx.number) as
      | PullRequestRow
      | undefined;
    if (!pr) {
      res.status(404).json({ error: `PR #${ctx.number} not found` });
      return null;
    }
    return { ...ctx, source: 'native', pr };
  };

  router.post(
    '/api/projects/:projectId/pulls/:number/preview/start',
    async (req: Request, res: Response) => {
      const ctx = resolvePreviewContext(req, res);
      if (!ctx) return;
      // Pin the org once for the whole request: the reads below run later,
      // inside that org's per-PR queue, and must not follow an org switch.
      const service = deps.prEnvironments!.pin();
      const pr = { source: ctx.source, prNumber: ctx.number } as const;
      const projectId = ctx.project.id;
      const orgStmts = service.org.stmts;
      // Read inside the service's per-PR queue: a close/merge that lands while
      // the head lookup is in flight is seen before anything is queued.
      const readGithub = deps.readGithubPrState;
      const readState =
        ctx.source === 'github'
          ? () => readGithub!(ctx.project, ctx.number)
          : () =>
              readNativePrState(
                {
                  getPr: (id, n) =>
                    orgStmts.getPullRequestByNumber.get(id, n) as PullRequestRow | undefined,
                  // The hosted ref is the truth; the row's sha only moves on PR create/refresh.
                  revParseHead: async (id, branch) =>
                    hostedRepoExists(id)
                      ? revParse(bareRepoPath(id), `refs/heads/${branch}`)
                      : null,
                },
                projectId,
                ctx.number,
              );
      try {
        const result = await service.start(ctx.project, pr, readState);
        if (!result.ok) {
          return res
            .status(result.reason === 'not_found' ? 404 : 409)
            .json({ error: result.error });
        }
        return res.json({ ok: true, environment: present(result.environment) });
      } catch (err: unknown) {
        return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  router.post(
    '/api/projects/:projectId/pulls/:number/preview/stop',
    async (req: Request, res: Response) => {
      const ctx = resolvePreviewContext(req, res);
      if (!ctx) return;
      const service = deps.prEnvironments!.pin();
      const pr = { source: ctx.source, prNumber: ctx.number } as const;
      const before = service.get(ctx.project.id, pr);
      try {
        const environment = await service.stop(ctx.project, pr);
        const stopped = Boolean(before && before.status !== 'stopped');
        return res.json({
          ok: true,
          stopped,
          environment: environment ? present(environment) : environment,
        });
      } catch (err: unknown) {
        return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  router.get(
    '/api/projects/:projectId/pulls/:number/preview/state',
    (req: Request, res: Response) => {
      const ctx = resolvePreviewContext(req, res);
      if (!ctx) return;
      const environment = deps.prEnvironments!.get(ctx.project.id, {
        source: ctx.source,
        prNumber: ctx.number,
      });
      return res.json({ environment: environment ? present(environment) : null });
    },
  );

  router.post(
    '/api/projects/:projectId/pulls/:number/request-review',
    async (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const requestedRaw = body.requested;
      const requested = requestedRaw === undefined ? true : requestedRaw === true;
      // `kind` splits the two reviewer surfaces:
      //   'human' — flip the human-review flag only (no agent dispatch)
      //   'agent' — dispatch the Reviewer agent only (leave the human flag alone)
      //   'both'  — the pre-split behavior; legacy callers that omit `kind`
      //             (flag + dispatch) land here for backward compatibility.
      // Enforce the registered enum at runtime: a typo must 400, not silently
      // fall back to 'both' (which would flag AND dispatch unexpectedly).
      const kindRaw = body.kind;
      if (
        kindRaw !== undefined &&
        kindRaw !== 'agent' &&
        kindRaw !== 'human' &&
        kindRaw !== 'both'
      ) {
        return res.status(400).json({ error: "kind must be 'agent', 'human', or 'both'" });
      }
      const kind: 'agent' | 'human' | 'both' = (kindRaw as 'agent' | 'human' | 'both') ?? 'both';
      const areq = req as AuthenticatedRequest;
      try {
        let row: {
          number: number;
          head_branch: string;
          status: 'open' | 'closed' | 'merged';
          author: string;
        };
        // Write the human-review flag except for an agent-only *set*
        // (kind='agent' && requested): that dispatches without flagging.
        // A clear (requested=false) always goes through the flag path — clearing
        // is inherently a human-flag action — so kind='agent' + requested=false
        // still clears the flag, matching the documented contract.
        const writeFlag = !requested || kind !== 'agent';
        if (writeFlag) {
          ({ row } = deps.nativePr!.setReviewRequested({
            project: ctx.project,
            number: ctx.number,
            requested,
            actor: areq.authUser ?? areq.authUserId ?? 'user',
          }));
        } else {
          // Agent-only set: don't touch the human-review flag. Load and guard the
          // PR ourselves so 404 (unknown) / 409 (not open) match setReviewRequested.
          const pr = deps.stmts.getPullRequestByNumber.get(ctx.project.id, ctx.number) as
            | typeof row
            | undefined;
          if (!pr) throw new NativePrError(`PR #${ctx.number} not found`, 404);
          if (pr.status !== 'open') {
            throw new NativePrError(`PR #${ctx.number} is ${pr.status}`, 409);
          }
          row = pr;
        }
        // Dispatch the project Reviewer agent against this PR for agent/both
        // requests. We AWAIT the dispatch and report whether it actually
        // happened: the helper no-ops (no reviewer agent, unavailable engine,
        // dedup, guard) return dispatched:false, and only a real dispatch stamps
        // the durable agent_review_requested flag. Reporting the outcome lets the
        // client avoid latching a "review requested" state that will never
        // produce a flag or verdict. Awaiting is bounded: the helper kicks off
        // handleChat without waiting for the review to finish.
        //
        // We deliberately do NOT pass `force`: that is a test-only seam to
        // bypass the `AGENT_HUB_DISABLE_AUTO_REVIEW` guard, which is set ONLY in
        // server/test/setup.ts. In production the guard env is unset, so this
        // dispatches normally; under test it stays inert (no real Reviewer CLI
        // spawn). The route→dispatch wiring is covered by spying on the helper
        // in pulls-native.test.ts, independent of that guard.
        let agentReviewDispatched: boolean | undefined;
        let agentReviewReason: string | undefined;
        if (requested && kind !== 'human') {
          const result = await maybeRunPrAutoReview(
            ctx.project,
            {
              number: row.number,
              head_branch: row.head_branch,
              status: row.status,
              author: row.author,
            },
            {
              stmts: deps.stmts,
              config: deps.config,
              broadcast: deps.broadcast,
              handleChat: deps.handleChat,
            },
            { trigger: 'manual_request', pushedByUserId: areq.authUserId ?? null },
          );
          agentReviewDispatched = result?.dispatched === true;
          agentReviewReason = result?.reason;
        }
        res.json({
          pr: row,
          agent_review_dispatched: agentReviewDispatched,
          agent_review_reason: agentReviewReason,
        });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  router.post('/api/projects/:projectId/pulls/:number/reviews', (req: Request, res: Response) => {
    const ctx = resolveActionContext(req, res);
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = body.state;
    if (state !== 'approved' && state !== 'changes_requested' && state !== 'commented') {
      return res
        .status(400)
        .json({ error: 'state must be "approved", "changes_requested", or "commented"' });
    }
    const reviewBody = typeof body.body === 'string' ? body.body : '';
    if (state === 'commented' && !reviewBody.trim()) {
      return res.status(400).json({ error: 'a comment review needs a body' });
    }
    const areq = req as AuthenticatedRequest;
    // Optional reviewer-name override for agent reviews (the auto-review
    // dispatch tells the Reviewer agent to sign with its own name so
    // per-reviewer verdict precedence works). Authenticated callers on a
    // trusted instance only — attribution, not authorization.
    const reviewerOverride =
      typeof body.reviewer === 'string' && body.reviewer.trim()
        ? body.reviewer.trim().slice(0, 80)
        : null;
    // Owning session id used to clear the in-flight agent-review claim. This is
    // an AUTHORIZATION signal, so it must NOT be a plain caller-supplied value:
    // session ids are broadcast in `pr_auto_review_started`, so any authenticated
    // project user could replay one to clear a live claim. We therefore trust
    // only:
    //   1. `authSpawnSessionId` — the cryptographically bound session id derived
    //      by the auth layer from the reviewer spawn's per-session `spawn:<id>`
    //      key (no-global-apiKey deployments). Not forgeable by another user.
    //   2. the caller-supplied session id, but ONLY under the global break-glass
    //      apiKey (`authViaApiKey`) — that key is server-injected into reviewer
    //      spawns when a global apiKey is configured, so the request is
    //      server-originated and the prompt-baked X-Agent-Hub-Session-Id header
    //      is trustworthy. A regular JWT / per-user-key caller gets null here and
    //      cannot clear the claim by replaying an id.
    // Mirrors the break-glass identity resolution in aws-sso-caller-identity.ts.
    const bound = areq.authSpawnSessionId;
    let claimSessionId: string | null = null;
    if (typeof bound === 'string' && bound.trim()) {
      claimSessionId = bound.trim();
    } else if (areq.authViaApiKey) {
      const bodySessionId = typeof body.session_id === 'string' ? body.session_id : undefined;
      claimSessionId = resolveCardSessionId(req, bodySessionId);
    }
    try {
      const { review } = deps.nativePr!.submitReview({
        project: ctx.project,
        number: ctx.number,
        state,
        body: reviewBody,
        reviewer: reviewerOverride ?? areq.authUser ?? areq.authUserId ?? 'user',
        sessionId: claimSessionId,
      });
      res.status(201).json({ review });
    } catch (err: unknown) {
      sendNativeError(res, err);
    }
  });

  router.post(
    '/api/projects/:projectId/pulls/:number/reviews/:reviewId/dismiss',
    (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) {
        return res.status(400).json({ error: 'a dismissal reason is required' });
      }
      const areq = req as AuthenticatedRequest;
      try {
        const { review } = deps.nativePr!.dismissReview({
          project: ctx.project,
          number: ctx.number,
          reviewId: String(req.params.reviewId),
          reason: reason.slice(0, 2000),
          actor: areq.authUser ?? areq.authUserId ?? 'user',
        });
        res.json({ review });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  router.post('/api/projects/:projectId/pulls/:number/comments', (req: Request, res: Response) => {
    const ctx = resolveActionContext(req, res);
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseCommentAnchor(body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) return res.status(400).json({ error: 'body is required' });
    const areq = req as AuthenticatedRequest;
    try {
      const { comment } = deps.nativePr!.addInlineComment({
        project: ctx.project,
        number: ctx.number,
        filePath: parsed.anchor.filePath,
        line: parsed.anchor.line,
        side: parsed.anchor.side,
        body: text,
        author: areq.authUser ?? areq.authUserId ?? 'user',
      });
      res.status(201).json({ comment });
    } catch (err: unknown) {
      sendNativeError(res, err);
    }
  });

  router.post(
    '/api/projects/:projectId/pulls/:number/comment-threads/resolve',
    (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = parseCommentAnchor(body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      if (typeof body.resolved !== 'boolean') {
        return res.status(400).json({ error: 'resolved must be a boolean' });
      }
      const areq = req as AuthenticatedRequest;
      try {
        const { thread } = deps.nativePr!.setCommentThreadResolved({
          project: ctx.project,
          number: ctx.number,
          filePath: parsed.anchor.filePath,
          line: parsed.anchor.line,
          side: parsed.anchor.side,
          resolved: body.resolved,
          actor: areq.authUser ?? areq.authUserId ?? 'user',
        });
        res.json({ thread });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/pulls/generate-description',
    async (req: Request, res: Response) => {
      const project = deps.findProject(req.params.projectId as string) as Project | null;
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!isAgentHubHosted(project) || !hostedRepoExists(project.id)) {
        return res.status(400).json({ error: 'Project is not hosted on Agent Hub' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : '';
      const baseRaw = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
      if (!headBranch || !isSafeBranchName(headBranch)) {
        return res.status(400).json({ error: 'headBranch is required' });
      }
      if (baseRaw && !isSafeBranchName(baseRaw)) {
        return res.status(400).json({ error: 'invalid baseBranch' });
      }

      const repoPath = bareRepoPath(project.id);
      const baseBranch = baseRaw || (await hostedRepoDefaultBranch(project.id)) || 'main';
      const headSha = await revParse(repoPath, `refs/heads/${headBranch}`);
      const baseSha = await revParse(repoPath, `refs/heads/${baseBranch}`);
      if (!headSha || !baseSha) {
        return res.status(404).json({ error: 'Branch not found on the hosted repo' });
      }

      let diff = '';
      let commits: Array<{ subject: string }> = [];
      try {
        [diff, commits] = await Promise.all([
          prDiff(repoPath, baseSha, headSha),
          prCommits(repoPath, baseSha, headSha),
        ]);
      } catch (err: unknown) {
        return res
          .status(502)
          .json({ error: `Failed to read diff: ${err instanceof Error ? err.message : err}` });
      }
      if (diff.length > GENERATE_DIFF_BUDGET) {
        diff = `${diff.slice(0, GENERATE_DIFF_BUDGET)}\n…(diff truncated at ${GENERATE_DIFF_BUDGET} chars)`;
      }

      const systemPrompt =
        'You write pull request titles and descriptions. Respond in EXACTLY this format with no preamble:\n' +
        'TITLE: <imperative summary, under 70 characters>\n' +
        'BODY:\n' +
        '## Summary\n<2-4 bullet points of what changed and why>\n\n' +
        '## Test plan\n<1-3 bullets on how this was or should be verified>';
      const prompt =
        `Branch: ${headBranch} → ${baseBranch}\n\n` +
        `Commits:\n${commits.map((c) => `- ${c.subject}`).join('\n') || '(none)'}\n\n` +
        `Diff:\n${diff || '(empty diff)'}`;

      const actingUserId = (req as AuthenticatedRequest).authUserId ?? null;
      try {
        const raw = await generatePrText(prompt, systemPrompt, repoPath, actingUserId);
        const parsed = parseGeneratedPrText(raw);
        if (!parsed) {
          return res.status(502).json({ error: 'Model returned no usable title' });
        }
        // The CLI reports auth problems as normal text output — don't let
        // "Not logged in · Please run /login" become a PR title.
        if (/not logged in|please run \/login/i.test(parsed.title)) {
          return res.status(400).json({
            error:
              'Your Claude account is not connected — add it under Settings → Account, then try again.',
          });
        }
        return res.json(parsed);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === 'EngineAuthRequiredError') {
          return res.status(400).json({
            error:
              'No AI engine is connected for your account — add Claude, Cursor, Codex, or Grok under Settings → Account, then try again.',
          });
        }
        // No engine in the fallback chain was available for this user.
        if (err instanceof Error && err.name === 'NoEnginesAvailableError') {
          return res.status(400).json({ error: msg });
        }
        return res.status(502).json({ error: `Generation failed: ${msg.split('\n')[0]}` });
      }
    },
  );

  router.delete(
    '/api/projects/:projectId/pulls/:number/comments/:commentId',
    (req: Request, res: Response) => {
      const ctx = resolveActionContext(req, res);
      if (!ctx) return;
      try {
        deps.nativePr!.deleteInlineComment({
          project: ctx.project,
          number: ctx.number,
          commentId: String(req.params.commentId),
        });
        // 200 + body (not 204): the client fetch helper parses JSON on
        // every success, and an empty 204 body would throw.
        res.json({ ok: true });
      } catch (err: unknown) {
        sendNativeError(res, err);
      }
    },
  );

  return router;
}
