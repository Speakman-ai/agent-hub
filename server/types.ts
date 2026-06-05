import type { Request, Response, NextFunction, Router } from 'express';
import type Database from 'better-sqlite3';

// ─── Database Row Types ──────────────────────────────────────────

export interface SessionRow {
  id: string;
  agent_id: string;
  name: string;
  engine: string;
  model: string;
  engine_session_id: string | null;
  use_worktree: number;
  worktree_path: string | null;
  worktree_branch: string | null;
  git_worktree_detected: number | null;
  changes_ready: string | null;
  /**
   * ISO timestamp of the first worktree mutation detected during this session
   * (mutating tool_use + `git status --porcelain`). NULL / absent = no tracked edits yet.
   */
  code_changed_at?: string | null;
  stale_pr_notified_at: string | null;
  pending_skill_context?: string | null;
  ask_mode: number;
  react_loop_enabled?: number;
  /**
   * Number of hybrid wiki RAG retrieval calls consumed in this session.
   * Used as a hard budget counter to cap embedding/query cost per session.
   */
  wiki_hybrid_rag_consumed?: number | null;
  /**
   * `0` = legacy rows where `wiki_hybrid_rag_consumed` was a 0/1 gate (≥1 meant exhausted).
   * `1` = monotonic call counter semantics (paired with `wiki_hybrid_rag_consumed` 0…max).
   */
  wiki_hybrid_rag_budget_version?: number | null;
  /** Host ReAct `web` tool: number of Serper calls consumed this session. */
  web_search_calls_used?: number | null;
  cron_id: number | null;
  created_at: string;
  updated_at: string;
  /** Soft-delete timestamp. NULL = active; non-NULL = archived (hidden from live list, recoverable for 24 hours). */
  deleted_at: string | null;
  /**
   * Optional legacy SQLite column on upgraded databases from the removed persisted task-plan
   * feature. Fresh installs no longer create it; reads/writes are gone from the server.
   */
  task_state_json?: string | null;
  /** Outer PAV phase slug (`planning` | `acting` | `verifying` | `done` | `escalated`) or NULL = legacy/unset. */
  orchestration_phase?: string | null;
  /** JSON object — host/operator metadata for outer orchestration (see `server/orchestration.ts`). */
  orchestration_meta?: string | null;
  /**
   * Logical reference to a row in the shared `orgs.db` users table.
   * NULL only for legacy rows pre-Phase-4 and for fresh installs that
   * haven't completed auth setup yet. Strict ownership is enforced at
   * the API + WebSocket layer via `session-ownership.ts` — list/read
   * routes hide rows the caller doesn't own.
   */
  owner_user_id?: string | null;
  /** Max advisor turns per user message round in multi-agent sessions (0 = unlimited). */
  max_turns?: number;
  /**
   * Optional Design Studio design id linked to this session. When set, the
   * client renders that design's live canvas in a preview pane beside the
   * chat (see `PUT /api/sessions/:id/linked-design`). NULL = none. Not a FK:
   * designs are org-scoped and independently deletable, so a stale id is
   * tolerated and ignored at render time.
   */
  linked_design_id?: string | null;
  /**
   * When `1`, session end may commit/push/open a PR without the operator
   * clicking Create ticket & PR (board assign + autonomous dispatch).
   */
  auto_ship_on_complete?: number;
  /**
   * Per-session Finalize automation: `manual` | `review` | `push` | `merge`.
   * Assigned/autonomous sessions default to `merge`.
   */
  finalize_automation?: string | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  engine: string | null;
  model: string | null;
  attachments: string | null;
  metadata: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  agent_color?: string | null;
  created_at: string;
}

export interface SessionAgentRow {
  session_id: string;
  agent_id: string;
  position: number;
  added_at: string;
}

export interface HeartbeatLogRow {
  id: number;
  agent_id: string;
  timestamp: string;
  prompt: string;
  result: string | null;
  status: 'pending' | 'running' | 'success' | 'error';
}

export interface CronRow {
  id: number;
  name: string;
  schedule: string;
  prompt: string;
  cwd: string;
  enabled: number;
  last_run: string | null;
  last_result: string | null;
  next_run_at: string | null;
  project_id: string | null;
  /**
   * Per-cron execution timeout in milliseconds. When null, falls back to
   * `config.defaultTimeoutMs`. Exposed so long-running crons can opt out of
   * the shared default without dragging every cron along with them.
   */
  timeout_ms: number | null;
  /**
   * Per-cron opt-in for "ran successfully" push notifications. Defaults to
   * 0 (off) so a noisy cron doesn't spam every device on every tick — users
   * explicitly enable on the crons they actually want pinged about.
   * 1 = send a push to every device that has the `cron` event enabled,
   * 0 = silent (thread/heartbeat logs are still written either way).
   */
  notify_on_run: number;
  /**
   * Model identifier used when the cron fires (e.g. `claude-opus-4-8`,
   * `claude-sonnet-4-6`). When null, falls back to
   * `defaultModelForEngine('claude-code')` at run time. Stored as a free-form
   * TEXT column so the allowlist can change without breaking existing rows;
   * the API validates against `config.engineValidModels['claude-code']` on
   * write.
   */
  model: string | null;
  /**
   * When set, identifies the project agent whose enabled skills and per-skill
   * overrides determine spawn credential injection for this cron. Null → use
   * `project.cronSkillPrincipalAgentId` if valid, otherwise the sole agent when
   * the project has exactly one agent (`server/cron-skill-principal.ts`).
   */
  skill_principal_agent_id: string | null;
  /**
   * Engine identifier the cron prefers when running (`claude-code`,
   * `cursor-agent`, `gemini-cli`, `codex-cli`). When null, `runCronJob`
   * inherits the resolved skill-principal agent's `engine`, falling back to
   * `claude-code` when no principal can be resolved. Stored as free-form
   * TEXT so the supported-engine list can grow; the API validates writes
   * against `ALL_SUPPORTED_ENGINES`. The `model` allowlist used for
   * validation is keyed off this column (or the inherited fallback when
   * unset), so a cron pointed at `cursor-agent` accepts Composer ids and
   * rejects Claude ids.
   */
  engine: string | null;
  created_at: string;
}

export interface CronLogRow {
  id: number;
  cron_id: number;
  timestamp: string;
  status: 'pending' | 'running' | 'success' | 'error';
  result: string | null;
  duration_ms: number | null;
}

export interface SessionAgentDetail {
  id: string;
  name: string;
  color: string;
  position: number;
  role: 'executor' | 'advisor';
  projectId?: string;
  projectName?: string;
}

export interface DesignRow {
  id: string;
  name: string;
  org_id: string;
  /** CLI engine for Design Studio; null → `claude-code`. */
  agent_engine: string | null;
  /** Model id for the chosen engine; null → hub default for that engine. */
  agent_model: string | null;
  /** Engine-native session id for resume (Claude/Cursor/Codex); null until first successful turn. */
  engine_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesignProjectRow {
  design_id: string;
  project_id: string;
}

export interface DesignMessageRow {
  id: string;
  design_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

export interface ActiveTaskRow {
  session_id: string;
  message_id: string;
  agent_id: string;
  pid: number | null;
  prompt: string;
  streamed_output: string;
  engine: string;
  model: string | null;
  status: 'running' | 'done' | 'error' | 'cancelled';
  started_at: string;
  updated_at: string;
}

export interface SlackMessageRow {
  id: number;
  agent_id: string;
  channel_id: string;
  thread_ts: string | null;
  user_id: string;
  user_message: string;
  bot_response: string | null;
  timestamp: string;
}

export interface SlackBotRow {
  id: string;
  name: string;
  bot_token: string;
  app_token: string;
  agent_id: string;
  channel_map: string; // JSON: { [channelId]: { label: string; agentId?: string } }
  enabled: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface DelegationRow {
  id: string;
  session_id: string;
  parent_message_id: string;
  agent_id: string;
  agent_name: string | null;
  task: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  output: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface HandoffRow {
  id: string;
  from_session_id: string;
  to_session_id: string | null;
  from_agent_id: string;
  to_agent_id: string;
  project_id: string;
  note: string;
  status: 'pending' | 'delivered' | 'failed';
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface SkillInvocationRow {
  id: string;
  session_id: string;
  skill_id: string;
  source: 'project' | 'default' | null;
  reason: string | null;
  status: 'loaded' | 'not-found' | 'malformed';
  injected_bytes: number | null;
  created_at: string;
}

export interface BackgroundTaskRow {
  id: string;
  session_id: string;
  agent_id: string;
  prompt: string;
  status: 'running' | 'done' | 'error';
  created_at: string;
  completed_at: string | null;
}

export interface MessageQueueRow {
  id: string;
  session_id: string;
  agent_id: string;
  content: string;
  attachments: string | null;
  position: number;
  created_at: string;
}

export interface CheckpointRow {
  id: number;
  session_id: string;
  message_id: string | null;
  uuid: string;
  turn_index: number | null;
  label: string | null;
  created_at: string;
}

export interface DeviceTokenRow {
  id: number;
  token: string;
  platform: string;
  user_id?: string | null;
  created_at: string;
  last_used: string | null;
  enabled_events: string | null;
}

export interface SessionEventRow {
  id: number;
  parent_kind: 'message' | 'heartbeat' | 'cron';
  parent_id: string;
  seq: number;
  event_type: string;
  payload: string;
  timestamp: string;
}

/**
 * Per-session progress step row. Populated whenever a running agent emits a
 * `[[STEP:...]]` marker; backs the in-Hub ProgressPanel so reopening a session
 * rehydrates the live checklist.
 */
export interface SessionProgressRow {
  id: number;
  session_id: string;
  message_id: string | null;
  step: string;
  status: 'started' | 'completed' | 'failed';
  /** Epoch ms when the step started. */
  started_at: number;
  /** Epoch ms when the step finished (completed or failed). Null while in-flight. */
  finished_at: number | null;
  created_at: string;
}

export interface HeartbeatStateRow {
  agent_id: string;
  next_run_at: string | null;
  last_run_at: string | null;
}

export interface KanbanBoardRow {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
}

export interface KanbanColumnRow {
  id: string;
  board_id: string;
  name: string;
  position: number;
  color: string | null;
  created_at: string;
}

export interface KanbanCardRow {
  id: string;
  column_id: string;
  board_id: string;
  title: string;
  description: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee: string | null;
  labels: string | null;
  session_id: string | null;
  github_issue_url: string | null;
  pr_url: string | null;
  review_status: 'awaiting_review' | 'reviewing' | 'approved' | 'changes_requested' | null;
  created_by: string | null;
  position: number;
  epic_id: string | null;
  documented: number;
  /** Set when autonomous dispatch claims a card — controls auto-PR at session end vs Create PR banner. */
  dispatched_by_autonomous: number;
  /** Optional model id chosen at assign time; null/absent means use agent + engine defaults. */
  assign_model?: string | null;
  /** Optional engine override chosen at assign time. When set, the spawn engine
   *  is forced to this id regardless of the assignee agent's shared engine.
   *  Validated against `cfg.engineValidModels` keys at the route layer; the
   *  effective-model resolver treats it as `explicitEngine`. */
  assign_engine?: string | null;
  /** @deprecated Triage gating is gone — autonomous dispatch now routes
   *  by labels with a lead fallback. The column remains for backward-compat
   *  with existing rows but is no longer written by the dispatch path. */
  triaged_at?: number | null;
  /** @deprecated See `triaged_at`. Retained for migration safety. */
  triaged_by?: string | null;
  /** @deprecated Replaced by label-based routing in `server/routing.ts`.
   *  Existing values are preserved but no longer consulted by dispatch. */
  suggested_assignee?: string | null;
  /** Optional override for the PR base branch at auto-PR creation time.
   *  NULL/absent = use repo default (current behaviour). When set, the
   *  auto-PR flow opens the PR with `--base <pr_base_branch>`. If the chosen
   *  branch no longer exists at PR-open time, the server falls back to the
   *  default and posts an explanatory comment on the card. */
  pr_base_branch?: string | null;
  /** Persistent dedup key for review-feedback dispatch. Stores the highest
   *  GitHub review id already dispatched to the linked session so the
   *  `pull_request_review.submitted` webhook doesn't re-send stale feedback
   *  after a server restart. NULL = never dispatched. */
  last_dispatched_review_id?: number | null;
  /** Legacy dedup column for the removed review/CI poller's CI-failure probe.
   *  No longer written (reviews/CI are webhook-only); retained for migration
   *  stability. */
  last_dispatched_check_run_id?: number | null;
  /** Legacy dedup column for the removed review/CI poller's inline review-comment
   *  probe. No longer written; retained for migration stability. */
  last_dispatched_review_comment_id?: number | null;
  /** Total number of autofix feedback dispatches sent to this card's session
   *  across all kinds (review, ci, inline-comments, conflict). Drives the
   *  "Autofix round N" banner injected into each dispatched message and the
   *  structured `[Autofix] event=dispatch round=N` log lines. Always 0 for
   *  brand-new rows; incremented atomically via `bumpCardAutofixDispatchCount`.
   *  Optional in the type so legacy test fixtures (built before the column
   *  existed) still satisfy the row shape — the DB column itself is NOT NULL
   *  with DEFAULT 0 and always reads back a number. */
  autofix_dispatch_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ReviewLogRow {
  id: string;
  project_id: string;
  card_id: string | null;
  pr_url: string;
  reviewer_agent: string;
  author_agent: string | null;
  session_id: string | null;
  outcome: 'approved' | 'changes_requested' | 'merge_conflict' | 'ambiguous' | 'timeout';
  review_body: string | null;
  started_at: string;
  completed_at: string;
}

export type PrStateStatus = 'queued' | 'in_progress' | 'completed';
export type PrStateConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'skipped';

export interface PrStateRow {
  id: string;
  project_id: string;
  repo_full_name: string;
  pr_number: number;
  head_sha: string | null;
  check_run_id: number | null;
  status: PrStateStatus;
  conclusion: PrStateConclusion | null;
  phase: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KanbanCardCommentRow {
  id: string;
  card_id: string;
  author: string;
  content: string;
  created_at: string;
}

export interface KanbanCardBlockerRow {
  id: string;
  card_id: string;
  blocked_by_card_id: string;
  created_at: string;
}

/**
 * A derived view of a blocker relationship used in API responses and the
 * autonomous dispatcher. `done` is computed from the referenced card's
 * column name (see `isColumnDone` in server/kanban-blockers.ts) so the
 * client can tell at a glance whether a blocker is still unresolved.
 */
export interface KanbanBlockerLink {
  id: string;
  title: string;
  column_id: string;
  done: boolean;
}

export interface KanbanEpicRow {
  id: string;
  board_id: string;
  name: string;
  description: string | null;
  color: string;
  autonomous: number;
  autonomous_interval: number;
  autonomous_max_concurrent: number;
  /** When set and valid for the assignee agent's engine, autonomous dispatch uses this instead of the agent's configured model. */
  autonomous_model: string | null;
  /** JSON object: optional overrides merged on top of the project's `orchestrationBudgets`. */
  orchestration_budgets_json?: string | null;
  /**
   * Default PR base / integration branch for cards in this epic. Cards may
   * override with their own `pr_base_branch`. Null = repo default.
   */
  pr_base_branch?: string | null;
  /**
   * User id of whoever most recently flipped `autonomous = 1` on this
   * epic. Used by `resolveAutonomousOwnerUserId` as the third step in the
   * autonomous-dispatch owner-resolution chain (card.created_by →
   * card.session_id owner → epic.autonomous_enabled_by → org owner).
   * Null on legacy rows / epics that have never had autonomous enabled.
   */
  autonomous_enabled_by?: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookConfigRow {
  id: number;
  project_id: string;
  repo_url: string;
  secret: string;
  events: string;
  enabled: number;
  // JSON array of GitHub logins. Empty array = review-all (backwards compatible).
  // When non-empty, only PRs whose pull_request.user.login matches (case-insensitive)
  // trigger the reviewer dispatch. See shouldReviewPrAuthor() in routes/webhooks.ts.
  author_allowlist: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookLogRow {
  id: number;
  webhook_config_id: number;
  event_type: string;
  action: string | null;
  delivery_id: string | null;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  result: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface WebhookEventRow {
  id: number;
  webhook_config_id: number;
  delivery_id: string | null;
  event_type: string;
  action: string | null;
  payload: string; // JSON-stringified GitHubWebhookPayload
  signature: string | null;
  status: 'pending' | 'processing' | 'done' | 'error' | 'skipped';
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  // Coalescing key for events scoped to a PR — `<repo_full_name>:<pr_number>`
  // for events that target a specific PR, NULL otherwise. Two webhook_events
  // rows with the same `pr_key` are never processed concurrently (per-PR
  // serialization) and within a (event_type, action, pr_key) cohort, older
  // pending rows are coalesced into 'skipped' when a newer row arrives.
  pr_key: string | null;
  // Persistent debounce: when set, the worker will not claim this row until
  // `deferred_until <= datetime('now')`. Replaces the in-memory
  // reviewerDebounceTimers map so debounce state survives restart.
  deferred_until: string | null;
  // For coalesced rows (status='skipped'), the id of the newer row that
  // superseded this one. Lets the queue audit trail record the chain.
  superseded_by: number | null;
}

export interface SkillRegistryRow {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string | null;
  source_url: string | null;
  repo_url: string | null;
  version: string | null;
  install_count: number;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface AgentSkillOverrideRow {
  agent_id: string;
  skill_id: string;
  enabled: number;
}

export interface WikiPageRow {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  content: string;
  category: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ThreadRow {
  id: string;
  project_id: string;
  name: string;
  type: 'cron' | 'heartbeat';
  source_id: string | null;
  created_at: string;
}

/**
 * Author role on a thread entry. `system` is the historical default —
 * heartbeat / cron daemons write directly via `stmts.createThreadEntry`
 * and leave the role at its column default. `user` is a human posting
 * through the chatroom composer (POST /api/threads/:threadId/entries).
 * `assistant` is reserved for a future "agent replies in-thread" path
 * — no caller writes it today.
 */
export type ThreadEntryRole = 'system' | 'user' | 'assistant';

export interface ThreadEntryRow {
  id: string;
  thread_id: string;
  content: string;
  timestamp: string;
  /** User id of the human who posted this entry, or null for daemon-written rows. */
  author_user_id: string | null;
  /** Agent id when an agent posts (future). Null for human / daemon rows today. */
  author_agent_id: string | null;
  /** Author kind — see {@link ThreadEntryRole}. */
  role: ThreadEntryRole;
}

export interface NoteProcessingRow {
  id: string;
  project_id: string;
  note_date: string;
  note_excerpt: string;
  target: 'auto' | 'wiki' | 'memory' | 'plan';
  status: 'pending' | 'running' | 'success' | 'error';
  result: string | null;
  session_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface EscalationRow {
  id: string;
  project_id: string;
  type: 'merge_conflict' | 'ci_failure' | 'review_needed' | 'blocker';
  title: string;
  description: string;
  pr_number: number | null;
  pr_url: string | null;
  card_id: string | null;
  source: string | null;
  acknowledged: number;
  created_at: string;
}

export interface NoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

// ─── iOS Build Types ────────────────────────────────────────────

export type IosBuildStatus =
  | 'queued'
  | 'provisioning'
  | 'building'
  | 'archiving'
  | 'uploading'
  | 'ready'
  | 'error'
  | 'cancelled';

export interface IosBuildRow {
  id: string;
  project_id: string;
  pr_number: number;
  pr_url: string | null;
  branch: string;
  commit_sha: string | null;
  repo_url: string;
  status: IosBuildStatus;
  error_message: string | null;
  build_log: string | null;
  /** EC2 Mac instance ID (e.g. i-0abc123) */
  vm_instance_id: string | null;
  /** URL to the .ipa artifact once built */
  ipa_url: string | null;
  /** TestFlight / internal install link */
  install_url: string | null;
  /** URL to simulator recording (MP4) */
  simulator_recording_url: string | null;
  /** QR code data URL for install link */
  qr_code_url: string | null;
  /** Build duration in seconds */
  duration_seconds: number | null;
  /** Xcode version used */
  xcode_version: string | null;
  /** iOS SDK version */
  ios_sdk_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface IosBuildArtifactRow {
  id: string;
  build_id: string;
  type: 'ipa' | 'simulator_recording' | 'screenshot' | 'log';
  name: string;
  label: string;
  filename: string;
  file_path: string;
  file_size: number;
  created_at: string;
}

/**
 * Finalize Code Changes run row — pre-PR validation pipeline.
 * One row per (project, branch, head_sha) tuple via `idempotency_key`.
 *
 * Lifecycle (`status`):
 *   queued → rebasing → reviewing → running →
 *     (dispatching → rebasing → reviewing → running)* →
 *     pushing → pushed | failed | timed_out | infra_error | cancelled
 *
 * See wiki: `finalize-code-changes-architecture-v0` (§4).
 */
export interface FinalizeRunRow {
  id: string;
  card_id: string;
  /** Null until the orchestrator resolves or spawns the agent session. */
  session_id: string | null;
  project_id: string;
  branch: string;
  head_sha: string;
  /** sha256(project_id|branch|head_sha) — UNIQUE. */
  idempotency_key: string;
  status: FinalizeRunStatus;
  phase: FinalizeRunPhase | null;
  trigger_source: 'ui_button' | 'agent_block';
  worktree_path: string | null;
  triggered_by_user_id: string;
  /** Snapshot of the triggering user's git identity at start time. */
  author_name: string;
  author_email: string;
  reviewer_verdict: 'approved' | 'changes_requested' | null;
  /** Machine code on terminal failures; see wiki §10 for the table. */
  failure_reason: string | null;
  failed_step_index: number | null;
  failed_step_name: string | null;
  failed_step_exit_code: number | null;
  /** Non-null iff this row is the one infra-failure retry of an earlier run. */
  retry_of_run_id: string | null;
  active_seconds_consumed: number;
  /** Unix millis (DB clock via `unixepoch() * 1000`). */
  started_at: number;
  ended_at: number | null;
  pr_url: string | null;
  /**
   * Worktree HEAD that passed review + CI when the run reached `ready_to_push`.
   * Differs from {@link head_sha} when fix dispatches landed commits during the
   * run — push gate compares against this, not the trigger-time idempotency sha.
   */
  validated_head_sha: string | null;
  /** 1-indexed fix-loop iteration; incremented at each rebase pass. */
  loop_round: number;
  /**
   * Which phases the run executes (see {@link FinalizeRunMode}). `'full'`
   * is the historical behavior (rebase + review + checks). The split
   * manual buttons trigger `'checks'` (rebase + CI) or `'review'`
   * (rebase + reviewer); automation always runs `'full'`.
   */
  mode: FinalizeRunMode;
}

/**
 * Which phases a finalize run executes.
 *
 *   full   — rebase + reviewer + checks (default; automation + push/merge)
 *   checks — rebase + CI checks only ("Run Tests" button)
 *   review — rebase + AI reviewer only ("Reviewer" button)
 */
export type FinalizeRunMode = 'full' | 'checks' | 'review';

/** Lifecycle status codes — see {@link FinalizeRunRow}. */
export type FinalizeRunStatus =
  | 'queued'
  | 'rebasing'
  | 'reviewing'
  | 'running'
  | 'dispatching'
  | 'pushing'
  | 'ready_to_push'
  | 'pushed'
  | 'failed'
  | 'timed_out'
  | 'infra_error'
  | 'cancelled'
  /**
   * Terminal status set by the stall watchdog (see
   * `server/finalize/stall-watchdog.ts` + wiki §7 "Human-walked-away
   * behavior"). A live-mode fix dispatch landed in the originating
   * session, the configured notify window elapsed with no turn-end (we
   * pushed a "still waiting" notification), and the longer stall window
   * elapsed with still no turn-end. The run is parked: the dispatched
   * message stays in the session log so the human can pick up where they
   * left off, and the card surfaces a "retrigger" affordance.
   *
   * **Autonomous runs never reach this state.** If an autonomous loop's
   * fix dispatch is not picked up, that is a bug in the autonomous
   * dispatcher; the stall path is live-only and gated by
   * `trigger_source === 'ui_button'`.
   */
  | 'stalled_no_response';

/** Phase codes — UI surfaces these; some collapse onto the same status. */
export type FinalizeRunPhase = 'rebase' | 'review' | 'tasks' | 'dispatching' | 'push';

/** Per-step CI task state persisted for the checks panel. */
export type FinalizeRunStepState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

export interface FinalizeRunStepRow {
  run_id: string;
  step_index: number;
  name: string;
  state: FinalizeRunStepState;
  exit_code: number | null;
  started_at: number | null;
  ended_at: number | null;
  job_id: string | null;
  matrix_key: string | null;
}

/** v2 job/matrix shard state for parallel container jobs. */
export type FinalizeRunJobState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

export interface FinalizeRunJobRow {
  run_id: string;
  job_id: string;
  matrix_key: string;
  state: FinalizeRunJobState;
  exit_code: number | null;
  started_at: number | null;
  ended_at: number | null;
}

/**
 * Reviewer-thread row. One row per diff-anchored finding produced by the
 * reviewer agent during the review phase of a Finalize run.
 *
 * Read-only at v0: the UI renders these as a side panel; the only writes
 * happen inside the reviewer-dispatch helper, which inserts every finding
 * inside the same transaction that records the run's verdict.
 *
 * See wiki: `finalize-code-changes-architecture-v0` (§8).
 */
export interface ReviewerThreadRow {
  id: string;
  run_id: string;
  file_path: string;
  /** 1-indexed start line in the **head** revision of `file_path`. */
  line_start: number | null;
  /** 1-indexed end line in the **head** revision; equal to `line_start` for single-line notes. */
  line_end: number | null;
  body: string;
  /** `'reviewer-agent'` is the only value at v0; future authors may extend. */
  author: string;
  /** Unix millis. */
  created_at: number;
}

/**
 * One row in `finalize_metrics`. The metric vocabulary is enumerated in
 * `server/finalize/metrics.ts` (`MetricName`), not on a CHECK constraint
 * so a new metric can be added without a schema rebuild. `labels` is a
 * JSON object string; readers project values via `json_extract(...)`.
 *
 * See wiki: `finalize-code-changes-architecture-v0` §14 (Metrics &
 * Observability).
 */
export interface FinalizeMetricRow {
  id: number;
  project_id: string;
  metric_name: string;
  /** JSON object string. Empty `{}` for label-free counters. */
  labels: string;
  /** Counter increment (typically `1`) or a histogram sample value. */
  value: number;
  /** Back-link to the originating `finalize_runs.id`, when known. */
  run_id: string | null;
  /** Unix millis (server clock). */
  observed_at: number;
}

// ─── Prepared Statements ─────────────────────────────────────────

type Stmt<TParams extends unknown[] = unknown[], TRow = unknown> = Database.Statement<
  TParams,
  TRow
>;

/**
 * SQLite prepared statements.
 *
 * Most fields use the default {@link Stmt} (`unknown[]` / `unknown`) from the initial migration, so
 * `.get()` / `.all()` stay loose and callers often cast rows. A follow-up is to narrow hot statements
 * to e.g. `Stmt<[string], SessionRow>` once bind sites (including Express `req.params`) are consistently typed.
 */
export interface Stmts {
  // Sessions
  createSession: Stmt;
  getSessions: Stmt;
  getSession: Stmt;
  getRecentLiveSessions: Stmt;
  updateSessionName: Stmt;
  updateSessionMaxTurns: Stmt;
  updateSessionLinkedDesign: Stmt;
  deleteSession: Stmt;
  softDeleteSession: Stmt;
  restoreArchivedSession: Stmt;
  getAllSessionsByAgent: Stmt;
  getArchivedSessionsByAgent: Stmt;
  getExpiredArchivedSessions: Stmt;
  getRecoverableSessionByIdPrefix: Stmt;
  touchSession: Stmt;
  updateSessionEngine: Stmt;
  updateSessionModel: Stmt;
  updateSessionEngineSessionId: Stmt;
  updateSessionPendingSkillContext: Stmt;
  updateSessionAutoShipOnComplete: Stmt;
  updateSessionFinalizeAutomation: Stmt;
  updateSessionWorktree: Stmt;
  updateSessionWorktreePath: Stmt;
  updateSessionGitWorktreeDetected: Stmt;
  updateSessionAskMode: Stmt;
  updateSessionReactLoop: Stmt;
  updateSessionChangesReady: Stmt;
  updateSessionCodeChangedAt: Stmt;
  updateSessionWikiHybridRagConsumed: Stmt;
  updateSessionWikiHybridRagBudget: Stmt;
  updateSessionWebSearchCallsUsed: Stmt;
  updateSessionTaskState: Stmt;
  updateSessionOrchestration: Stmt;
  clearSessionChangesReady: Stmt;
  getStalePendingPrSessions: Stmt;
  markStalePrNotified: Stmt;

  // Background tasks
  insertBackgroundTask: Stmt;
  updateBackgroundTaskStatus: Stmt;
  getBackgroundTask: Stmt;
  getBackgroundTaskBySession: Stmt;
  getBackgroundTasks: Stmt;
  getRunningBackgroundTasks: Stmt;

  // Active tasks
  getActiveTask: Stmt;
  getAllActiveTasks: Stmt;
  insertActiveTask: Stmt;
  updateActiveTaskPid: Stmt;
  appendActiveTaskOutput: Stmt;
  deleteActiveTask: Stmt;
  deleteAllActiveTasks: Stmt;

  // Messages
  addMessage: Stmt;
  getMessages: Stmt;
  getMessageById: Stmt;
  getLastMessage: Stmt;
  getLastAssistantMessage: Stmt;

  // Heartbeat logs
  addHeartbeatLog: Stmt;
  updateHeartbeatLog: Stmt;
  getHeartbeatLogs: Stmt;
  getLatestHeartbeat: Stmt;

  // Crons
  getCrons: Stmt;
  getCron: Stmt;
  createCron: Stmt;
  updateCron: Stmt;
  deleteCron: Stmt;
  updateCronResult: Stmt;
  updateCronNextRun: Stmt;

  // Cron logs
  addCronLog: Stmt;
  updateCronLog: Stmt;
  getCronLogs: Stmt;
  pruneCronLogs: Stmt;

  // Session events
  addSessionEvent: Stmt;
  getSessionEvents: Stmt;
  getSessionEventsForSession: Stmt;
  countSessionEventsForSession: Stmt;
  deleteSessionEvents: Stmt;
  countSessionEvents: Stmt;

  // Session progress steps (in-Hub ProgressPanel rehydration)
  addSessionProgress: Stmt;
  completeSessionProgress: Stmt;
  getSessionProgress: Stmt;
  deleteSessionProgress: Stmt;

  // Checkpoints
  addCheckpoint: Stmt;
  getCheckpoints: Stmt;
  getCheckpointByUuid: Stmt;
  updateCheckpointLabel: Stmt;

  // Heartbeat state
  upsertHeartbeatState: Stmt;
  getHeartbeatState: Stmt;
  deleteHeartbeatState: Stmt;

  // Session advisors (multi-agent)
  getSessionAgents: Stmt;
  addSessionAgent: Stmt;
  removeSessionAgent: Stmt;

  // Designs
  listDesigns: Stmt;
  getDesign: Stmt;
  createDesign: Stmt;
  updateDesignName: Stmt;
  updateDesignAgentModel: Stmt;
  updateDesignEngineSessionId: Stmt;
  updateDesignChatEngineModelSession: Stmt;
  touchDesign: Stmt;
  deleteDesign: Stmt;
  listDesignProjects: Stmt;
  linkDesignProject: Stmt;
  unlinkDesignProject: Stmt;
  clearDesignProjects: Stmt;
  listDesignMessages: Stmt;
  appendDesignMessage: Stmt;

  // Slack messages
  addSlackMessage: Stmt;
  getSlackMessages: Stmt;
  getAllSlackMessages: Stmt;

  // Slack bot configs (DB-backed)
  listSlackBots: Stmt;
  getSlackBot: Stmt;
  insertSlackBot: Stmt;
  updateSlackBot: Stmt;
  deleteSlackBot: Stmt;
  deleteSlackBotsByAgent: Stmt;

  // Delegations
  createDelegation: Stmt;
  updateDelegation: Stmt;
  getDelegations: Stmt;
  getDelegationsBySession: Stmt;

  // Handoffs
  createHandoff: Stmt;
  setHandoffToSession: Stmt;
  markHandoffDelivered: Stmt;
  markHandoffFailed: Stmt;
  getHandoffById: Stmt;
  getHandoffByToSession: Stmt;
  getHandoffsFromSession: Stmt;
  insertSkillInvocation: Stmt;
  listSkillInvocationsForSession: Stmt;

  // Message queue
  enqueueMessage: Stmt;
  getQueuedMessages: Stmt;
  getNextQueuedMessage: Stmt;
  dequeueMessage: Stmt;
  clearSessionQueue: Stmt;
  getMaxQueuePosition: Stmt;
  getMinQueuePosition: Stmt;
  updateQueueMessage: Stmt;
  updateMessageContent: Stmt;
  getAllQueuedSessions: Stmt;

  // Cron sessions
  getSessionByCronId: Stmt;
  getAllCronSessions: Stmt;
  updateSessionCronId: Stmt;

  // Thread lookup
  getThreadBySource: Stmt;

  // Device tokens
  registerDeviceToken: Stmt;
  removeDeviceToken: Stmt;
  getAllDeviceTokens: Stmt;
  updateDeviceTokenLastUsed: Stmt;
  getDeviceToken: Stmt;
  setDeviceTokenPreferences: Stmt;

  // Kanban boards
  getKanbanBoard: Stmt;
  getKanbanBoardById: Stmt;
  createKanbanBoard: Stmt;
  deleteKanbanBoard: Stmt;

  // Kanban columns
  getKanbanColumn: Stmt;
  getKanbanColumns: Stmt;
  createKanbanColumn: Stmt;
  updateKanbanColumn: Stmt;
  deleteKanbanColumn: Stmt;

  // Kanban cards
  getKanbanCards: Stmt;
  getKanbanCardsByColumn: Stmt;
  getKanbanCard: Stmt;
  createKanbanCard: Stmt;
  updateKanbanCard: Stmt;
  moveKanbanCard: Stmt;
  setCardPrUrl: Stmt;
  setCardLastDispatchedReviewId: Stmt;
  setCardLastDispatchedCheckRunId: Stmt;
  setCardLastDispatchedReviewCommentId: Stmt;
  bumpCardAutofixDispatchCount: Stmt;
  getCardAutofixDispatchCount: Stmt;
  reassignCardToSession: Stmt;
  getKanbanCardBySession: Stmt;
  getSessionIdsByWorktreeBranch: Stmt;
  getKanbanCardByPrUrl: Stmt;
  /**
   * Cards in the `Review` column with a non-null `pr_url` whose last update
   * was more than 15 minutes ago — feeds the `pr-rebase-poll` sweep. Returns
   * `card_id`, `card_title`, `project_id`, `pr_url`, `card_updated_at`,
   * `session_agent_id` (null if the card's session row was deleted).
   */
  getStalePrCardsForRebaseCheck: Stmt;
  getNextUndocumentedCard: Stmt;
  markCardDocumented: Stmt;
  deleteKanbanCard: Stmt;

  // Kanban card comments
  getKanbanCardComments: Stmt;
  createKanbanCardComment: Stmt;
  deleteKanbanCardComment: Stmt;

  // Card blockers (card-to-card dependencies)
  getBlockersForBoard: Stmt;
  getBlockersForCard: Stmt;
  getBlocker: Stmt;
  createBlocker: Stmt;
  deleteBlocker: Stmt;

  // Kanban epics
  getKanbanEpics: Stmt;
  getKanbanEpic: Stmt;
  createKanbanEpic: Stmt;
  updateKanbanEpic: Stmt;
  setEpicAutonomousEnabledBy: Stmt;
  deleteKanbanEpic: Stmt;
  getKanbanCardsByEpic: Stmt;
  updateKanbanCardEpic: Stmt;
  getAutonomousEpic: Stmt;
  getEligibleAutonomousCards: Stmt;
  markCardDispatchedByAutonomous: Stmt;

  // Webhook configs
  getWebhookConfigs: Stmt;
  getWebhookConfigsByProject: Stmt;
  getWebhookConfig: Stmt;
  createWebhookConfig: Stmt;
  updateWebhookConfig: Stmt;
  deleteWebhookConfig: Stmt;
  getWebhookConfigByProjectAndRepo: Stmt;
  addWebhookLog: Stmt;
  updateWebhookLog: Stmt;
  getWebhookLogs: Stmt;
  getRecentWebhookLogs: Stmt;

  // Webhook events queue (fast-ack + background worker)
  insertWebhookEvent: Stmt;
  getWebhookEventByDelivery: Stmt;
  getWebhookEventById: Stmt;
  claimPendingWebhookEvent: Stmt;
  markWebhookEventDone: Stmt;
  markWebhookEventError: Stmt;
  resetStaleWebhookEvents: Stmt;
  countWebhookEventsByStatus: Stmt;
  // Coalescing — mark older pending rows that share (event_type, action,
  // pr_key) with a newer row as 'skipped'. Run at insert time so the worker
  // claim path stays a single atomic UPDATE.
  coalescePendingForKey: Stmt;
  // Per-key concurrency / persistent-debounce introspection.
  countPendingForPrKey: Stmt;
  hasDeferredPendingForPrKey: Stmt;
  // Evaluate `datetime('now', ?)` for a SQLite modifier string. Used to
  // compute `deferred_until` at enqueue time on the DB clock.
  evalDatetimeOffset: Stmt;

  // Wiki pages
  getWikiPages: Stmt;
  getWikiPage: Stmt;
  getWikiPageById: Stmt;
  createWikiPage: Stmt;
  updateWikiPage: Stmt;
  deleteWikiPage: Stmt;
  getWikiPagesByCategory: Stmt;

  // Wiki embeddings
  getWikiEmbeddingsByProject: Stmt;
  getWikiEmbeddingsByPage: Stmt;
  deleteWikiEmbeddingsByPage: Stmt;
  upsertWikiEmbedding: Stmt;
  countWikiEmbeddingsByPage: Stmt;

  // Threads
  getThreadsByProject: Stmt;
  getThreadsByProjectAndType: Stmt;
  getThread: Stmt;
  getThreadBySourceId: Stmt;
  createThread: Stmt;
  deleteThread: Stmt;

  // Thread entries
  getThreadEntries: Stmt;
  getThreadEntry: Stmt;
  createThreadEntry: Stmt;
  /**
   * Insert a human-authored thread entry with `role = 'user'`. Used by
   * `POST /api/threads/:threadId/entries` for the chatroom composer.
   * Args: `(id, thread_id, content, author_user_id | null)`.
   */
  createUserThreadEntry: Stmt;
  deleteThreadEntry: Stmt;
  deleteThreadEntries: Stmt;
  pruneThreadEntries: Stmt;

  // Skill registry
  getSkillRegistry: Stmt;
  getSkillRegistryByCategory: Stmt;
  getSkillRegistryItem: Stmt;
  searchSkillRegistry: Stmt;
  createSkillRegistryItem: Stmt;
  deleteSkillRegistryItem: Stmt;
  incrementSkillInstallCount: Stmt;
  getSkillRegistryCount: Stmt;

  // Agent skill overrides
  getAgentSkillOverrides: Stmt;
  upsertAgentSkillOverride: Stmt;
  deleteAgentSkillOverride: Stmt;

  // Escalations
  getEscalationsByProject: Stmt;
  getActiveEscalationsByProject: Stmt;
  getAllActiveEscalations: Stmt;
  getEscalation: Stmt;
  createEscalation: Stmt;
  acknowledgeEscalation: Stmt;
  deleteEscalation: Stmt;
  deleteEscalationsByProject: Stmt;

  // Bulk project cleanup
  deleteNotesByProject: Stmt;
  deleteWikiPagesByProject: Stmt;
  deleteWikiEmbeddingsByProject: Stmt;
  deleteWebhookConfigsByProject: Stmt;
  deleteBoardsByProject: Stmt;
  deleteWorkflowsByProject: Stmt;
  deleteThreadsByProject: Stmt;
  deleteSessionAgentsByAgent: Stmt;
  deleteCronsByProject: Stmt;
  deleteSessionsByAgent: Stmt;
  deleteHeartbeatLogsByAgent: Stmt;
  deleteSlackMessagesByAgent: Stmt;
  deleteActiveTasksByAgent: Stmt;
  deleteAgentSkillOverridesByAgent: Stmt;
  getRecentEscalationByTypeAndPr: Stmt;
  getAnyRecentEscalationByTypeAndPr: Stmt;

  // Review logs
  createReviewLog: Stmt;
  getReviewLogs: Stmt;
  getReviewLogsByCard: Stmt;
  getReviewLogsByPrUrl: Stmt;

  createPrCreationLog: Stmt;
  getPrCreationLogsByProject: Stmt;

  // pr_state — per-PR reviewer/check-run tracking
  upsertPrState: Stmt;
  updatePrStatePhase: Stmt;
  attachCheckRunId: Stmt;
  completePrState: Stmt;
  deletePrStateByRepoPr: Stmt;
  getPrState: Stmt;
  getPrStateByRepoPr: Stmt;
  getPrStateByCheckRunId: Stmt;

  // Card review status
  setCardReviewStatus: Stmt;

  // Note processings
  createNoteProcessing: Stmt;
  updateNoteProcessing: Stmt;
  updateNoteProcessingStatus: Stmt;
  getNoteProcessing: Stmt;
  getNoteProcessingsByProject: Stmt;
  getNoteProcessingsByDate: Stmt;
  getNoteProcessingBySession: Stmt;

  // iOS builds
  getIosBuilds: Stmt;
  getIosBuildsByProject: Stmt;
  getIosBuild: Stmt;
  createIosBuild: Stmt;
  updateIosBuild: Stmt;
  updateIosBuildStatus: Stmt;
  deleteIosBuild: Stmt;
  getRunningIosBuilds: Stmt;
  appendIosBuildLog: Stmt;

  // iOS build artifacts
  getIosBuildArtifacts: Stmt;
  createIosBuildArtifact: Stmt;
  deleteIosBuildArtifacts: Stmt;

  // Notes (from notes tables)
  getNotes: Stmt;
  getNote: Stmt;
  createNote: Stmt;
  updateNote: Stmt;
  deleteNote: Stmt;

  // Workflows (Hub workflow builder — see workflows-schema.ts)
  getWorkflowsByProject: Stmt;
  getWorkflow: Stmt;
  createWorkflow: Stmt;
  updateWorkflow: Stmt;
  updateWorkflowCronNextRun: Stmt;
  updateWorkflowWebhookSecret: Stmt;
  getWorkflowByWebhookToken: Stmt;
  getWorkflowsWithCronExpr: Stmt;
  getWorkflowsByKanbanTriggerColumn: Stmt;
  deleteWorkflow: Stmt;
  getWorkflowSteps: Stmt;
  getWorkflowStepsByProject: Stmt;
  deleteWorkflowStepsByWorkflow: Stmt;
  createWorkflowStep: Stmt;
  createWorkflowRun: Stmt;
  getWorkflowRun: Stmt;
  getWorkflowRunsLimited: Stmt;
  updateWorkflowRunToRunning: Stmt;
  updateWorkflowRunTerminal: Stmt;
  createWorkflowStepRunStart: Stmt;
  updateWorkflowStepRunComplete: Stmt;
  resetWorkflowStepRunForRetry: Stmt;
  failStuckRunningWorkflowRuns: Stmt;
  failStuckRunningWorkflowStepRuns: Stmt;
  failStuckActiveFinalizeRunsOnBoot: Stmt;
  failStuckActiveFinalizeRunStepsOnBoot: Stmt;
  getWorkflowStepRun: Stmt;
  getWorkflowRunScoped: Stmt;
  cancelWorkflowRunIfPending: Stmt;
  getWorkflowStepRunsForRun: Stmt;

  // Provisioning jobs — see server/provisioning/orchestrator.ts.
  createProvisioningJob: Stmt;
  finishProvisioningJob: Stmt;
  getProvisioningJob: Stmt;
  getLatestProvisioningJobForProject: Stmt;

  // Post-scaffold audit (Act IV) — see server/audit/audit-service.ts.
  upsertAuditReport: Stmt;
  getAuditReport: Stmt;
  upsertProjectRoster: Stmt;
  getProjectRoster: Stmt;

  // Finalize Code Changes runs — pre-PR validation pipeline.
  // Phase 1 ships the rebase phase; later phases reuse the same row.
  // See wiki: finalize-code-changes-architecture-v0 (§4).
  getFinalizeRun: Stmt;
  /**
   * Idempotency lookup keyed by `sha256(project_id|branch|head_sha)`. The
   * orchestrator (`server/finalize/orchestrator.ts`) calls this on entry
   * to decide whether a trigger re-enters an in-flight row or opens a
   * fresh one. The UNIQUE constraint on `idempotency_key` enforces the
   * §4 contract at the DB layer; this read is the orchestrator's first
   * check before it spends INSERT bandwidth.
   */
  getFinalizeRunByIdempotencyKey: Stmt;
  /**
   * Insert a new `finalize_runs` row. The orchestrator is the only
   * caller — every other module mutates by id. Mirrors the §4 schema
   * with the orchestrator-supplied columns (id, key, identity, etc.)
   * bound and the timing / verdict columns left at their defaults.
   */
  insertFinalizeRun: Stmt;
  /**
   * Promote a finalize run to its terminal `pushed` state and write
   * `ended_at` in one atomic update. Called by the push step (§9) after
   * the PR URL has been written via {@link updateFinalizeRunPrUrl}.
   */
  markFinalizeRunPushed: Stmt;
  markFinalizeRunReadyToPush: Stmt;
  /**
   * Update the `session_id` on a finalize run. The orchestrator calls
   * this when it resolves or spawns a session for a card that didn't
   * have one at trigger time (§6).
   */
  updateFinalizeRunSessionId: Stmt;
  /**
   * Update the worktree path on a finalize_runs row. Used after the
   * orchestrator resolves or creates the worktree for a freshly
   * spawned session.
   */
  updateFinalizeRunWorktreePath: Stmt;
  updateFinalizeRunLoopRound: Stmt;
  /**
   * Most-recent `finalize_runs` row for a session (ordered by
   * `started_at DESC`). Returns `undefined` when the session has never
   * triggered a Finalize run. Used by the session-scoped reviewer-threads
   * side-panel to resolve a `runId` from a `sessionId` without forcing
   * the client to track run lifecycle events.
   */
  getLatestFinalizeRunForSession: Stmt;
  /**
   * Most-recent `finalize_runs` row for a session that exercised the CI
   * checks phase — `mode IN ('checks', 'full')`. Drives the "Tested"
   * done-state on the split Run Tests button.
   */
  getLatestChecksRunForSession: Stmt;
  /**
   * Most-recent `finalize_runs` row for a session that exercised the
   * reviewer phase — `mode IN ('review', 'full')`. Drives the "Reviewed"
   * done-state on the split Reviewer button.
   */
  getLatestReviewRunForSession: Stmt;
  /**
   * Most-recent **in-flight** `finalize_runs` row for a session — i.e.
   * the row whose `status` is NOT in the terminal set
   * (`pushed`, `failed`, `timed_out`, `infra_error`, `cancelled`,
   * `stalled_no_response`). Returns `undefined` when the session has
   * no active Finalize run.
   *
   * Used by the chat.ts session turn-end hook
   * ({@link billSessionTurnDurationIfTaggedToFinalize}) so a turn that
   * finishes on a session bound to an active Finalize run bills its
   * duration to that run's §13 active-time budget.
   */
  getActiveFinalizeRunForSession: Stmt;
  /**
   * Latest `finalize_runs` row for every session referenced by cards on a
   * given kanban board. Returns 0..N rows (one per distinct
   * `session_id` that has any finalize history). The board route
   * builds a `Map<session_id, FinalizeRunRow>` from this and attaches
   * each row to the matching card, avoiding the per-card REST fan-out
   * the v0 surface had. Bound by `(boardId)`.
   */
  listLatestFinalizeRunsForBoard: Stmt;
  updateFinalizeRunPhase: Stmt;
  updateFinalizeRunActiveSeconds: Stmt;
  failFinalizeRun: Stmt;
  updateFinalizeRunReviewerVerdict: Stmt;
  /**
   * Set `finalize_runs.pr_url` for a run id. Written atomically with
   * the push step (card 5c34b2de) so the webhook-side provenance lookup
   * via {@link getFinalizeRunByPrUrl} can never see an orphan row.
   * See `server/finalize/provenance.ts` (design §11).
   */
  updateFinalizeRunPrUrl: Stmt;
  /**
   * Look up a finalize_runs row by the GitHub PR URL the push step
   * recorded. Used by the webhook handler to classify incoming PR
   * events as internal (registry hit) vs external (registry miss).
   * Returns `undefined` when no orchestrator-pushed PR matches.
   * See `server/finalize/provenance.ts` (design §11).
   */
  getFinalizeRunByPrUrl: Stmt;
  upsertFinalizeRunStep: Stmt;
  listFinalizeRunStepsForRun: Stmt;
  upsertFinalizeRunJob: Stmt;
  listFinalizeRunJobsForRun: Stmt;

  // reviewer_threads — diff-anchored notes from the reviewer agent.
  // See wiki: finalize-code-changes-architecture-v0 (§8).
  insertReviewerThread: Stmt;
  listReviewerThreadsForRun: Stmt;
  deleteReviewerThreadsForRun: Stmt;

  // finalize_metrics — append-only adoption-metrics event log.
  // See `server/finalize/metrics-schema.ts` for the table shape and
  // `server/finalize/metrics.ts` for the emitter / aggregator surface.
  /**
   * Append one metric event. Parameters bind in column order:
   * `(project_id, metric_name, labels, value, run_id, observed_at)`.
   * Callers pass `labels` as `JSON.stringify(...)` and `value` as a
   * number — emitters in `metrics.ts` are the only sanctioned writers.
   */
  insertFinalizeMetric: Stmt;
  /**
   * Range scan over all metric events in (project, window). Binds:
   * `(project_id, from_inclusive_ms, to_exclusive_ms)`. The read
   * endpoint groups in TypeScript instead of one query per metric to
   * keep the prepared-statement cache small.
   */
  listAllFinalizeMetricsInRange: Stmt;
}

// ─── Project / Agent Types ───────────────────────────────────────

export interface HeartbeatConfig {
  enabled: boolean;
  interval: string;
  prompt: string;
  /**
   * Optional Claude model ID (e.g. "claude-opus-4-8") forwarded as `--model`
   * when this heartbeat runs. Empty string / undefined leaves the Claude CLI
   * default in place. Heartbeats always spawn the Claude binary, so only
   * `claude-code` engine model IDs apply here.
   */
  model?: string;
}

export interface HookEntry {
  type: string;
  command: string;
}

export interface HookConfig {
  matcher: string;
  hooks: HookEntry[];
}

export interface McpServerConfig {
  /**
   * Transport discriminator. **Required for remote (http / sse) servers** —
   * Claude Code's loader otherwise defaults to stdio, finds no `command`,
   * and silently drops the entry. See docs.claude.com/en/docs/claude-code/mcp.
   */
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP/SSE transport: server URL. Claude Code reads `url` + `headers`. */
  url?: string;
  /** HTTP/SSE transport headers (e.g. `Authorization: Bearer …`). */
  headers?: Record<string, string>;
  /** Marker so Agent Hub can identify and clean up entries it injected. */
  _agentHub?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  engine: string;
  role?: string;
  color?: string;
  avatar?: string;
  systemPrompt?: string;
  heartbeat?: HeartbeatConfig;
  parentAgentId?: string;
  subAgents?: string[];
  /**
   * When set to `false`, the lead agent's `<delegate>` blocks are gated:
   * the server skips spawning sub-agent sessions and emits a system-message
   * + `delegation_disabled` WS event so the lead is nudged to complete work
   * inline. Only meaningful for lead agents (those with `subAgents`).
   * `undefined` / `true` → delegation enabled (default behaviour).
   */
  delegationEnabled?: boolean;
  /**
   * When explicitly `false`, host-mediated browser tools (`<agenthub:react>`
   * `tool: browser`) are omitted from the enriched prompt and rejected at
   * execution time. When `undefined`, the project’s
   * `browserToolsDefaultEnabled` applies (then global default on).
   */
  browserToolsEnabled?: boolean;
  /** Optional Chromium viewport width — falls back to project then server default. */
  browserViewportWidth?: number;
  /** Optional Chromium viewport height — falls back to project then server default. */
  browserViewportHeight?: number;
  /**
   * Navigation / host browser step timeout in ms (1000–120000).
   * Falls back to project then the server default (30s).
   */
  browserPageLoadTimeoutMs?: number;
  hooks?: Record<string, HookConfig[]>;
  mcpServers?: Record<string, McpServerConfig>;
  installCommand?: string;
  reviewer?: string;
  canReview?: boolean;
  model?: string;
  active?: boolean;
  [key: string]: unknown;
}

export interface GithubWorkflowSettings {
  autoMerge?: boolean;
  autoReview?: boolean;
  waitForCI?: boolean;
  waitForResolvedComments?: boolean;
  /** When set, PR reviews dispatched via the GitHub webhook use this model instead of the reviewer agent's default `model`. */
  reviewerModel?: string;
}

/** `dev` — full Agent Hub dev experience. `workflow` — workflow-centric; per-session worktrees and PR-review automation are off by default. */
export type ProjectMode = 'dev' | 'workflow';

/**
 * Per-project visibility. Defaults to `'shared'` when unset (back-compat:
 * every project that existed before this field was added is visible to every
 * org member). `'private'` projects are visible only to their `ownerUserId`
 * — except an org Owner sees them in the Settings → Projects admin list so
 * they retain a kill switch (delete-only, no enter). See
 * `project-visibility.ts` for the gate.
 */
export type ProjectVisibility = 'shared' | 'private';

/**
 * Per-project PR-env (preview environment) configuration.
 *
 * When `enabled`, opening or pushing to a PR on this project's GitHub repo
 * triggers a preview env build:
 *   1. Clone the PR ref into a per-PR working dir on the host.
 *   2. (Optional) `docker build` against `dockerfilePath` if provided; otherwise
 *      run the project on the generic base image with a bind-mounted checkout.
 *   3. Run `setupCommand` once (e.g. `npm install`).
 *   4. Spawn `startScript` with `PORT=<internalPort>` env, capture logs.
 *   5. Wire host port from the pool → `internalPort` via nginx; sticky-comment
 *      the URL on the PR.
 *
 * GitHub App credentials reuse the Reviewer App (`AppConfig.githubApp`) — no
 * separate App registration. Host-level fields (preview host, base URL, port
 * range, Route 53 zone) live on the singleton `pr_env_config` row.
 */
export interface PrEnvProjectConfig {
  enabled: boolean;
  /** Shell run once after clone, in the working dir. e.g. `npm install`. Optional. */
  setupCommand?: string;
  /** Path to the start script in the repo, relative to repo root. e.g. `./scripts/pr-env.sh`. */
  startScript: string;
  /** Port the start script binds to inside the container; nginx maps the host port here. */
  internalPort: number;
  /** Optional health-check path; defaults to `/`. */
  healthPath?: string;
  /**
   * Optional path to a Dockerfile (relative to repo root). When set, the builder
   * `docker build`s this image per PR ref and runs the start script inside it.
   * When unset, the builder uses a generic base image (Node + Python +
   * build-essential + git) with the checkout bind-mounted at `/workspace`.
   */
  dockerfilePath?: string;
  /**
   * Extra environment variables passed into the per-PR container as
   * `docker run --env K=V` pairs (e.g. AWS credentials, feature flags,
   * upstream API URLs). Flat string→string map only — no nested objects.
   *
   * `PORT` is set automatically by the runner from `internalPort` and
   * cannot be overridden here (the validator rejects it).
   *
   * Stored as plaintext on disk in `projects.json` today — only put
   * values here that you'd be comfortable seeing in a config dump on
   * the host. Real secrets should keep flowing through the
   * Terraform-managed instance role / SSM / IMDS path.
   */
  env?: Record<string, string>;
  /**
   * Optional per-project "client-only preview" config. Distinct from the
   * full PR-env start script so projects with a heavyweight backend can
   * still ship a quick visual preview (Vite dev server, Storybook, etc.)
   * without spinning the whole stack. When `enabled` is false (or the
   * block is omitted) the preview runtime is off — only the regular
   * PR-env path runs.
   *
   * Requires the parent `enabled: true` — a preview is meaningless when
   * the project's PR-env feature itself is off, and the validator
   * rejects that combination.
   */
  preview?: PrEnvPreviewConfig;
}

/**
 * Lightweight preview sub-config attached to {@link PrEnvProjectConfig}.
 *
 * Used by the per-PR runner to spawn a *second* (or replacement) command
 * that serves a client-only preview (Vite dev server, Storybook, static
 * `npx serve dist`, etc.). Routes listed in `captureRoutes` are
 * auto-screenshotted by the screenshot worker for the PR description.
 */
export interface PrEnvPreviewConfig {
  /** Master switch. When false (or the block is absent), preview is off. */
  enabled: boolean;
  /**
   * Optional preview-specific start command, relative to repo root.
   * Falls back to the parent `startScript` when unset — handy for
   * projects whose normal start script already serves a static preview
   * but who still want preview-specific routes/idle-TTL tuning.
   */
  startScript?: string;
  /**
   * Optional preview port. Defaults to the parent `internalPort` when
   * unset. Same nginx-mapped contract as `internalPort` (1024–65535).
   */
  port?: number;
  /**
   * Routes to auto-screenshot for the PR description (e.g. `/`,
   * `/components/Button`). Each entry must start with `/`. Capped at
   * 10 routes to keep screenshot time bounded per PR.
   */
  captureRoutes?: string[];
  /**
   * Idle TTL in seconds. After this many seconds with no traffic, the
   * preview runtime is torn down and re-spawned on the next request.
   * Defaults to 600 (10 min). Bounded 60–86400 (1 min – 24 h).
   */
  idleTTL?: number;
  /**
   * Max ms the runtime should wait for a process's `healthPath` to
   * return 2xx before flipping the process to `failed`. Defaults to
   * 120000 (2 min) so a cold worktree that runs `npm install` on its
   * first boot has room. Bounded 5000–600000 (5 s – 10 min) at config
   * save time. Currently a documented hook — the runtime accepts the
   * value via its construction `config`; per-project plumbing into the
   * production wiring is a follow-up.
   */
  healthTimeoutMs?: number;
  /**
   * @deprecated Ignored — preview boot is human-only via the chat toolbar
   * (`POST /api/sessions/:id/preview/start`). Agents must not emit
   * `<agenthub:preview>`; the host rejects those blocks. While a
   * user-started preview is `ready`, file edits may trigger an iframe
   * refresh / compose backend restart only.
   */
  autoStart?: boolean;
  /**
   * Optional multi-process preview graph. When non-empty, `startScript`
   * (above) is ignored and the runtime spawns each entry in topological
   * order based on `dependsOn`. Used for "fullstack" repos that need a
   * backend AND a frontend running in tandem (e.g. Django runserver +
   * Vite dev server) with per-process status, logs, and health checks.
   *
   * Capped at 6 processes — the cap exists to keep host resource usage
   * (file handles, log streams, port pool) bounded; bump the constant
   * in `preview-process-graph.ts` if the cap ever becomes the limit.
   */
  processes?: PreviewProcess[];
  /**
   * Optional docker-compose orchestration. When set, the
   * `PreviewComposeRuntime` runs the project's `docker-compose.yml`
   * inside an isolated compose project named
   * `agenthub-session-<sessionId>`, rather than spawning host processes
   * via `startScript` / `processes[]`. This is the "universal" preview
   * mode for repos that already ship a working compose file — the
   * project's existing local-dev workflow is the source of truth, with
   * no Agent-Hub-specific path-prefix proxy, framework middleware, or
   * `servePath` flags.
   *
   * When `compose.entryService` is set the runtime picks the compose
   * path; otherwise it falls back to the legacy single/multi-process
   * spawn path. The two configurations are mutually exclusive at the
   * validator level — `compose` cannot coexist with `processes[]` or a
   * non-default `startScript`.
   *
   * See ADR: `worktree-previews-compose-pivot-adr` on the wiki.
   */
  compose?: PreviewComposeConfig;
}

/**
 * Docker-compose preview orchestration sub-config attached to
 * {@link PrEnvPreviewConfig}.
 *
 * Each session boots a dedicated `docker compose -p
 * agenthub-session-<sessionId>` project against the worktree-bind-mounted
 * compose file, exposing the entry service's internal port on a single
 * allocated host port. Backing services (Postgres, Redis, etc.) are
 * declared as siblings in the same compose file; each session gets its
 * own ephemeral copy, torn down via `docker compose down -v` on session
 * end / idle reap.
 *
 * The contract is intentionally minimal — five fields cover the happy
 * path; everything else (overrides, profiles, build args) is whatever
 * the project's compose file already declares.
 */
export interface PreviewComposeConfig {
  /**
   * Path to the compose file relative to the worktree root.
   * Default: `docker-compose.yml`.
   *
   * Must resolve to a path inside the worktree (path-traversal is
   * rejected at config-save time). Symlinks are followed by the docker
   * client itself; the runtime does not pre-resolve them.
   */
  file?: string;
  /**
   * Service name (must exist in the compose file) whose port is exposed
   * to the iframe. Required — there's no way to guess which of N services
   * is the "frontend" without reading the compose file, and we want
   * config-level explicitness here.
   *
   * Must match `/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/` (compose's own service-
   * name rules).
   */
  entryService: string;
  /**
   * Internal port that `entryService` listens on inside its container.
   * The runtime maps an allocated host port → this internal port via a
   * compose `ports:` override at start. Bounded 1..65535.
   */
  entryPort: number;
  /**
   * Optional dotenv file passed to `docker compose --env-file`,
   * relative to the worktree root. Missing files are a no-op (compose's
   * own behaviour). Use this for project-level secrets that the compose
   * file references via `${VAR}` interpolation.
   */
  envFile?: string;
  /**
   * HTTP path the runtime polls on `http://<host>:<allocatedPort>` to
   * decide when the preview is ready. Default `/`. Must start with `/`.
   */
  healthPath?: string;
  /**
   * Override the host port range. Defaults to the same 4100–4999 pool
   * as the legacy spawn runtime — both modes can coexist on the same
   * host because the underlying `worktree_preview_processes.port`
   * UNIQUE invariant prevents collisions.
   */
  hostPortRange?: { min: number; max: number };
  /**
   * Max ms the runtime waits for a 2xx from `healthPath` before flipping
   * the group to `failed`. Defaults to 600_000 (10 min) — sized so a
   * first-time `docker compose build` + prod-dump restore on a cold cache
   * has room. Bounded 5000..1800000 (5 s – 30 min) at config save time.
   */
  readyTimeoutMs?: number;
  /**
   * Live-edit binding. When set, the runtime bind-mounts the host
   * worktree onto this absolute path inside the `entryService`
   * container so the dev server's file watcher sees agent edits
   * directly — no `docker compose up --build` per change. Must start
   * with `/`. Common values: `/workspace`, `/app`, `/srv`. When unset
   * the runtime behaves as before (image-baked source, no bind).
   */
  entryWorkdir?: string;
  /**
   * Subdirectory of the worktree root to bind-mount at `entryWorkdir`.
   * Defaults to `.` (the worktree root itself). For monorepos where
   * the Dockerfile build context is a subdirectory (e.g. `frontend/`),
   * set this to that subdirectory so the bind source matches what the
   * image expects at `entryWorkdir`. Must be a relative path without
   * `..` segments. Ignored when `entryWorkdir` is unset.
   */
  entrySourceDir?: string;
  /**
   * Paths under `entryWorkdir` that should remain image-provided
   * rather than coming from the host bind mount. Compose anonymous
   * volumes "punch holes" in the parent bind — without this,
   * `<entryWorkdir>/node_modules` from the host shadows the image's
   * pre-installed deps and `ng serve` / `vite dev` fail immediately.
   * Empty list = no shadows (bind covers everything; usually wrong).
   * Conventional defaults if you don't override: `["node_modules"]`.
   * Ignored when `entryWorkdir` is unset.
   */
  shadowDirs?: string[];
}

/**
 * A single process inside a multi-process preview graph. Names are
 * the stable identifier — they appear in URLs, log file paths, and the
 * `dependsOn` adjacency list. Each process is spawned with its own
 * cwd / env / port; the runtime polls `healthPath` (default `/`) on its
 * allocated port and only kicks off dependents once 2xx is observed.
 */
export interface PreviewProcess {
  /**
   * Short kebab-case identifier. Must match `/^[a-z][a-z0-9_-]*$/` and
   * be unique within `processes[]`. Surfaces in `/api/sessions/:id/
   * preview/processes` and is the join key for `dependsOn`.
   */
  name: string;
  /**
   * Shell command run via `sh -c <startScript>` from `cwd` (or the
   * worktree root when `cwd` is omitted). Same contract as the
   * single-process `PrEnvPreviewConfig.startScript`.
   */
  startScript: string;
  /**
   * Optional working directory relative to the worktree root. Defaults
   * to the worktree root itself. Absolute paths are rejected (the
   * runtime treats this field as a worktree-relative path and rebases
   * each spawn to the live session worktree).
   */
  cwd?: string;
  /**
   * Optional preferred listen port. Ignored by the runtime — port
   * allocation comes from the worktree-preview pool to preserve the
   * `UNIQUE(port)` invariant. Persisted so the UI can show the
   * configured-vs-actual mapping when troubleshooting.
   */
  port?: number;
  /**
   * Path the runtime polls for readiness. Defaults to `/`. 2xx flips
   * the process to `ready` and unblocks dependents. Must start with `/`.
   */
  healthPath?: string;
  /**
   * Names of other processes in the same graph that must reach `ready`
   * before this one is spawned. Forms a DAG; cycles are rejected at
   * config save time. Empty / omitted = root (spawned in wave 0).
   */
  dependsOn?: string[];
  /**
   * Optional path to a dotenv file (relative to the worktree root)
   * whose contents are parsed and overlaid onto this process's spawn
   * env after the project-wide preview secrets — per-process values
   * win against project-wide ones. Missing file is a no-op.
   */
  envFile?: string;
}

export interface Project {
  id: string;
  name: string;
  cwd: string;
  ahw: string;
  color?: string;
  /** Defaults to dev when omitted (see `getProjectMode` in `project-mode.ts`). */
  mode?: ProjectMode;
  /**
   * Project visibility. `'shared'` (default when omitted) makes the project
   * visible to every member of its org. `'private'` restricts visibility to
   * `ownerUserId`; org Owners can still see + delete it from the admin list
   * but cannot enter it. See `project-visibility.ts`.
   */
  visibility?: ProjectVisibility;
  /**
   * User id of the project's creator. Stamped at creation time from the
   * authenticated caller's `authUserId`. Backfilled to `null` for pre-feature
   * projects (treated as shared). Used by the visibility gate and the
   * user-delete cascade (private projects auto-delete when their owner is
   * deleted).
   */
  ownerUserId?: string | null;
  githubRepo?: string;
  /**
   * Optional canonical HTTPS GitHub clone URL (e.g.
   * `https://github.com/owner/repo.git`). When set, the worktree
   * manager auto-clones the repo into `cwd` on session spawn if
   * `cwd` is missing or not a git repo. Used to make project records
   * self-healing across container restarts. SSH URLs and non-GitHub
   * hosts are rejected by the API validator. Distinct from
   * `githubRepo` (an `owner/repo` string used by webhook config).
   */
  repoUrl?: string | null;
  githubWorkflow?: GithubWorkflowSettings;
  /**
   * Shell commands run in the session worktree cwd after an initial `git add`
   * and before `git commit` during auto-PR and manual “Create PR” flows. The
   * server runs `git add -A` again after these commands so formatters/fixers
   * that mutate files stay staged. Empty or absent skips this step (native
   * git hooks still run with `git commit`).
   */
  preCommitCommands?: string[];
  /**
   * When non-empty, a non-zero exit from `preCommitCommands` may run these
   * fixers (e.g. `npm run lint:fix`, `npm run format`) and re-run the failed
   * check suite, capped by `checkHealMaxRounds`.
   * Timeouts and output-cap failures never trigger heal.
   * Web client: Settings → Project Settings. Mobile does not expose project hook
   * fields yet — add these when mobile project settings reach parity with web.
   */
  checkHealCommands?: string[];
  /**
   * Max full check passes when `checkHealCommands` is set (default 2, max 5).
   * Ignored when `checkHealCommands` is empty.
   */
  checkHealMaxRounds?: number;
  /**
   * Optional ReAct / auto-continuation budgets for sessions in this project.
   * Shapes match `OrchestrationBudgetsPartial` in `server/orchestration-budgets.ts`.
   */
  orchestrationBudgets?: Record<string, unknown>;
  /**
   * Per-project preview-env config. When omitted or `enabled: false`, PR
   * webhook events on this project's repo are ignored by the PR-env
   * dispatcher. See {@link PrEnvProjectConfig}.
   */
  prEnv?: PrEnvProjectConfig;
  /**
   * Per-project wall-clock windows that gate the fix-dispatch stall
   * watchdog (`server/finalize/stall-watchdog.ts`). Both fields are
   * **starting points** — the design doc names 60 min / 24 hr as defaults
   * "subject to tuning during dogfood monitoring", so projects may lower
   * them. The watchdog only arms in **live** mode (UI button trigger);
   * autonomous-triggered runs ignore both windows. See wiki §7
   * "Human-walked-away behavior".
   */
  finalizeStall?: {
    /**
     * Wall-clock ms after a fix dispatch lands at which a push
     * notification fires to the triggering user. The notification is a
     * "still waiting" reminder, not a cancel — the run continues to wait
     * for turn-end. Default: 60 minutes (`60 * 60 * 1000`). Hard floor
     * 60s so operators cannot accidentally spam pushes every tick.
     */
    notifyAfterMs?: number;
    /**
     * Wall-clock ms after a fix dispatch lands at which the run is
     * transitioned to `status = 'stalled_no_response'`. The dispatched
     * message stays in the session log so the human can pick up later
     * and re-trigger. Default: 24 hours (`24 * 60 * 60 * 1000`). Hard
     * floor: must be strictly greater than {@link notifyAfterMs} —
     * otherwise the notification would have no purpose and we'd just
     * stall on a single tick.
     */
    stallAfterMs?: number;
  };
  /**
   * Default for `browserToolsEnabled` when an agent omits the field.
   * When omitted project-wide, treated as enabled (backward compatible).
   */
  browserToolsDefaultEnabled?: boolean;
  /** Default viewport width for host browser tools (agents may override). */
  browserViewportWidth?: number;
  /** Default viewport height for host browser tools (agents may override). */
  browserViewportHeight?: number;
  /** Default page-load / browser-op timeout in ms for agents that do not override. */
  browserPageLoadTimeoutMs?: number;
  /**
   * Agent id whose skill toggles apply to scheduled cron runs when the cron row’s
   * `skill_principal_agent_id` is unset. Unused for single-agent projects (they
   * default to that agent automatically). Persisted in `projects.json`.
   */
  cronSkillPrincipalAgentId?: string;
  /**
   * IAM Identity Center (SSO) profiles for this project. Rendered to
   * `AWS_CONFIG_FILE` at spawn time; tokens cache under the user's HOME.
   * See `project-aws-profiles.ts`.
   */
  awsSsoProfiles?: Record<
    string,
    {
      sso_account_id: string;
      sso_start_url: string;
      sso_region: string;
      sso_role_name: string;
      region: string;
      output?: string;
    }
  >;
  /**
   * When true, AWS IAM Identity Center (SSO) support is surfaced for this
   * project: an "AWS" entry appears under the project in the sidebar where
   * SSO profiles are managed. Defaults to `false` (omitted) — AWS stays
   * hidden until a user opts in via Settings → Projects.
   */
  awsEnabled?: boolean;
  agents: Agent[];
  [key: string]: unknown;
}

export interface EnrichedAgent extends Agent {
  projectId: string;
  projectName: string;
  cwd: string;
  ahw: string;
  workspace: string;
}

export interface AgentLookup {
  project: Project;
  agent: Agent;
}

// ─── Config Type ─────────────────────────────────────────────────

export interface GitHubAppConfig {
  appId: string;
  appSlug?: string;
  privateKey: string;
  webhookSecret?: string;
  /**
   * @deprecated Prefer `AppConfig.personalOAuth` for user-to-server OAuth.
   * GitHub Apps can issue user tokens via these credentials, but the App
   * is conceptually the *reviewer-bot* identity (installable on repos),
   * not the personal-sign-in identity. Older installs that completed the
   * App-manifest flow before the split keep working: github-oauth.ts
   * falls back to `githubApp.clientId/Secret` when `personalOAuth` is
   * unset. New installs should register a standalone OAuth App at
   * github.com/settings/applications/new and put its credentials under
   * `personalOAuth` instead.
   */
  clientId?: string;
  /** @deprecated See clientId. */
  clientSecret?: string;
  installationId?: number;
  installations?: Array<{ id: number; account: string; accountType: string }>;
}

/**
 * Standalone GitHub OAuth App credentials — the personal-sign-in identity.
 *
 * Distinct from `GitHubAppConfig` (which is for the installable reviewer
 * bot). A user does NOT need to create or install a GitHub App to sign
 * in with their GitHub account — they only need a `client_id`/`client_secret`
 * from a plain OAuth App registration at github.com/settings/applications/new.
 *
 * The reviewer feature is the only thing that genuinely needs a GitHub
 * App; everything else (PR list, push, comment, merge, open PR) is
 * user-to-server and goes through this OAuth App.
 */
export interface PersonalOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface AppConfig {
  port: number;
  host: string;
  claudeBin: string;
  cursorBin: string;
  geminiBin: string;
  codexBin: string;
  defaultCwd: string;
  dataDir: string;
  projectsDir: string;
  defaultModel: string;
  engineDefaultModels: Record<string, string>;
  engineValidModels: Record<string, string[]>;
  defaultTimeoutMs: number;
  docsTimeoutMs: number;
  slackTimeoutMs: number;
  conferenceTimeoutMs: number;
  /**
   * Fallback timeout (ms) for webhook-dispatched Claude runs. Falls back to
   * `defaultTimeoutMs` when unset. Use `webhookEventTimeoutMs` to override
   * per-event (e.g. `pull_request_review.submitted` typically needs longer
   * than a 5-minute push autofix).
   */
  webhookTimeoutMs: number;
  /**
   * Per-event timeout (ms) overrides for webhook-dispatched Claude runs.
   * Keys are either the bare event name (e.g. `pull_request_review`) or
   * `event.action` (e.g. `pull_request_review.submitted`); the more specific
   * key wins. See `resolveWebhookTimeoutMs` in `routes/webhooks.ts`.
   */
  webhookEventTimeoutMs: Record<string, number>;
  /**
   * Server-wide default for compose preview health polling (ms). Overridden
   * per project via `prEnv.preview.compose.readyTimeoutMs`. Env:
   * `AGENT_HUB_PREVIEW_READY_TIMEOUT_MS`; config.json:
   * `previewComposeReadyTimeoutMs`. Clamped 5000–1800000.
   */
  previewComposeReadyTimeoutMs: number;
  /**
   * Wildcard subdomain base for "subdomain preview" mode. When set
   * (e.g. `preview.agenthub.dev.surveytracker.io`), the request
   * dispatcher accepts `<sessionId>.<base>` hostnames and rewrites
   * them to the path-prefix proxy mount, letting apps render at
   * base `/` with zero per-app config. `null` = subdomain mode off
   * (only the path-prefix proxy is active). Env:
   * `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`; config.json:
   * `previewSubdomainBase`.
   */
  previewSubdomainBase: string | null;
  publicUrl: string | null;
  defaultReviewer: string | null;
  botGithubToken: string | null;
  githubApp: GitHubAppConfig | null;
  /**
   * Standalone OAuth App credentials for personal "Sign in with GitHub".
   * Decoupled from `githubApp` so users can link their GitHub identity
   * without creating or installing the reviewer-bot App. When unset,
   * `github-oauth.ts` falls back to `githubApp.clientId/Secret` for
   * back-compat with installs that completed the manifest flow first.
   */
  personalOAuth: PersonalOAuthConfig | null;
  apiKey: string | null;
  /**
   * Host-wide OpenAI API key. NOT an agent-engine credential (Codex spawns
   * use the per-account `codex_api_key`). This powers host utilities that
   * call OpenAI directly: Whisper transcription (`/api/transcribe`) and the
   * optional LLM session-title upgrade.
   */
  openaiApiKey: string | null;
  /**
   * Host-wide Gemini API key. Gemini is the only AI *engine* with a host-level
   * credential — it backs wiki embeddings and the Gemini CLI. Claude / Cursor
   * / Codex are strictly per-account (encrypted `users` columns + per-user
   * HOME OAuth caches); there is no host-wide key for those engines.
   */
  geminiApiKey: string | null;
  /**
   * Optional Codex CLI profile name. When set, every `codex exec` spawn
   * (chat, room, design, delegation) gets `--profile <name>` appended so
   * the CLI loads the matching profile from `~/.codex/config.toml`
   * (model / provider / approval / sandbox overrides). Empty / whitespace
   * is treated as unset. Configure via `codexProfile` in config.json,
   * `PATCH /api/config`, or env `CODEX_PROFILE`.
   *
   * See https://developers.openai.com/codex/cli/reference for the
   * profile semantics.
   */
  codexProfile: string | null;
  /**
   * When true (the default), interactive Codex spawns (chat, rooms, design,
   * delegation) outside Ask Mode pass `--dangerously-bypass-approvals-and-sandbox`
   * instead of `--full-auto`, so Codex works in environments where Linux
   * bubblewrap cannot create user namespaces. Set false to keep Codex's
   * sandbox on hosts that support it. Configure via `codexDangerBypass` in
   * config.json, `PATCH /api/config`, or env `AGENT_HUB_CODEX_DANGER_BYPASS`
   * (`false` / `0` / `off` to disable).
   */
  codexDangerBypass: boolean;
  /**
   * LAN / air-gapped mode. When true, Agent Hub assumes GitHub webhooks
   * cannot reach this host (no public URL, no tunnel) and:
   *
   *   • `POST /api/webhooks` with `autoRegister: true` short-circuits with
   *     `{ ok: true, skipped: true, reason: 'lan_mode' }` instead of calling
   *     GitHub's hook-create API — no inbound webhook is provisioned.
   *
   * NOTE: the GitHub review/CI polling fallback was removed — reviews and CI
   * are now handled purely by inbound webhooks. A LAN-mode deployment that
   * GitHub cannot reach therefore no longer gets automated reviewer dispatch,
   * PR-merge → Done reconciliation, or `changes_requested` follow-ups. Use a
   * publicly reachable Hub (or a tunnel) if you need autonomous PR handling.
   *
   * Configure via `lanMode` in config.json or `PATCH /api/config`. Defaults to
   * false (webhook-driven behavior unchanged for cloud deployments).
   */
  lanMode: boolean;
  slackWebhookUrl: string | null;
  /** Max simultaneous host Chromium contexts (distinct pinned chat sessions). */
  browserMaxConcurrentContexts: number;
  /** Idle auto-close for host browser contexts (ms). */
  browserIdleTimeoutMs: number;
  /** When false, Playwright downloads are canceled at start. */
  browserAllowDownloads: boolean;
  /** Block common ad/tracker third-party hosts at route level when true. */
  browserBlockAdsTrackers: boolean;
  readonly allValidModels: string[];
}

// ─── Stream Parser Types ─────────────────────────────────────────

export type StreamEventType =
  | 'system'
  | 'assistant_text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'checkpoint'
  | 'rate_limit'
  | 'ask_user_question'
  | 'progress_step'
  | 'browser_tool_activity' // Synthetic host telemetry — never emitted by the CLI JSONL parser
  | 'error'
  | 'unknown';

export type ProgressStepStatus = 'started' | 'completed' | 'failed';

export interface BaseStreamEvent {
  type: StreamEventType;
  raw?: string;
}

export interface SystemEvent extends BaseStreamEvent {
  type: 'system';
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  tools: string[];
  gitWorktree?: boolean | null;
}

export interface AssistantTextEvent extends BaseStreamEvent {
  type: 'assistant_text';
  text: string;
  partial: boolean;
  /**
   * When true (Cursor `result` → canonical body), `chat.ts` replaces the
   * streaming accumulation instead of appending — avoids losing tail content
   * that only appears on `result.result` and prevents doubling when the
   * streamed deltas already matched the final string.
   */
  replacesAssistantBuffer?: boolean;
}

export interface ThinkingEvent extends BaseStreamEvent {
  type: 'thinking';
  text: string;
}

export interface ToolUseEvent extends BaseStreamEvent {
  type: 'tool_use';
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseStreamEvent {
  type: 'tool_result';
  toolUseId: string;
  output: string;
  isError: boolean;
}

export interface ResultEvent extends BaseStreamEvent {
  type: 'result';
  text: string;
  durationMs: number | null;
  costUsd: number | null;
  numTurns: number | null;
  isError: boolean;
  stopReason?: string | null;
  /** Present when the upstream engine reports usage on the terminal result. */
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface CheckpointEvent extends BaseStreamEvent {
  type: 'checkpoint';
  uuid: string;
  turnIndex: number | null;
}

export interface RateLimitEvent extends BaseStreamEvent {
  type: 'rate_limit';
  retryAfterMs: number | null;
  message: string | null;
}

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionEvent extends BaseStreamEvent {
  type: 'ask_user_question';
  // Stable id derived from the questions payload; used by the client to
  // deduplicate if the same block is re-emitted (e.g. on resume).
  askId: string;
  questions: AskUserQuestionItem[];
}

export interface ProgressStepEvent extends BaseStreamEvent {
  type: 'progress_step';
  /** Human-readable step name, e.g. "Gathered PR context". */
  step: string;
  /** Lifecycle state for this step. */
  status: ProgressStepStatus;
  /** Epoch ms when the step was marked `started`. For `completed` / `failed`,
   *  this is the same value originally emitted so clients can compute elapsed. */
  startedAt: number;
  /** Epoch ms when the step reached `completed` or `failed`. Absent for `started`. */
  finishedAt?: number;
}

/**
 * Host-mediated browser (<agenthub:react> browser) step — emits outside the CLI
 * stream parser while still persisting alongside stream-json telemetry.
 */
export interface BrowserToolActivityEvent extends BaseStreamEvent {
  type: 'browser_tool_activity';
  /** Correlates a started + ended pair. */
  actionId: string;
  phase: 'started' | 'ended';
  op: string;
  /** Present-tense hint while running; echoed on `ended` for stable labels. */
  label: string;
  startedAtMs: number;
  /** `ended` only */
  durationMs?: number;
  ok?: boolean;
  /** Past-tense headline for timeline UI */
  summary?: string;
  extractPreview?: string;
  /** Screenshot browser op produced an image (`ended` phase). Independent of WS inline preview omission. */
  hasScreenshot?: boolean;
  targetSummary?: string;
  error?: string;
}

export interface ErrorEvent extends BaseStreamEvent {
  type: 'error';
  message: string;
}

export interface UnknownEvent extends BaseStreamEvent {
  type: 'unknown';
  text: string;
}

/** Parsed stream-json CLI events plus host-synthetic rows stored in session_events together. */
export type StreamEvent =
  | SystemEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent
  | CheckpointEvent
  | RateLimitEvent
  | AskUserQuestionEvent
  | ProgressStepEvent
  | BrowserToolActivityEvent
  | ErrorEvent
  | UnknownEvent;

export interface StreamParser {
  feed(chunk: Buffer | string): StreamEvent[];
  flush(): StreamEvent[];
}

// ─── WebSocket Types ─────────────────────────────────────────────

export interface ChatMessage {
  type: 'chat';
  agentId: string;
  sessionId: string;
  content: string;
  images?: string[];
  _fromQueue?: boolean;
  _existingMsgId?: string;
  /**
   * Set to true when this message was produced by the bug-report reroute
   * guard in `handleChat`. Prevents re-entrant reroutes if the intake agent
   * itself is somehow misconfigured without role === 'intake'.
   */
  _reroutedFromBugReport?: boolean;
  /**
   * Set to true when this message was dispatched by
   * `POST /api/projects/:projectId/board/cards/:cardId/assign`. The bug-report
   * reroute guard treats explicit user-driven assigns as authoritative — the
   * chosen assignee owns the card even if its description happens to embed a
   * `## Bug Report` header that would otherwise trip the heuristic. See
   * `server/bug-report-reroute.ts`.
   */
  _fromBoardAssign?: boolean;
  /**
   * Set to true when this message was dispatched by the autonomous-mode
   * loop in `server/autonomous.ts`. Used in `chat.ts` to inform the
   * GitHub spawn-credential policy (see `resolveGithubSpawnToken` in
   * `server/github-spawn-token-resolver.ts`):
   * autonomous-dispatch sessions are created by the system (no human
   * caller in scope) and attributed to the org owner, so injecting the
   * org owner's per-user OAuth token would let the spawned agent post
   * formal PR reviews via `gh api .../reviews -X POST` under the
   * human's identity — bypassing the `AGENT_HUB_REVIEWER_LOCK` wrapper
   * gate. This sentinel forces the per-user fallback path to return
   * `null` so autonomous-dispatch spawns land with no `GH_TOKEN`. The
   * server-side auto-PR push (`auto-git.ts`) is unaffected because it
   * runs in the Hub process, not in the spawned agent's env.
   */
  _fromAutonomousDispatch?: boolean;
  hookSpecificOutput?: { sessionTitle?: string; [key: string]: unknown };
  /**
   * Additional environment variables to inject into the spawned CLI process.
   * Merged into the base `spawnEnv` AFTER all other credentials are resolved,
   * so callers can supply scoped secrets (e.g. `DEV_HUB_API_KEY`) without
   * touching the shared credential-resolution logic in `buildSpawnEnv`.
   *
   * **Important:** not all keys flow through. `mergeAllowlistedExtraEnv` in
   * `server/extra-env-allowlist.ts` filters this field (allowlist currently
   * `['DEV_HUB_API_KEY']`) and
   * additionally skips any key already present in `spawnEnv`. Keys not on
   * the allowlist are silently dropped; this is what prevents WebSocket
   * callers from shadowing `ANTHROPIC_API_KEY`, `GH_TOKEN`, etc.
   *
   * Used by autonomous dispatch and manual kanban assign (`routes/board.ts`)
   * to inject cross-hub API keys only for cards that carry an opt-in label
   * (see `server/secrets.ts`).
   */
  extraEnv?: Record<string, string>;
  /**
   * Internal: invoked at most once with true when the user message for this turn
   * was persisted (queued or immediate). False otherwise. Used so review-feedback
   * webhook dedup does not advance when `handleChat` drops a system inject (e.g. queue full).
   */
  _onUserMessagePersisted?: (accepted: boolean) => void;
  /** Internal: skip multi-agent routing and run a single executor/advisor turn. */
  _multiAgentInternal?: boolean;
  /** Internal: do not persist a user message (follow-up executor turns). */
  _skipUserMessagePersist?: boolean;
  /** Internal: advisor feedback content for executor follow-up prompt. */
  _advisorFeedback?: { name: string; content: string };
}

export interface CancelMessage {
  type: 'cancel';
  sessionId: string;
}

export interface DesignChatMessage {
  type: 'design_chat';
  designId: string;
  content: string;
}

export interface DesignCancelMessage {
  type: 'design_cancel';
  designId: string;
}

export type WSIncomingMessage =
  | ChatMessage
  | CancelMessage
  | DesignChatMessage
  | DesignCancelMessage
  | { type: 'delegation_cancel'; sessionId: string }
  | { type: 'dequeue'; sessionId: string; messageId: string }
  | { type: 'edit_queue_item'; sessionId: string; messageId: string; content: string }
  | { type: 'ping' };

export interface BroadcastFn {
  (data: Record<string, unknown>): void;
}

// ─── WebSocket Deps ──────────────────────────────────────────────

export interface WebSocketDeps {
  getProjects: () => Project[];
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  handleCancel: (sessionId: string) => void;
  handleDelegationCancel: (sessionId: string) => void;
  handleDequeue: (sessionId: string, messageId: string) => void;
  handleEditQueueItem: (sessionId: string, messageId: string, content: string) => void;
  handleDesignChat: (ws: unknown, msg: DesignChatMessage) => Promise<void>;
  handleDesignCancel: (designId: string) => void;
  /**
   * Optional compose-runtime accessor used by the WS connect handler to
   * replay `agenthub_preview` snapshots for active previews. Optional so
   * legacy test wirings that don't construct a real runtime continue to
   * work — the snapshot block is skipped when this is absent.
   */
  getPreviewSnapshotRuntime?: () => {
    listActive: () => import('./preview/preview-compose-runtime.js').ComposePreviewRow[];
    getLogTail: (groupId: string) => string[];
  } | null;
}

// ─── Route Dependencies ──────────────────────────────────────────

export interface RouteDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  findProject: (projectId: string) => Project | null;
  findAgent: (agentId: string) => AgentLookup | null;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  allAgents: () => EnrichedAgent[];
  saveProjects: () => void;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  lastDispatchedReviewId: Map<string, number>;
  scheduleAutonomousEpic: (projectId: string, epic: KanbanEpicRow) => void;
  autonomousCrons: Map<string, unknown>;
  runAutonomousLoop: (projectId: string) => Promise<void>;
  config: AppConfig;
  getProjects: () => Project[];
  setProjects: (p: Project[]) => void;
  serverDir: string;
  buildTranscript: (
    messages: Array<{ role: string; content: string; agent_name?: string | null }>,
    options: { agentName?: string; isMultiAgent?: boolean },
  ) => string;
  summarizeTranscript: (
    transcript: string,
    options: { engine: string; model?: string; cwd?: string },
    config: AppConfig,
    skillCredentialMerge?: { ownerId: string | null; agentId: string; project: Project },
  ) => Promise<string>;
  DEFAULT_MODEL: string;
  activeProcesses: Map<string, import('child_process').ChildProcess>;
  getProjectDataDir: (projectId: string) => string;
  ensureDocsAgents: () => void;
  ensureIntakeAgents: () => void;
  ensureReviewerAgents: () => boolean;
  ensureContextFiles: () => void;
  getClaudeBin: () => string;
  setClaudeBin: (v: string) => void;
  getCursorBin?: () => string;
  setCursorBin?: (v: string) => void;
  getGeminiBin?: () => string;
  setGeminiBin?: (v: string) => void;
  getCodexBin?: () => string;
  setCodexBin?: (v: string) => void;
  initDb: (dataDir: string) => void;
  reloadProjects: (dataDir: string) => void;
  setActiveDataDir: (v: string) => void;
  restoreAutonomousCrons: () => void;
  scheduleAll: (agents: EnrichedAgent[]) => void;
  getGhAuthenticatedUser?: () => string | null;
  tryAutonomousDispatch?: () => void;
  runClaude?: (...args: unknown[]) => unknown;
  /**
   * Per-session preview runtimes — wired at server startup. `null` is
   * returned when the singletons aren't constructed yet (e.g. test
   * harnesses that exercise the route layer without the full
   * `createPreviewRuntimes` boot). The session archive/delete handlers
   * call `stopBySessionId` on both so spawn-managed and compose-managed
   * preview groups for the deleted session are torn down.
   */
  getPreviewRuntime?: () => {
    stopBySessionId: (sessionId: string) => Promise<number>;
  } | null;
  getPreviewComposeRuntime?: () => {
    stopBySessionId: (sessionId: string) => Promise<number>;
  } | null;
  /**
   * Clone or attach the session git worktree before the first chat turn.
   * Wired from `index.ts` (`ensureWorktree`). Used by
   * `POST /api/sessions/:sessionId/workspace/ensure` so preview can start
   * immediately after opening a session.
   */
  provisionSessionWorkspace?: (sessionId: string) => Promise<string>;
}

// ─── Design with linked projects ─────────────────────────────────

export interface DesignWithProjects extends DesignRow {
  linkedProjects: Project[];
}

// ─── Project Paths ───────────────────────────────────────────────

export interface ProjectPaths {
  cwd: string;
  ahw: string;
  agentDir: string;
  soulMd: string;
  agentsMd: string;
  userMd: string;
  toolsMd: string;
  memoryMd: string;
  skillsDir: string;
  memoryDir: string;
  identityMd: string;
}

// ─── Express Helpers ─────────────────────────────────────────────

export type { Request, Response, NextFunction, Router };

export interface TypedRequest<
  TBody = unknown,
  TParams = Record<string, string>,
  TQuery = Record<string, string | undefined>,
> extends Omit<Request, 'body' | 'params' | 'query'> {
  body: TBody;
  params: TParams;
  query: TQuery;
  rawBody?: Buffer;
}

// ─── Org Types ───────────────────────────────────────────────────

export interface OrgRow {
  id: string;
  name: string;
  mode: 'local' | 'remote';
  color: string;
  remote_url: string;
  api_key: string;
  position: number;
  created_at: string;
  updated_at: string;
}
