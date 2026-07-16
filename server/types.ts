import type { Request, Response, NextFunction, Router } from 'express';
import type Database from 'better-sqlite3';
import type { DevServerConfig } from './dev-server-config.js';

export type { DevServerConfig, DevServerPortMapEntry } from './dev-server-config.js';

// ─── Database Row Types ──────────────────────────────────────────

export interface SessionRow {
  id: string;
  agent_id: string;
  name: string;
  title_source?: string | null;
  engine: string;
  model: string;
  engine_session_id: string | null;
  use_worktree: number;
  worktree_path: string | null;
  worktree_branch: string | null;
  git_worktree_detected: number | null;
  /**
   * PR head branch for `[Resolve PR #N]` sessions. When set (and the session
   * uses a worktree), `ensureSessionWorkspace` provisions the clone directly on
   * this branch instead of cutting `agent-hub/<agent>/session-<id>`, so the
   * agent's commits append to the existing PR and the push updates it rather
   * than opening a new one. NULL for every non-resolve session.
   */
  resolve_pr_head_branch?: string | null;
  /**
   * User-chosen existing remote branch to position this session's worktree on.
   * When set (and the session uses a worktree, is not a resolve-PR session, and
   * the branch is not the repo default), `ensureSessionWorkspace` checks the
   * clone out directly onto `origin/<branch>` instead of cutting a fresh
   * `agent-hub/<agent>/session-<id>` branch. A clean, idle provisioned session
   * may also update this value through the Branch picker, which moves the
   * worktree before Finalize or code changes can claim the old branch. NULL for
   * the default fresh-branch behavior. See
   * `PUT /api/sessions/:sessionId/worktree-branch`.
   */
  worktree_checkout_branch?: string | null;
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
   * Session mode — the user-selectable "what is this session for" dimension
   * ('chat' | 'design'). NULL/absent on legacy rows → treated as 'chat'. See
   * `server/session-mode.ts`. A 'design' session loads the design skill and
   * produces HTML/CSS/JS artifacts in its worktree (folding the standalone
   * Design Studio into the chat-mode picker).
   */
  session_mode?: string | null;
  /**
   * Codex reasoning-effort preset for this session: `'high'` (default) or
   * `'pro'` (→ native `model_reasoning_effort=xhigh`). NULL/absent on legacy
   * rows and non-Codex sessions → treated as `'high'`. See
   * `server/codex-reasoning.ts`.
   */
  reasoning_effort?: string | null;
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
  /** Number of code-RAG retrieval calls consumed this session (hard budget). */
  code_rag_consumed?: number | null;
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
  /** Epic being scoped in scoping mode — drives the flowchart panel. */
  linked_epic_id?: string | null;
  /** Spec decision being resolved in a spike session (scoping mode). */
  linked_spec_item_id?: string | null;
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
  /**
   * Always-on lifecycle state — one of `server/session-state.ts` `SESSION_STATES`.
   * Denormalized cache of `resolveSessionState`, backfilled by
   * `recomputeSessionState` at the chat/card-close/kanban-move signal boundaries
   * (which also emit the `session_state` event). Serialization still resolves the
   * live value on read, so this is a best-effort seed/cache — NULL is safe.
   */
  state?: string | null;
  /**
   * Error text of the most recent turn that ended in an upstream engine/API
   * error (stream `isError` result or non-zero CLI exit). Cleared at every
   * turn spawn. While set, Finalize automation refuses to auto-start or
   * auto-push for this session — fail-closed so an autonomous session can
   * never merge a half-finished turn. See `server/turn-error.ts`.
   */
  last_turn_error?: string | null;
  /**
   * Number of consecutive automatic post-restart resume attempts for this
   * session that have NOT yet been followed by a clean turn completion.
   * Incremented in `reconcileOrphanedTasks` each boot before re-spawning an
   * orphaned turn; reset to 0 whenever a spawned process exits normally (the
   * server survived the turn). Caps auto-resume so a crash/restart loop can't
   * re-spawn the same session forever. See `MAX_RESUME_ATTEMPTS` in index.ts.
   */
  resume_attempts?: number;
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

/**
 * A document an agent generated during a session (PDF, script, report, etc.)
 * and stored in object storage so the user (and the agent) can download/view
 * it from the session's Artifacts panel. The bytes live in S3 or a local
 * directory (see `server/artifacts/artifact-store.ts`); this row is the
 * metadata index used to list/serve them without enumerating storage.
 */
export interface ArtifactRow {
  id: string;
  session_id: string;
  /** Display name (original filename the agent uploaded). */
  filename: string;
  content_type: string;
  /** Size in bytes. */
  size: number;
  /** Storage backend the bytes live in: `s3` or `local`. */
  storage_kind: string;
  /** Opaque key within the storage backend. */
  storage_key: string;
  /**
   * S3 bucket the bytes were written to (NULL for local rows and legacy rows
   * predating this column). Persisted so reads resolve the ORIGINAL bucket even
   * after the Hub's `artifactsBucket` config changes.
   */
  storage_bucket: string | null;
  /** S3 region for `storage_bucket` (NULL = resolve from ambient/config). */
  storage_region: string | null;
  /** Agent id that created the artifact (NULL for user uploads / legacy). */
  created_by: string | null;
  created_at: string;
}

export interface ReleaseNotificationSettingsRow {
  project_id: string;
  release_digest_prompt: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReleaseDigestRecipientRow {
  id: string;
  project_id: string;
  email: string;
  email_normalized: string;
  display_label: string | null;
  enabled: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Metadata row for a record-on-error session replay. The rrweb event array
 * itself is gzipped and stored as a blob via the artifact store (see
 * server/replays/replay-store.ts); this row is the index the paginated read API
 * resolves from. `size` is the COMPRESSED blob size in bytes;
 * `uncompressed_size` is the raw JSON length.
 */
export interface SessionReplayRow {
  id: string;
  /** Project the replay belongs to, when known (NULL for anonymous ingests). */
  project_id: string | null;
  created_at: string;
  /**
   * Wall-clock of the most recent write (insert or chunked append), as a SQLite
   * `datetime('now')` UTC string. Bumped on every append so the dashboard can
   * derive a best-effort "live" (still-streaming) signal for continuous
   * captures. NULL only on legacy rows created before the column existed and
   * not yet re-appended (readers fall back to `created_at`).
   */
  updated_at: string | null;
  /** Span between the first and last rrweb event timestamp, in ms (>= 0). */
  duration_ms: number;
  /** Number of rrweb events in the capture. */
  event_count: number;
  /** Compressed (gzip) blob size in bytes. */
  size: number;
  /** Raw JSON length before gzip, in bytes. */
  uncompressed_size: number;
  /** Storage backend the gzipped blob lives in: `s3` or `local`. */
  storage_kind: string;
  /** Opaque key within the storage backend. */
  storage_key: string;
  /** S3 bucket (NULL for local rows). Mirrors `artifacts.storage_bucket`. */
  storage_bucket: string | null;
  /** S3 region for `storage_bucket` (NULL = resolve from ambient/config). */
  storage_region: string | null;
  /**
   * How the capture's bytes are laid out: `monolithic` (legacy single blob at
   * `storage_key`) or `segmented` (append-only per-segment objects indexed by
   * `rum_segments`; `storage_key` is unused for byte reads). Legacy rows and
   * every `storeReplay` write are `monolithic`. NULL only on rows created before
   * the column existed (readers treat NULL as `monolithic`).
   */
  storage_layout: string | null;
  /** Support ticket that referenced this replay, when linked. */
  support_ticket_id: string | null;
  /** Kanban card that referenced this replay, when linked. */
  card_id: string | null;
  /**
   * Extended-retention flag: absolute SQLite-UTC instant this capture is
   * retained until, or NULL when not flagged. When set and in the future, the
   * retention sweeper skips the row (exempt from the default window). Absolute
   * because the 15-month clock starts at flag-enable time, not capture. See
   * server/replays/replay-retention.ts.
   */
  retained_until: string | null;
  /** When the extended-retention flag was enabled (SQLite-UTC), or NULL. The
   *  retained_until clock starts from this instant. */
  retention_flagged_at: string | null;
  /** JSON-encoded ingest context (trigger, url, …); NULL when absent. */
  meta: string | null;
}

/**
 * A named, project-scoped group of saved replay captures (Datadog "playlist").
 * The whole playlist can be flagged for extended retention, reusing the
 * per-session two-tier model: flagging stamps an absolute `retained_until`
 * (enable-time + window) and fans the same flag onto every member capture's
 * `session_replays` row. See server/replays/replay-playlist-store.ts.
 */
export interface ReplayPlaylistRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  /** 0/1 extended-retention flag. When 1, `retained_until` is set and members
   *  added to the playlist inherit the flag. */
  extended_retention: number;
  /** Absolute SQLite-UTC instant the playlist (and its members) are retained
   *  until, or NULL when not flagged. Mirrors `session_replays.retained_until`. */
  retained_until: string | null;
  /** When the extended-retention flag was enabled (SQLite-UTC), or NULL. */
  retention_flagged_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

/** A `listReplayPlaylistsByProject` row: the playlist plus its member count. */
export interface ReplayPlaylistWithCountRow extends ReplayPlaylistRow {
  item_count: number;
}

/**
 * One playlist membership joined to its capture's `session_replays` row
 * (`listReplayPlaylistItems`). Carries the join columns (`replay_id`,
 * `position`, `added_at`) alongside every `SessionReplayRow` field.
 */
export interface ReplayPlaylistItemRow extends SessionReplayRow {
  replay_id: string;
  position: number;
  added_at: string;
}

/**
 * One append-only replay segment: a single gzipped S3 object holding a
 * view-scoped slice of rrweb events for a `segmented` capture. S3 is the byte
 * source of truth; this row is the pointer + metadata index playback lists and
 * orders by. See `server/replays/segment-store.ts`.
 */
export interface RumSegmentRow {
  id: string;
  /** Client-minted session id this segment rolls up under. */
  session_id: string;
  /** Client-minted view id (per route/navigation); segments never span views. */
  view_id: string;
  /** Project attribution (NULL for anonymous ingest). */
  project_id: string | null;
  /** 0-based position within the view; index 0 opens with a full snapshot. */
  index_in_view: number;
  /** 1 when this segment carries an rrweb full snapshot (type 2), else 0. */
  has_full_snapshot: number;
  /** Earliest event timestamp in the segment, epoch ms (0 when empty). */
  start_ts: number;
  /** Latest event timestamp in the segment, epoch ms (0 when empty). */
  end_ts: number;
  /** Number of rrweb events in this segment. */
  event_count: number;
  /** Gzipped object size in bytes. */
  byte_size: number;
  /** Storage backend the object lives in: `s3` or `local`. */
  storage_kind: string;
  /** Opaque key within the storage backend. */
  storage_key: string;
  /** S3 bucket (NULL for local rows). */
  storage_bucket: string | null;
  /** S3 region for `storage_bucket` (NULL = resolve from ambient/config). */
  storage_region: string | null;
  created_at: string;
}

/**
 * The session-grain rollup row the RUM dashboard lists and filters on (Datadog
 * "session" grain). One row per client-minted session id, its aggregates
 * maintained incrementally as segments ingest (see
 * `server/replays/rum-session-store.ts`). Per-user identity lives in the `usr_*`
 * columns (last non-null value per field); the enriched facet columns
 * (device/browser/os/geo) are added onto this row by follow-up cards in the RUM
 * epic.
 */
export interface RumSessionRow {
  /** Client-minted session id (the `rum_segments.session_id` these roll up). */
  session_id: string;
  /** Project attribution; first-non-null-wins across the session's segments. */
  project_id: string | null;
  /** Earliest event timestamp across the session, epoch ms (NULL until seen). */
  started_at: number | null;
  /** Latest event timestamp across the session, epoch ms (NULL until seen). */
  ended_at: number | null;
  /** Session duration, ms: `ended_at - started_at` (0 until both are known). */
  time_spent: number;
  /** Distinct views in the session (one per index_in_view=0 segment). */
  view_count: number;
  /** Rolled-up action count across the session's segments. */
  action_count: number;
  /** Rolled-up error count across the session's segments. */
  error_count: number;
  /** Rolled-up frustration-signal count (rage/dead/error click). */
  frustration_count: number;
  /** Last non-null `usr.id` seen across the session's segments (NULL = anonymous). */
  usr_id: string | null;
  /** Last non-null `usr.email` seen; backs the tenant-scoped username filter. */
  usr_email: string | null;
  /** Last non-null `usr.name` seen. */
  usr_name: string | null;
  /** Custom user attributes (non-standard `usr` keys) as a JSON string, or NULL. */
  usr_attributes: string | null;
  /** Device class parsed from the ingest User-Agent (Desktop/Mobile/Tablet/Bot/
   *  Other); first-non-null-wins across the session's segments. */
  device_type: string | null;
  /** Browser family parsed from the ingest User-Agent (Chrome/Safari/…). */
  browser: string | null;
  /** OS family parsed from the ingest User-Agent (Windows/macOS/iOS/…). */
  os: string | null;
  /** ISO 3166-1 alpha-2 country resolved from the ingest client IP, or NULL. */
  geo_country: string | null;
  /** Wall-clock the row was first created, `datetime('now')` UTC string. */
  first_seen_at: string;
  /** Wall-clock of the most recent rollup update, `datetime('now')` UTC string. */
  updated_at: string;
}

/**
 * A per-project RUM (real user monitoring) ingest client credential. The
 * `token_hash` (sha256 hex of a `rum_`-prefixed CSPRNG token) and indexed
 * `prefix` are stored; the plaintext token is returned only once at mint and is
 * never persisted. `revoked_at` soft-deletes. See `rum-clients-store.ts`.
 */
export interface RumClientRow {
  id: string;
  project_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: string;
  /** User id of the admin who minted the token, when known. */
  created_by: string | null;
  /** Last successful ingest auth (debounced); NULL until first use. */
  last_used_at: string | null;
  /** Set when revoked; NULL while active. */
  revoked_at: string | null;
}

/** Deployment Module — one deploy run (pipeline execution against a ref). */
export interface DeploymentRow {
  id: string;
  project_id: string;
  /** Environment name (matches a deploy.yaml env + a deployment_environments row). */
  environment: string;
  /** Git ref/sha being deployed. */
  ref: string;
  status: 'pending' | 'awaiting_approval' | 'running' | 'success' | 'error' | 'cancelled';
  /** How the deploy was triggered. Known v1 values: manual, push, rollback. */
  trigger: string;
  /** User id that triggered the deploy; NULL for system/push-driven runs. */
  triggered_by: string | null;
  /** For trigger='rollback': the historical deployment whose ref this run re-runs. */
  source_deployment_id: string | null;
  /** RunnerBackend job id once the orchestrator acquires a lease. */
  runner_job_id: string | null;
  /** Terminal failure message when status='error'. */
  error: string | null;
  /** Free-form JSON stash for forward-compat. */
  meta: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

/** Deployment Module — per-step state for a deploy run. */
export interface DeploymentStepRow {
  id: string;
  deployment_id: string;
  name: string;
  step_order: number;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'cancelled';
  exit_code: number | null;
  error: string | null;
  /** github_workflow step: dispatched GitHub Actions run id (NULL otherwise). */
  github_run_id: string | null;
  /** github_workflow step: dispatched GitHub Actions run URL (NULL otherwise). */
  github_run_url: string | null;
  /** github_workflow step: run conclusion (success/failure/…), NULL otherwise. */
  github_conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

/** Deployment Module — durable per-environment live-ref record + concurrency lock. */
export interface DeploymentEnvironmentRow {
  id: string;
  project_id: string;
  name: string;
  /** Ref currently live in this environment; NULL until the first success. */
  current_ref: string | null;
  /** Deployment that put current_ref live (last successful deploy). */
  current_deployment_id: string | null;
  /** Concurrency lock: in-flight deployment id, or NULL when idle. */
  active_deployment_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Deployment Module — operator-editable per-environment RUNTIME config
 * (multi-environment management, Phase 5). Keyed by (project_id,
 * environment_name); a missing row means "default" (enabled). deploy.yaml stays
 * the source of truth for which environments exist — this is the mutable-without-
 * a-commit layer the triggers / scheduling / notification-routing phases extend.
 */
export interface DeploymentEnvironmentRuntimeConfigRow {
  id: string;
  project_id: string;
  environment_name: string;
  /** Operator on/off switch. 1 = enabled (default), 0 = paused (retained). */
  enabled: number;
  /** Free-form JSON stash for forward-compat. */
  meta: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Deployment Module — operator-editable per-environment DEPLOY TRIGGER (the
 * triggers phase on top of the runtime-config layer). A trigger row fires a
 * deployment for its environment when a matching git event (`push`/`merge`)
 * updates a branch matching `branch_pattern`. Keyed by (project_id,
 * environment_name); zero-or-more rows per environment. deploy.yaml stays the
 * source of truth for which environments exist — a trigger whose environment was
 * removed is retained and simply never fires.
 */
export interface DeploymentEnvironmentTriggerRow {
  id: string;
  project_id: string;
  environment_name: string;
  /** Git event that fires this trigger. */
  event: 'push' | 'merge';
  /** Glob matched against the updated branch name. */
  branch_pattern: string;
  /** Operator on/off switch. 1 = enabled (default), 0 = paused (retained). */
  enabled: number;
  /** Free-form JSON stash for forward-compat. */
  meta: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Deployment Module — operator-editable per-environment DEPLOY SCHEDULE (the
 * scheduling phase on top of the runtime-config layer). A schedule row fires a
 * deployment for its environment when its node-cron expression ticks, running
 * under the owner identity. Keyed by (project_id, environment_name);
 * zero-or-more rows per environment. deploy.yaml stays the source of truth for
 * which environments exist — a schedule whose environment was removed is
 * retained and simply never fires.
 */
export interface DeploymentEnvironmentScheduleRow {
  id: string;
  project_id: string;
  environment_name: string;
  /** Git ref (branch / tag / sha) the schedule deploys. */
  ref: string;
  /** node-cron expression (validated at the write boundary). */
  cron: string;
  /** IANA timezone used to interpret the cron; null = server default. */
  timezone: string | null;
  /** Identity the scheduled run spawns under; null = system-owned / legacy. */
  owner_user_id: string | null;
  /** Operator on/off switch. 1 = enabled (default), 0 = paused (retained). */
  enabled: number;
  /** Free-form JSON stash for forward-compat. */
  meta: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Deployment Module — operator-editable per-environment NOTIFICATION ROUTING
 * (the notification-routing phase on top of the runtime-config layer). At most
 * one row per (project_id, environment_name); selects which release notification
 * types fire when a deployment to that environment succeeds. A missing row means
 * "default" (prod → both types on, non-prod → both off), resolved by name in the
 * store rather than persisted, so pre-routing prod-only behaviour is unchanged
 * until an operator opts a specific environment in or out.
 */
export interface DeploymentEnvironmentNotificationRoutingRow {
  id: string;
  project_id: string;
  environment_name: string;
  /** Fire the ticket_release (reporter) notification. 1 = on, 0 = off. */
  ticket_release_enabled: number;
  /** Fire the release_digest notification. 1 = on, 0 = off. */
  release_digest_enabled: number;
  /** Free-form JSON stash for forward-compat. */
  meta: string | null;
  created_at: string;
  updated_at: string;
}

/** Deployment Module — approver audit trail for gated environments. */
export interface DeploymentApprovalRow {
  id: string;
  deployment_id: string;
  approver_user_id: string;
  /** Org role held at approval time (Owner / Admin). */
  approver_role: string;
  decision: 'approved' | 'rejected';
  note: string | null;
  created_at: string;
}

export type DeploymentReleaseItemSource = 'derived' | 'operator';
export type DeploymentReleaseItemInclusionStatus = 'included' | 'excluded';

/** Deployment Module — cards/tickets included in a deployment release. */
export interface DeploymentReleaseItemRow {
  id: string;
  deployment_id: string;
  card_id: string;
  support_ticket_id: string | null;
  source: DeploymentReleaseItemSource;
  inclusion_status: DeploymentReleaseItemInclusionStatus;
  operator_adjusted_by: string | null;
  operator_adjustment_note: string | null;
  operator_adjustment_meta: string | null;
  operator_adjusted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentReleaseItemDetailRow extends DeploymentReleaseItemRow {
  card_title: string;
  card_short_id: number | null;
  card_priority: string | null;
  card_description: string | null;
  card_labels: string | null;
  card_column_name: string | null;
  support_ticket_subject: string | null;
  support_ticket_summary: string | null;
  support_ticket_status: string | null;
  support_ticket_type: string | null;
  support_ticket_reporter_email: string | null;
  support_ticket_fixed_at: string | null;
  support_ticket_released_to_prod_at: string | null;
  support_ticket_customer_notified_at: string | null;
}

export type ReleaseNotificationType = 'ticket_release' | 'release_digest';
export type ReleaseNotificationOutboxStatus = 'pending' | 'sending' | 'sent' | 'error';

export interface ReleaseNotificationOutboxRow {
  id: string;
  project_id: string;
  deployment_id: string;
  release_item_id: string | null;
  support_ticket_id: string | null;
  notification_type: ReleaseNotificationType;
  idempotency_key: string;
  recipient_email: string;
  subject: string;
  body_text: string;
  status: ReleaseNotificationOutboxStatus;
  attempts: number;
  sent_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
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
  /**
   * IANA timezone used to interpret the cron expression's wall-clock fields.
   * New UI-created rows set this from the user's local timezone so "0 9 * * *"
   * means 9am for that user even when the server host runs in UTC. Null keeps
   * older rows on the server/default scheduler timezone.
   */
  timezone: string | null;
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
   * `claude-sonnet-5`). When null, falls back to
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
  /**
   * Logical user id for the Hub user that created this cron. Scheduled runs use
   * it to build the spawn env so per-user CLI caches, including AWS SSO tokens,
   * resolve from the creator's HOME. Null for legacy/system-created crons.
   */
  owner_user_id: string | null;
  /**
   * Visibility toggle. 0 = private to owner plus org Owners, 1 = visible to
   * every org member. Execution still uses owner_user_id either way.
   */
  shared: number;
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
  /**
   * Set once the standalone design has been FULLY migrated into a design-mode
   * session (see server/design-import.ts). NULL = not yet imported. When set,
   * the design is read-only and the standalone routes redirect to this session.
   * Only ever references a completed import — an in-flight one uses `import_lock`.
   */
  imported_session_id: string | null;
  /**
   * In-progress import lock: the session id currently being imported, or NULL
   * when no import is running. Internal concurrency control; not the redirect
   * target (that's `imported_session_id`). Reclaimable after a stale timeout.
   */
  import_lock: string | null;
  /** When `import_lock` was acquired (datetime); drives stale-lock reclaim. */
  import_locked_at: string | null;
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

/**
 * Native pull request row (Agent Hub-hosted projects, `gitHost:
 * 'agenthub'`). Metadata lives here; diffs/files/merges are computed
 * against the hosted bare repo in `server/native-pr/`. Timestamps are
 * epoch ms — serialized to ISO at the API edge so responses stay
 * GitHub-shape-compatible for the existing client.
 */
export interface PullRequestRow {
  id: string;
  project_id: string;
  /** Per-project sequence allocated transactionally on insert. */
  number: number;
  title: string;
  body: string;
  head_branch: string;
  base_branch: string;
  head_sha: string;
  status: 'open' | 'merged' | 'closed';
  /** Hub user id who opened the pull request. */
  author: string;
  merged_sha: string | null;
  merged_by: string | null;
  merge_method: 'squash' | 'merge' | null;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  closed_at: number | null;
  /** Set when a human flagged the PR for review (cleared by approve/changes-requested). */
  review_requested_at: number | null;
  review_requested_by: string | null;
}

/** Inline (per-line) review comment on a native PR diff. */
export interface PullRequestCommentRow {
  id: string;
  project_id: string;
  pr_number: number;
  author: string;
  file_path: string;
  /** Line number on the chosen side of the diff. */
  line: number;
  side: 'old' | 'new';
  body: string;
  created_at: number;
}

/** Human review on a native PR (see pull_request_reviews DDL). */
export interface PullRequestReviewRow {
  id: string;
  project_id: string;
  pr_number: number;
  reviewer: string;
  state: 'approved' | 'changes_requested' | 'commented';
  body: string;
  created_at: number;
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
  source: 'project' | 'global' | 'default' | null;
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

/**
 * Per-user, project-scoped settings row (`user_project_settings`).
 * `user_id` is the JWT-resolved user id, or `'__local__'` in single-tenant
 * local mode. `default_finalize_automation` is one of the Finalize automation
 * levels (`manual` | `review` | `push` | `merge`), or NULL for "no preference".
 */
export interface UserProjectSettingsRow {
  user_id: string;
  project_id: string;
  default_finalize_automation: string | null;
  updated_at: string;
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
  /** Monotonic per-board counter backing card short ids. Only ever incremented. */
  card_seq: number;
  /** Persisted prefix for human card ids (the "AH" in "AH-123"). Frozen at board
   *  creation from the immutable project slug so renaming a project never
   *  rewrites already-shared card ids. NULL only on legacy rows before backfill;
   *  GET /board falls back to deriving from the slug in that case. */
  card_prefix: string | null;
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
  /** Org user id of the lead user for this card (distinct from agent assignee). */
  assigned_user_id?: string | null;
  labels: string | null;
  session_id: string | null;
  github_issue_url: string | null;
  /** Durable support ticket link for cards converted from customer support. */
  support_ticket_id?: string | null;
  /** Durable customer report link. Currently the support ticket id for support-ticket intake. */
  customer_report_id?: string | null;
  /** Capture provenance (spec CAPTURE-PROVENANCE). Shared triple with
   *  user_todos: the origin a card was captured from. `source_type` is one of
   *  manual|email|calendar|todo (todo = promoted from a personal todo), NULL for
   *  cards with no tracked origin. `source_meta` is the raw JSON deep-link blob
   *  on the row; the API serializer parses it to an object. */
  source_type?: 'manual' | 'email' | 'calendar' | 'todo' | 'log_issue' | null;
  source_id?: string | null;
  source_meta?: string | null;
  pr_url: string | null;
  review_status: 'awaiting_review' | 'reviewing' | 'approved' | 'changes_requested' | null;
  created_by: string | null;
  /** Human-readable per-board sequence number (the "123" in "AH-123"). Assigned
   *  on insert by the kanban_card_assign_short_id trigger. NULL only on legacy
   *  rows before backfill. */
  short_id: number | null;
  position: number;
  /** ISO timestamp the card entered a Done column (NULL = not completed).
   *  Maintained by the kanban_cards_set_completed_at_* triggers; drives the
   *  per-project Stats "tickets completed" bucketing. */
  completed_at?: string | null;
  epic_id: string | null;
  /** Optional phase subgroup within the parent epic. */
  phase_id?: string | null;
  /** `task` (default) or `spike` — spike cards resolve epic spec decisions. */
  card_kind?: string | null;
  documented: number;
  /** Set when autonomous dispatch claims a card — controls auto-PR at session end vs Create PR banner. */
  dispatched_by_autonomous: number;
  /** ISO timestamp set when the card's working session was closed/archived but
   *  the card had progressed too far to garbage-collect as an abandoned stub.
   *  NULL for live cards. See `server/card-orphan-cleanup.ts`. */
  orphaned_at?: string | null;
  /** Per-card auto-merge preference captured at assign / support-ticket-convert
   *  time. 1 = force auto-merge ("Auto Merge"), 0 = explicitly off ("Build and
   *  Push"), NULL/absent = no explicit preference (fall back to the project's
   *  `githubWorkflow.autoMerge`). Carries over from a converted support ticket
   *  so the board assign UI can pre-populate the checkbox. */
  auto_merge?: number | null;
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
  /** Derived lifecycle from linked cards. Null means the epic has no linked cards. */
  state: 'not_started' | 'in_progress' | 'done' | null;
  /** ISO timestamp the epic reached state='done' (NULL = not completed).
   *  Maintained by the kanban_epics_set_completed_at_* triggers; drives the
   *  per-project Stats "epics completed" bucketing. */
  completed_at?: string | null;
  /** Comma-separated tags (same shape as kanban card labels). */
  labels: string | null;
  /** Org user id of the lead user for this epic. */
  assigned_user_id?: string | null;
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
  /**
   * "Auto Merge" override for autonomous dispatch. When 1, sessions spawned for
   * cards under this epic start at finalize_automation `merge` ("Auto Merge")
   * regardless of the project's auto-merge config. When 0 (default / legacy),
   * dispatch keeps the existing behavior (`merge` only when project auto-merge
   * is on, else `push`).
   */
  autonomous_send_it?: number;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Reusable defaults for creating kanban cards on a board. */
export interface KanbanCardTemplateRow {
  id: string;
  board_id: string;
  name: string;
  title: string;
  description: string | null;
  priority: string;
  labels: string | null;
  epic_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

/** A phase within an epic — groups related tickets for a feature run or module. */
export interface KanbanPhaseRow {
  id: string;
  epic_id: string;
  board_id: string;
  name: string;
  description: string | null;
  position: number;
  autonomous: number;
  autonomous_interval: number;
  autonomous_max_concurrent: number;
  autonomous_model: string | null;
  autonomous_enabled_by?: string | null;
  autonomous_send_it?: number;
  autonomous_running?: number;
  created_at: string;
  updated_at: string;
}

/** Architecture decision for an epic — researched via spike ticket + session. */
export interface KanbanEpicSpecItemRow {
  id: string;
  epic_id: string;
  board_id: string;
  phase_id: string | null;
  tag: string;
  title: string;
  decision: string | null;
  status: 'open' | 'chosen' | 'deferred';
  position: number;
  spike_card_id: string | null;
  resolved_session_id: string | null;
  created_at: string;
  updated_at: string;
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

// ─── Support Tickets ────────────────────────────────────────────
// Customer support requests persisted in their OWN queue, separate from the
// kanban board. The status lifecycle is distinct from kanban columns:
// new → investigating → converted / closed / duplicate / wont_do. Severity
// drives list ordering. `new` and `investigating` are the "open" states shown
// by default; the rest are terminal and hidden until explicitly filtered for.

export type SupportTicketType = 'bug' | 'question' | 'feature_request' | 'incident' | 'other';
export type SupportTicketSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SupportTicketStatus =
  | 'new'
  | 'investigating'
  | 'converted'
  | 'closed'
  | 'duplicate'
  | 'wont_do';
export type SupportTicketReleaseState =
  | 'fixed_pending_release'
  | 'released_to_prod'
  | 'customer_notified';

export interface SupportTicketRow {
  id: string;
  project_id: string;
  type: SupportTicketType;
  severity: SupportTicketSeverity;
  status: SupportTicketStatus;
  subject: string;
  body: string;
  reporter: string | null;
  // Protected reporter contact. Route responses mask this for non-privileged
  // callers; store helpers and release notification jobs use the raw row.
  reporter_email: string | null;
  // AI-investigation fields — populated when an agent investigates the ticket.
  ai_summary: string | null;
  ai_investigation: string | null;
  ai_investigated_at: string | null;
  // Optional reference to a captured session replay attached to the ticket.
  replay_ref: string | null;
  // Optional server-relative ref to a screenshot the reporter attached
  // (/uploads/support-screenshot-<id>.<ext>).
  screenshot_ref: string | null;
  // Set when the ticket is promoted to a kanban card (status → 'converted').
  converted_card_id: string | null;
  // Operator-supplied reason a ticket was marked "wont_do". Required when the
  // status is 'wont_do'; null/cleared for every other status.
  wont_do_reason: string | null;
  // Release-facing lifecycle. Derived API state is:
  // fixed_pending_release when fixed_at is set,
  // released_to_prod when released_to_prod_at is set,
  // customer_notified when customer_notified_at is set.
  fixed_at: string | null;
  released_to_prod_at: string | null;
  release_deployment_id: string | null;
  customer_notified_at: string | null;
  // Timestamp a human first viewed the ticket, or null when still unread.
  // Drives the per-project unread counter on the Support sidebar item.
  read_at: string | null;
  // Timestamp the ticket reached a terminal/resolved status (converted/closed/
  // duplicate/wont_do); null while open. Maintained by the
  // support_tickets_set_resolved_at_* triggers; drives the per-project Stats
  // "support tickets resolved" bucketing.
  resolved_at: string | null;
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
  /**
   * `git_push` = report-only "CI on push" run against the default branch;
   * `pr_push` = PR-level CI fallback for an unvalidated PR head
   * (server/git-host/push-ci.ts).
   */
  trigger_source: 'ui_button' | 'agent_block' | 'git_push' | 'pr_push';
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
  /**
   * JSON-encoded array of ci.yaml v2 job ids to scope this run to, or
   * `null` for a normal run that exercises every job. Set only by the
   * "Run Tests" dropdown's single-job debug runs (mode is forced to
   * `'checks'`). A job-filtered run runs the selected jobs plus their
   * transitive `needs:` deps and is deliberately EXCLUDED from the
   * per-phase "Tested" / "Reviewed" pickers and from full-validation —
   * a partial run can never flip the branch to ready-to-push.
   */
  job_filter: string | null;
  /**
   * Persisted flake-recovery gate result (see `server/finalize/flake-recovery.ts`,
   * `serializeFlakeGate`/`parseFlakeGate`). NULL for a verified-`clean` run. For
   * a non-clean run it is a JSON-encoded gate object
   * `{ status: 'flake_recovered' | 'blocked', jobs: JobFlakeVerdict[], reason?: string }`
   * — `flake_recovered` lists the jobs that passed only on retry with no fixer
   * commit touching their code paths; `blocked` means the gate could not verify
   * the run is clean (missing/unreadable history, unresolved diff range). A bare
   * legacy verdict array is still accepted defensively on read. Any non-NULL
   * value blocks auto-push / auto-merge — a human must push manually to
   * acknowledge.
   */
  flake_recovered_jobs: string | null;
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
  /** Terminal green for report-only push-CI runs (trigger_source 'git_push') — no push step follows. */
  | 'succeeded'
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
  /**
   * Where this step's CI output blob lives in the finalize log store. NULL for
   * legacy rows whose output was streamed into `messages` (the step-output
   * route falls back to scanning session messages for those).
   */
  log_storage_kind: string | null;
  log_storage_bucket: string | null;
  log_storage_region: string | null;
  log_key: string | null;
  /** Total lines the step emitted (may exceed the stored slice). */
  log_lines: number | null;
  /** 1 when stored output was truncated at the byte cap, else 0/NULL. */
  log_truncated: number | null;
  /**
   * Per-execution nonce stamped when this step's current execution started.
   * Woven into the blob key and used to guard the attach UPDATE so a stale
   * upload from an earlier attempt can't reattach onto a re-executed row.
   */
  log_attempt: string | null;
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
 * Per-round job/matrix retry history. {@link FinalizeRunJobRow} keeps only the
 * latest state per instance; this table appends one row per `loop_round` so
 * the flake-recovery classifier can see "failed round N, passed round M".
 */
export interface FinalizeRunJobAttemptRow {
  run_id: string;
  job_id: string;
  matrix_key: string;
  /** 1-indexed loop_round the observation belongs to. */
  round: number;
  state: FinalizeRunJobState;
  exit_code: number | null;
  /** Post-rebase HEAD the round validated against. */
  head_sha: string | null;
  recorded_at: number | null;
}

/**
 * Cross-run per-instance flake history. One row per (run, job instance)
 * collapsing the run's per-round attempts into a final state + whether the
 * instance flaked within the run. Project-scoped so the flake-rate computation
 * can read an instance's history across runs. See server/finalize/flake-history.ts.
 */
export interface FinalizeTestHistoryRow {
  run_id: string;
  project_id: string;
  job_id: string;
  matrix_key: string;
  branch: string | null;
  head_sha: string | null;
  final_state: 'passed' | 'failed';
  /** 1 when the instance failed an earlier round then passed a later one. */
  flaked: number;
  recorded_at: number;
}

/**
 * Quarantine-lane row. A flaky job instance that still runs but no longer
 * blocks the push gate. Time-bounded (≤30 days) with a named owner. See
 * server/finalize/quarantine.ts.
 */
export interface FinalizeQuarantineRow {
  id: string;
  project_id: string;
  job_id: string;
  matrix_key: string;
  owner: string;
  reason: string | null;
  quarantined_at: number;
  expires_at: number;
  created_by: string | null;
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
  // Artifacts (session-generated documents)
  insertArtifact: Stmt;
  getArtifactsBySession: Stmt;
  countArtifactsBySession: Stmt;
  getArtifact: Stmt;
  deleteArtifact: Stmt;
  // Session replays (record-on-error rrweb captures)
  insertSessionReplay: Stmt;
  getSessionReplay: Stmt;
  getSessionReplaysByProject: Stmt;
  getSessionReplayByCard: Stmt;
  linkSessionReplay: Stmt;
  updateSessionReplayStats: Stmt;
  updateSessionReplayStatsForAppend: Stmt;
  deleteSessionReplay: Stmt;
  /** Select expired, UNLINKED replays (created_at < cutoff) for retention GC.
   *  Params: (cutoff, now, limit) — flagged rows with a future retained_until are
   *  excluded. */
  getExpiredUnlinkedSessionReplays: Stmt;
  /** Per-project variant of {@link getExpiredUnlinkedSessionReplays} for a
   *  tenant with a BASE retention override. Params: (cutoff, now, projectId,
   *  limit). */
  getExpiredUnlinkedSessionReplaysByProject: Stmt;
  /** Flag / re-flag a replay for extended retention. Params:
   *  (retained_until, retention_flagged_at, id). */
  flagSessionReplayRetention: Stmt;
  /** Clear a replay's extended-retention flag. Params: (id). */
  clearSessionReplayRetention: Stmt;
  // replay_playlists — named groups of saved captures (replay-playlist-store.ts)
  insertReplayPlaylist: Stmt;
  getReplayPlaylist: Stmt;
  listReplayPlaylistsByProject: Stmt;
  updateReplayPlaylist: Stmt;
  deleteReplayPlaylist: Stmt;
  /** Flag a playlist for extended retention. Params:
   *  (retained_until, retention_flagged_at, id). */
  flagReplayPlaylistRetention: Stmt;
  /** Clear a playlist's extended-retention flag. Params: (id). */
  clearReplayPlaylistRetention: Stmt;
  insertReplayPlaylistItem: Stmt;
  getReplayPlaylistItem: Stmt;
  listReplayPlaylistItems: Stmt;
  /** Count of members whose capture still exists (inner-join to session_replays).
   *  Params: (playlistId). */
  countReplayPlaylistItems: Stmt;
  listReplayPlaylistItemIds: Stmt;
  deleteReplayPlaylistItem: Stmt;
  /** Reap all playlist memberships for a hard-deleted capture. Params: (replayId). */
  deleteReplayPlaylistItemsByReplay: Stmt;
  maxReplayPlaylistItemPosition: Stmt;
  // rum_segments — append-only segment manifest (segment-store.ts)
  insertRumSegment: Stmt;
  getRumSegment: Stmt;
  listRumSegmentsBySession: Stmt;
  listRumSegmentsByView: Stmt;
  deleteRumSegment: Stmt;
  deleteRumSegmentsBySession: Stmt;
  // rum_sessions — session-grain rollup row (rum-session-store.ts)
  insertRumSession: Stmt;
  getRumSession: Stmt;
  updateRumSessionRollup: Stmt;
  listRumSessionsByProject: Stmt;
  deleteRumSession: Stmt;
  // Segmented-replay index-row TTL reconciliation (rum-segment-retention-sweeper.ts)
  getExpiredRumSessions: Stmt;
  /** Per-project variant of {@link getExpiredRumSessions} for a tenant with a
   *  BASE retention override. Params: (cutoff, projectId, limit). */
  getExpiredRumSessionsByProject: Stmt;
  deleteExpiredRumSession: Stmt;
  getExpiredOrphanRumSegments: Stmt;
  /** Per-project variant of {@link getExpiredOrphanRumSegments} for a tenant with
   *  a BASE retention override. Params: (cutoff, projectId, limit). */
  getExpiredOrphanRumSegmentsByProject: Stmt;
  // Per-project RUM ingest clients
  insertRumClient: Stmt;
  getRumClient: Stmt;
  getRumClientByPrefixHash: Stmt;
  listRumClientsByProject: Stmt;
  revokeRumClient: Stmt;
  touchRumClientLastUsed: Stmt;
  // Deployment Module (deployments / steps / environments / approvals)
  insertDeployment: Stmt;
  getDeployment: Stmt;
  listDeploymentsByProject: Stmt;
  listDeploymentsByEnvironment: Stmt;
  updateDeploymentStatus: Stmt;
  setDeploymentRunnerJob: Stmt;
  setDeploymentMeta: Stmt;
  insertDeploymentStep: Stmt;
  getDeploymentStep: Stmt;
  listDeploymentSteps: Stmt;
  updateDeploymentStepStatus: Stmt;
  setDeploymentStepGithubRun: Stmt;
  upsertDeploymentEnvironment: Stmt;
  getDeploymentEnvironment: Stmt;
  listDeploymentEnvironments: Stmt;
  upsertDeploymentEnvRuntimeConfig: Stmt;
  getDeploymentEnvRuntimeConfig: Stmt;
  listDeploymentEnvRuntimeConfig: Stmt;
  deleteDeploymentEnvRuntimeConfig: Stmt;
  insertDeploymentEnvTrigger: Stmt;
  updateDeploymentEnvTrigger: Stmt;
  getDeploymentEnvTrigger: Stmt;
  listDeploymentEnvTriggersForProject: Stmt;
  listDeploymentEnvTriggersForEnvironment: Stmt;
  listEnabledDeploymentEnvTriggersForEvent: Stmt;
  deleteDeploymentEnvTrigger: Stmt;
  insertDeploymentEnvSchedule: Stmt;
  updateDeploymentEnvSchedule: Stmt;
  getDeploymentEnvSchedule: Stmt;
  listDeploymentEnvSchedulesForProject: Stmt;
  listDeploymentEnvSchedulesForEnvironment: Stmt;
  listEnabledDeploymentEnvSchedules: Stmt;
  deleteDeploymentEnvSchedule: Stmt;
  upsertDeploymentEnvNotificationRouting: Stmt;
  getDeploymentEnvNotificationRouting: Stmt;
  listDeploymentEnvNotificationRouting: Stmt;
  deleteDeploymentEnvNotificationRouting: Stmt;
  acquireDeploymentEnvironmentLock: Stmt;
  releaseDeploymentEnvironmentLock: Stmt;
  setDeploymentEnvironmentCurrentRef: Stmt;
  claimDeploymentForApproval: Stmt;
  insertDeploymentApproval: Stmt;
  listDeploymentApprovals: Stmt;
  getScopedDeploymentReleaseCard: Stmt;
  getScopedDeploymentReleaseTicket: Stmt;
  insertDeploymentReleaseItem: Stmt;
  getDeploymentReleaseItem: Stmt;
  getDeploymentReleaseItemByDeploymentCard: Stmt;
  updateDeploymentReleaseItemTicket: Stmt;
  updateDeploymentReleaseItemAdjustment: Stmt;
  listDeploymentReleaseItems: Stmt;
  listDeploymentReleaseItemsWithContext: Stmt;
  insertReleaseNotificationOutbox: Stmt;
  getReleaseNotificationOutboxById: Stmt;
  getReleaseNotificationOutboxByKey: Stmt;
  listReleaseNotificationOutboxByDeployment: Stmt;
  listReleaseNotificationOutboxBySupportTicket: Stmt;
  listRetryEligibleReleaseNotificationOutbox: Stmt;
  retryReleaseNotificationOutbox: Stmt;
  markReleaseNotificationOutboxSending: Stmt;
  markReleaseNotificationOutboxSent: Stmt;
  markReleaseNotificationOutboxError: Stmt;
  markReleaseNotificationOutboxDeliveryError: Stmt;
  // Sessions
  createSession: Stmt;
  getSessions: Stmt;
  getSession: Stmt;
  getRecentLiveSessions: Stmt;
  updateSessionName: Stmt;
  updateSessionNameWithTitleSource: Stmt;
  updateAutoSessionNameIfCurrent: Stmt;
  updateSessionMaxTurns: Stmt;
  updateSessionLinkedDesign: Stmt;
  updateSessionLinkedEpic: Stmt;
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
  getUserProjectSettings: Stmt;
  upsertUserProjectDefaultFinalizeAutomation: Stmt;
  updateSessionState: Stmt;
  updateSessionLastTurnError: Stmt;
  incrementSessionResumeAttempts: Stmt;
  resetSessionResumeAttempts: Stmt;
  updateSessionWorktree: Stmt;
  updateSessionWorktreePath: Stmt;
  setSessionResolvePrHeadBranch: Stmt;
  setSessionWorktreeCheckoutBranch: Stmt;
  updateSessionGitWorktreeDetected: Stmt;
  updateSessionAskMode: Stmt;
  updateSessionReactLoop: Stmt;
  updateSessionMode: Stmt;
  updateSessionReasoningEffort: Stmt;
  updateSessionChangesReady: Stmt;
  updateSessionCodeChangedAt: Stmt;
  updateSessionWikiHybridRagConsumed: Stmt;
  updateSessionWikiHybridRagBudget: Stmt;
  updateSessionWebSearchCallsUsed: Stmt;
  updateSessionCodeRagConsumed: Stmt;
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
  /**
   * Like `addMessage` but with an explicit `created_at` (last param). Used by
   * the Design Studio → design-mode session importer to replay
   * `design_messages` while preserving their original timestamps so the
   * imported transcript keeps its order under `getMessages` (ORDER BY
   * created_at ASC).
   */
  addMessageWithCreatedAt: Stmt;
  getMessages: Stmt;
  getMessagesPageLatest: Stmt;
  getMessagesPageBeforeId: Stmt;
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
  backfillCronOwners: Stmt;
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
  /**
   * Design-import concurrency control. `imported_session_id` is published only
   * on full completion (`completeDesignImport`); an in-flight import holds
   * `import_lock` instead, so concurrent callers never see a half-built import
   * as "done". See server/design-import.ts.
   */
  clearStaleImportedSession: Stmt;
  acquireDesignImportLock: Stmt;
  completeDesignImport: Stmt;
  releaseDesignImportLock: Stmt;
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
  getKanbanCardsByColumnPageFirst: Stmt;
  getKanbanCardsByColumnPageAfter: Stmt;
  countKanbanCardsByColumn: Stmt;
  getKanbanCard: Stmt;
  createKanbanCard: Stmt;
  linkKanbanCardSupportTicket: Stmt;
  setKanbanCardProvenance: Stmt;
  getLinkedSupportTicketsForBoard: Stmt;
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
  getKanbanCardByLogIssueSource: Stmt;
  getSessionIdsByWorktreeBranch: Stmt;
  getKanbanCardByPrUrl: Stmt;
  getNextUndocumentedCard: Stmt;
  markCardDocumented: Stmt;
  deleteKanbanCard: Stmt;
  markKanbanCardOrphaned: Stmt;
  setKanbanCardAutoMerge: Stmt;
  setKanbanCardAssignedUser: Stmt;
  setKanbanCardsAssignedUserByEpic: Stmt;

  // Kanban card comments
  getKanbanCardComments: Stmt;
  createKanbanCardComment: Stmt;
  deleteKanbanCardComment: Stmt;

  // Card blockers (card-to-card dependencies)
  getBlockersForBoard: Stmt;
  getBlockersForCard: Stmt;
  countBlockerEdgesForCard: Stmt;
  getBlocker: Stmt;
  createBlocker: Stmt;
  deleteBlocker: Stmt;

  // Kanban epics
  getKanbanEpics: Stmt;
  getKanbanEpic: Stmt;
  createKanbanEpic: Stmt;
  updateKanbanEpic: Stmt;
  updateKanbanEpicState: Stmt;
  setEpicAutonomousEnabledBy: Stmt;
  setEpicAutonomousSendIt: Stmt;
  setKanbanEpicAssignedUser: Stmt;
  getKanbanCardTemplates: Stmt;
  getKanbanCardTemplate: Stmt;
  createKanbanCardTemplate: Stmt;
  updateKanbanCardTemplate: Stmt;
  deleteKanbanCardTemplate: Stmt;
  clearKanbanCardTemplateEpic: Stmt;
  deleteKanbanEpic: Stmt;
  getKanbanCardsByEpic: Stmt;
  updateKanbanCardEpic: Stmt;
  updateKanbanCardPhase: Stmt;
  getKanbanPhases: Stmt;
  getKanbanPhasesByEpic: Stmt;
  getKanbanPhase: Stmt;
  createKanbanPhase: Stmt;
  updateKanbanPhase: Stmt;
  setPhaseAutonomousEnabledBy: Stmt;
  setPhaseAutonomousSendIt: Stmt;
  setPhaseAutonomousRunning: Stmt;
  setKanbanPhasePosition: Stmt;
  deleteKanbanPhase: Stmt;
  getKanbanCardsByPhase: Stmt;
  getKanbanSpecItems: Stmt;
  getKanbanSpecItemsByEpic: Stmt;
  getKanbanSpecItem: Stmt;
  getKanbanSpecItemBySpikeCard: Stmt;
  countOpenKanbanSpecItemsByEpic: Stmt;
  countOpenKanbanSpecItemsByPhase: Stmt;
  createKanbanSpecItem: Stmt;
  updateKanbanSpecItem: Stmt;
  setKanbanSpecItemSpikeCard: Stmt;
  deleteKanbanSpecItem: Stmt;
  setKanbanCardKind: Stmt;
  updateSessionLinkedSpecItem: Stmt;
  getAutonomousPhases: Stmt;
  getEligibleAutonomousCardsByPhase: Stmt;
  getEligibleAutonomousSpikeCardsByPhase: Stmt;
  getEligibleAutonomousSpikeCards: Stmt;
  getAutonomousEpic: Stmt;
  getAutonomousEpics: Stmt;
  getEligibleAutonomousCards: Stmt;
  markCardDispatchedByAutonomous: Stmt;

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

  // Code embeddings (code-RAG)
  getCodeChunkRowidsByFile: Stmt;
  deleteCodeChunksByFile: Stmt;
  deleteCodeFtsByRowid: Stmt;
  insertCodeChunk: Stmt;
  insertCodeFts: Stmt;
  getCodeEmbeddingsByProject: Stmt;
  getCodeFileHashes: Stmt;
  getDistinctCodeFiles: Stmt;
  countCodeChunksByProject: Stmt;

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

  // Support tickets
  createSupportTicket: Stmt;
  getSupportTicket: Stmt;
  listSupportTicketsByProject: Stmt;
  listSupportTicketsByProjectAndStatus: Stmt;
  updateSupportTicketStatus: Stmt;
  updateSupportTicketType: Stmt;
  updateSupportTicketInvestigation: Stmt;
  setSupportTicketReplayRef: Stmt;
  setSupportTicketScreenshotRef: Stmt;
  setSupportTicketBody: Stmt;
  setSupportTicketWontDoReason: Stmt;
  convertSupportTicketToCard: Stmt;
  markSupportTicketRead: Stmt;
  markSupportTicketUnread: Stmt;
  markAllSupportTicketsRead: Stmt;
  countUnreadSupportTickets: Stmt;
  deleteSupportTicket: Stmt;
  deleteSupportTicketsByProject: Stmt;

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
  selectStuckActiveFinalizeRunsOnBoot: Stmt;
  countInterruptedFinalizeRunsForSessionHead: Stmt;
  failStuckActiveFinalizeRunsOnBoot: Stmt;
  failStuckActiveFinalizeRunStepsOnBoot: Stmt;
  selectRuntimeStuckFinalizeRunCandidates: Stmt;
  failRuntimeStuckFinalizeRun: Stmt;
  failRuntimeStuckFinalizeRunSteps: Stmt;
  markFinalizeRunSupersededByBootRetrigger: Stmt;
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
  getPushedFinalizeRunForSession: Stmt;
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
   * All **non-terminal** `finalize_runs` rows that have a `session_id`,
   * newest first. "Non-terminal" excludes the six terminal statuses
   * (`pushed`, `failed`, `timed_out`, `infra_error`, `cancelled`,
   * `stalled_no_response`) but INCLUDES the parked `ready_to_push` state.
   *
   * Used by the WebSocket connect handler to build a finalize
   * connect-snapshot (see `server/finalize/finalize-snapshot.ts`): every
   * (re)connection re-emits a `finalize_run_phase_changed` event per active
   * run so the client converges its checks block / button to the server's
   * truth, independent of which live events were missed while the socket
   * was down — the server-side counterpart to the client reconnect refetch.
   */
  getActiveFinalizeRuns: Stmt;
  /**
   * Most-recent in-flight `finalize_runs` row for a session + branch +
   * job-filter tuple, regardless of head SHA or mode. Used at kickoff time
   * to prevent review-only, checks-only, and full Finalize cycles from
   * competing over the same worktree lane.
   */
  getActiveFinalizeRunForSessionBranch: Stmt;
  /** Claim a short-lived Finalize kickoff slot before async orchestration setup. */
  insertFinalizeKickoffClaim: Stmt;
  /** Release a short-lived Finalize kickoff slot after the row is visible or kickoff aborts. */
  deleteFinalizeKickoffClaim: Stmt;
  /** Remove abandoned kickoff claims from crashed or killed kickoff attempts. */
  pruneStaleFinalizeKickoffClaims: Stmt;
  /**
   * Latest `finalize_runs` row for every session referenced by cards on a
   * given kanban board. Returns 0..N rows (one per distinct
   * `session_id` that has any finalize history). The board route
   * builds a `Map<session_id, FinalizeRunRow>` from this and attaches
   * each row to the matching card, avoiding the per-card REST fan-out
   * the v0 surface had. Bound by `(boardId)`.
   */
  listLatestFinalizeRunsForBoard: Stmt;
  /**
   * Atomically claim a ready-to-push run for the GitHub push phase. The claim
   * allows only one active push per session and only one completed push per
   * validated head. Returns changes=1 for the single caller that won the claim
   * and changes=0 for duplicate clicks / automation races / sibling rows for
   * the same validated head.
   */
  claimFinalizeRunPush: Stmt;
  /**
   * Find another run for this session that already owns a push, or completed
   * the push for the same validated head. Used after `claimFinalizeRunPush`
   * returns changes=0 to decide whether to report an in-flight push or reuse
   * the existing PR.
   */
  getFinalizePushPeerForSessionHead: Stmt;
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
  /**
   * Terminal-reconcile: flip one run's still-in-flight (`queued`/`running`)
   * step row to terminal `skipped`. Used by
   * `reconcileFinalizeRunTerminalSteps` to clear sibling shards stranded when a
   * v2 matrix run went terminal on the first shard failure. No-op (zero rows)
   * for an already-terminal step.
   */
  markFinalizeRunStepSkippedIfPending: Stmt;
  /**
   * Terminal-reconcile: backfill `failed_step_index/name/exit_code` on a run
   * row from the first `failed` step. `failFinalizeRun` leaves them NULL.
   * Guarded on `failed_step_index IS NULL` so it is idempotent.
   */
  backfillFinalizeRunFailedStep: Stmt;
  /**
   * Boot-recovery: backfill the failed-step summary for every terminal-failed
   * run whose summary is still NULL but which has a `failed` step row. Catches
   * runs left inconsistent by a crash / premature shard-terminal write.
   */
  backfillFinalizeRunFailedStepsOnBoot: Stmt;
  getFinalizeRunStep: Stmt;
  beginFinalizeRunStepAttempt: Stmt;
  attachFinalizeRunStepLog: Stmt;
  finishFinalizeRunStepIfAttempt: Stmt;
  upsertFinalizeRunJob: Stmt;
  listFinalizeRunJobsForRun: Stmt;
  upsertFinalizeRunJobAttempt: Stmt;
  listFinalizeRunJobAttemptsForRun: Stmt;
  setFinalizeRunFlakeRecoveredJobs: Stmt;
  // finalize_test_history — cross-run per-instance flake history.
  upsertFinalizeTestHistory: Stmt;
  listFinalizeTestHistoryForProject: Stmt;
  // finalize_quarantine — flaky-test quarantine lane.
  upsertFinalizeQuarantine: Stmt;
  listFinalizeQuarantineForProject: Stmt;
  getFinalizeQuarantineById: Stmt;
  deleteFinalizeQuarantine: Stmt;

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
  /** Per-job resource metric rows (peak mem + peak CPU) for one finalize run. */
  listFinalizeJobResourcesByRun: Stmt;
  /**
   * Finalize↔GitHub parity harness — upsert one observation keyed on
   * (project_id, commit_sha). Binds the full column tuple
   * `(id, project_id, pr_number, commit_sha, run_id, finalize_verdict,
   * finalize_jobs, github_verdict, github_jobs, divergence_class, note,
   * observed_at)`. See `server/finalize/parity-store.ts`.
   */
  upsertFinalizeParity: Stmt;
  /** Fetch a single parity row by `(project_id, commit_sha)`. */
  getFinalizeParityByCommit: Stmt;
  /**
   * Range scan over parity rows in (project, window), newest first. Binds
   * `(project_id, from_inclusive_ms, to_exclusive_ms)`.
   */
  listFinalizeParityInRange: Stmt;

  // ── pull_requests — native PRs for Agent Hub-hosted projects ──────
  /** Insert an open PR row. Number allocation must be transactional — see `server/native-pr/store.ts`. */
  insertPullRequest: Stmt;
  /** `SELECT COALESCE(MAX(number), 0)` for per-project number allocation. */
  maxPullRequestNumberForProject: Stmt;
  getPullRequestByNumber: Stmt;
  /** Params: (project_id, state, state, state, limit) where state ∈ 'open'|'closed'|'all'. */
  listPullRequestsForProject: Stmt;
  /** Newest open PR for (project_id, head_branch) — finalize idempotent reuse. */
  getOpenPullRequestByHeadBranch: Stmt;
  /** Refresh head_sha/title/body on reuse. Params: (head_sha, title, body, updated_at, id). */
  updatePullRequestHead: Stmt;
  /** Title/body edit (open PRs only). Params: (title, body, updated_at, id). */
  updatePullRequestText: Stmt;
  /** Guarded `status='open'` → 'merged' transition. */
  markPullRequestMerged: Stmt;
  /** Guarded `status='open'` → 'closed' transition. */
  markPullRequestClosed: Stmt;
  /** Guarded `status='closed'` → 'open' transition (merged stays closed). */
  markPullRequestReopened: Stmt;
  /** Review-request flag. Params: (requested_at|null, requested_by|null, updated_at, id). */
  setPullRequestReviewRequested: Stmt;
  /** Insert a human review row. Params: (id, project_id, pr_number, reviewer, state, body, created_at). */
  insertPullRequestReview: Stmt;
  listPullRequestReviewsForPr: Stmt;
  /** Inline diff comment. Params: (id, project_id, pr_number, author, file_path, line, side, body, created_at). */
  insertPullRequestComment: Stmt;
  listPullRequestCommentsForPr: Stmt;
  getPullRequestComment: Stmt;
  deletePullRequestComment: Stmt;
  /** Fully-validated finalize run for (project, branch, sha) — PR validation passthrough. */
  getValidatedFinalizeRunForSha: Stmt;
  /** Latest run carrying CI jobs for (project, sha, sha) — PR checks display. */
  getLatestFinalizeRunForSha: Stmt;
  /** All runs for (project, sha, sha) newest first — per-job merge for PR checks. */
  listFinalizeRunsForSha: Stmt;
  /** Run-history list (Runners page). Params: (project_id, trigger, trigger, limit) — trigger 'all' disables the filter. */
  listFinalizeRunsForProject: Stmt;
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
  /**
   * Logical user id for the Hub user that owns this heartbeat. Scheduled runs
   * use this to build the spawn env so per-user CLI caches and subscriptions
   * resolve from the creator's HOME. Null/undefined for legacy rows before
   * route-level backfill.
   */
  owner_user_id?: string | null;
  /**
   * Visibility toggle. 0/false = private to owner plus org Owners,
   * 1/true = visible to every org member. Execution still uses owner_user_id.
   */
  shared?: number | boolean;
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
  /**
   * Per-agent skill allowlist. When set to an array, only these skill ids are
   * listed in the agent's Available Skills prompt block and only these may be
   * loaded via the `<agenthub:skill>` trigger — every other skill fails to
   * load with a clear error. When `undefined` (the default), the agent sees
   * and can trigger every project + bundled skill (restriction is opt-in, so
   * existing agents are unchanged). An empty array means no skills at all.
   */
  allowedSkills?: string[];
  hooks?: Record<string, HookConfig[]>;
  mcpServers?: Record<string, McpServerConfig>;
  installCommand?: string;
  reviewer?: string;
  canReview?: boolean;
  /**
   * "Dev" flag — does this agent accept autonomously-dispatched kanban
   * tickets? When explicitly `false`, the autonomous dispatcher never routes
   * a card to this agent. New agents created through the UI default to
   * `false`. `undefined` preserves the pre-flag behaviour (eligible), so
   * existing rosters keep dispatching. Agents whose `role` is a default Dev
   * role (`dev` / `lead`) are always eligible regardless of this field, and
   * out-of-band roles (`docs` / `reviewer`) are never eligible —
   * see `agentAcceptsAutonomousTickets` in `server/agent-autonomy.ts`.
   */
  isDev?: boolean;
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
 * Host-level fields (preview host, base URL, port range, Route 53 zone) live
 * on the singleton `pr_env_config` row.
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
  /**
   * Optional dev-server config: the project runs as a managed long-lived
   * process started from `startCommand` (default `npm run dev`) inside the
   * session env, with the Hub owning start/stop/restart, log streaming,
   * env/secret injection, and port mapping through the authenticated
   * preview proxy. Replaces the compose app-wrapping model for session
   * previews; independent of the parent `enabled` flag (which gates the
   * PR-env runner only), same as `preview`.
   *
   * Secrets are key references into the project-secrets store
   * (`secretKeys[]`) — plaintext values never live in this block. Schema +
   * validation in `dev-server-config.ts`.
   */
  devServer?: DevServerConfig;
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
   * Optional compose metadata for the project's backing services. The
   * managed app process belongs in `devServer.startCommand`; it may run
   * `docker compose up -d --wait db redis` before starting the app.
   *
   * Existing configs that contain `entryService` and `entryPort` receive a
   * one-release compatibility fallback through the legacy compose runtime.
   * New configs must omit those app-wrapping fields.
   */
  compose?: PreviewComposeConfig;
}

/**
 * Docker-compose preview orchestration sub-config attached to
 * {@link PrEnvPreviewConfig}.
 *
 * Compose metadata for backing services (Postgres, Redis, etc.) used by a
 * managed dev server. The Hub does not run the app as a compose entry
 * service. The project's `devServer.startCommand` owns the compose command
 * and app startup lifecycle.
 *
 * `entryService` and `entryPort` are deprecated compatibility fields. They
 * are accepted for one release so existing projects can migrate; when both
 * are present the temporary legacy compose app-wrapping fallback is used.
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
   * @deprecated App-wrapping compatibility field. Omit for services-only
   * compose metadata.
   */
  entryService?: string;
  /**
   * @deprecated App-wrapping compatibility field. Required together with
   * `entryService` only for the one-release fallback.
   */
  entryPort?: number;
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
   * has room. Bounded 5000..3600000 (5 s – 60 min) at config save time.
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
  /**
   * Which host is the canonical git remote for this project. Absent or
   * `'github'` = legacy behavior (origin → GitHub, PRs via `gh`/REST).
   * `'agenthub'` = the Hub hosts the canonical bare repo under
   * `<dataDir>/git/<projectId>.git` (see `server/git-host/repo-store.ts`),
   * session pushes land there, and PRs are native Hub entities
   * (`server/native-pr/`). State transitions happen ONLY via the
   * git-host enable/disable routes — they have filesystem side effects
   * (bare repo creation, cwd origin rewrite) — so the projects PATCH
   * endpoint rejects direct writes to this field.
   */
  gitHost?: 'agenthub' | 'github';
  /**
   * One-way Hub → GitHub mirror policy for `gitHost: 'agenthub'` projects.
   * `refs: 'default-branch'` (default) pushes only the default branch (+
   * tags) after it moves — enough to keep GitHub Actions/deploys working.
   * `'all'` mirrors every branch. Mirror failures never block Hub pushes;
   * see `server/git-host/mirror.ts`.
   */
  gitMirror?: { enabled?: boolean; refs?: 'default-branch' | 'all' };
  /**
   * "CI on push" for Agent Hub-hosted projects: when enabled and the
   * default branch moves (smart-HTTP push or native PR merge), the repo's
   * `.agent-hub/ci.yaml` (version 2) jobs run against the new commit and
   * results land in finalize_runs with `trigger_source: 'git_push'` —
   * report-only (no reviewer / fix-dispatch / push step). See
   * `server/git-host/push-ci.ts` and the Runners settings section.
   */
  ciOnPush?: { enabled?: boolean };
  /**
   * Dependabot-style auto-PR for the dependency security audit (Agent
   * Hub-hosted projects only). When `enabled`, a scan that persists findings
   * (default-branch tip, not a dry run) opens/refreshes one native Hub PR per
   * fixable advisory: a branch bumping the vulnerable package to its fixed
   * version in `package-lock.json` (+ the sibling `package.json` range).
   * Open bump PRs are de-duped by deterministic branch name. Default off.
   * See `server/security-audit/auto-pr.ts`.
   *
   * - `autoMerge`: after a bump PR is opened, carry it through Finalize (a
   *   resolve-PR session at automation level `merge`) and auto-merge it when
   *   the `.agent-hub/ci.yaml` gate passes. Default off. Requires `actorUserId`
   *   to be set — unattended scans (scheduled / on-push) have no human to
   *   attribute the PR + session + merge to, so auto-merge stays OFF until one
   *   is configured. See `server/security-audit/actor-user.ts`.
   * - `actorUserId`: the Hub user that UNATTENDED security automation acts as —
   *   it authors the bump PR, owns the resolve-PR session, and triggers
   *   Finalize/merge. Must be an Admin/Owner member of the project's org
   *   (merge rights). A manual Autofix click still attributes to the clicking
   *   user regardless of this field.
   */
  securityAutoPr?: { enabled?: boolean; autoMerge?: boolean; actorUserId?: string };
  /**
   * Automatic triggers for the dependency security audit (Agent Hub-hosted
   * projects only). Both default off — the audit otherwise only runs from the
   * manual `POST /security-audit/scan` endpoint.
   * - `onPush`: re-scan when the default branch moves (smart-HTTP push or
   *   native PR merge). See `server/security-audit/on-push.ts`.
   * - `schedule`: periodic re-scan cadence (`daily` | `weekly`; `off`/unset =
   *   no scheduled scan). See `server/security-audit/scheduled-scan.ts`.
   * Both respect suppressions and open a kanban card only when the scan
   * surfaces new/reopened findings.
   */
  securityScan?: { onPush?: boolean; schedule?: 'off' | 'daily' | 'weekly' };
  /**
   * Operator-configured extra redaction for customer log ingest (decision
   * LOG-TRUST). Folded onto the built-in secret key/value patterns before a
   * record is persisted (see `server/logs/log-redaction.ts`).
   * - `redactKeys`: extra attribute-key substrings whose value is always dropped.
   * - `redactPatterns`: extra JS regex sources; secret-looking substrings that
   *   match are masked. An invalid pattern is skipped (never breaks ingest).
   */
  logIngest?: { redactKeys?: string[]; redactPatterns?: string[] };
  /**
   * Per-project session-replay policy, server-delivered to recorders and the
   * admin UI (replaces the legacy per-browser localStorage sample rate so the
   * policy applies to ALL users on the project, not whoever flipped their own
   * toggle). See `server/replays/replay-config.ts`.
   * - `sampleRate`: continuous-tier session sample rate in [0, 1]. Unset =
   *   the recorder keeps its built-in default (legacy on-error capture stays
   *   on); a set value is authoritative for every user on the project.
   * - `continuous`: opt into the continuous-capture tier (default off).
   *   mask-all is a strong default whenever this is on.
   * - `maskAllEnforced`: Admin override for the mask-all default. Absent =
   *   enforced (the strong default); `false` = Admin opted the project out so
   *   whole sessions record un-masked. Only meaningful with `continuous: true`.
   * - `flushIntervalMs`: continuous-recorder flush cadence (ms). Unset = the
   *   5-min default; clamped to a >=60s floor (no sub-minute cadence on the
   *   monolithic-append MVP storage).
   * - `sessionSampleRate` / `sessionReplaySampleRate`: Datadog-style two-level
   *   sampling in [0, 1]. Level 1 gates whether a session is tracked; level 2 is
   *   a percentage OF the sampled sessions that also record a replay (nested,
   *   not independent — effective replay rate is the product). Unset on either
   *   keeps the recorder's built-in default.
   * - `ingestQuota` / `eventsIngestQuota`: per-tenant hourly ingest budgets
   *   (requests/hour) keyed on the RUM token's project, overriding the global
   *   default for the one-shot and streaming paths respectively.
   */
  replay?: {
    sampleRate?: number;
    continuous?: boolean;
    maskAllEnforced?: boolean;
    flushIntervalMs?: number;
    sessionSampleRate?: number;
    sessionReplaySampleRate?: number;
    ingestQuota?: number;
    eventsIngestQuota?: number;
    /** Per-tenant extended-retention window in whole months, applied when an
     *  operator flags a session (see ProjectReplayConfig.extendedRetentionMonths). */
    extendedRetentionMonths?: number;
    /** Per-tenant BASE (hot/index) retention window in whole days, overriding the
     *  global `replayRetentionDays` for this project. Tighten-only relative to a
     *  set global default (see ProjectReplayConfig.retentionDays). */
    retentionDays?: number;
  };
  /**
   * Branch protection for the hosted repo's default branch (Agent
   * Hub-hosted projects only).
   * - `requiredChecks`: PRs into the default branch merge only when the
   *   head sha is Finalize-validated or its CI run succeeded (vacuous
   *   when the commit carries no `.agent-hub/ci.yaml`).
   * - `requiredReview`: merge requires an approving human review or
   *   Finalize validation (which includes the in-hub reviewer);
   *   changes-requested blocks regardless.
   * - `blockDirectPushes`: a pre-receive hook rejects direct pushes to
   *   the default branch — it only moves via PR merges (update-ref does
   *   not run hooks).
   */
  branchProtection?: {
    requiredChecks?: boolean;
    requiredReview?: boolean;
    blockDirectPushes?: boolean;
  } | null;
  /**
   * Delete a native PR's head branch after merging (GitHub's
   * "automatically delete head branches"). Default TRUE — agent session
   * branches accumulate fast; set false to keep merged branches.
   */
  deleteBranchOnMerge?: boolean | null;
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
   * AWS profiles for this project. Rendered to project-scoped
   * `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` files at spawn time.
   * SSO tokens cache under the user's HOME; static credentials stay scoped
   * to this project's generated credentials file.
   * See `project-aws-profiles.ts`.
   */
  awsSsoProfiles?: Record<
    string,
    | {
        type?: 'sso';
        sso_account_id: string;
        sso_start_url: string;
        sso_region: string;
        sso_role_name: string;
        region: string;
        output?: string;
      }
    | {
        type: 'static';
        aws_access_key_id: string;
        aws_secret_access_key: string;
        aws_session_token?: string;
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

/**
 * Standalone GitHub OAuth App credentials — optional server-wide OAuth for
 * "Sign in with GitHub". PAT connect works without this.
 */
export interface PersonalOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** One GitHub App installation, keyed by the account (org/user login) it serves. */
export interface GitHubAppInstallation {
  /** GitHub account login (org or user) this installation belongs to. */
  account?: string;
  /** GitHub installation id. */
  id: string | number;
}

/**
 * MINIMAL server-global GitHub App config — restored (PR #1205 removed the
 * full App integration) for exactly ONE purpose: minting an installation
 * access token the Hub → GitHub mirror push can use. An operator adds this
 * App to a repository ruleset's bypass list so the mirror can push a
 * branch-protected default branch while other pushers stay blocked.
 *
 * Persisted in the `config.json` `githubApp` block. Editable by Admin/Owner via
 * the dedicated `GET|PUT|DELETE /api/config/github-app` routes (surfaced in the
 * web GitHub settings tab) — NOT via `PATCH /api/config`. The private key is
 * write-only across that surface: accepted on PUT, never returned on read (GET
 * reports `hasPrivateKey` only), so the key never crosses the REST surface
 * outbound. `clientId`/`clientSecret` are the legacy OAuth pair still consumed
 * by `resolvePersonalOAuthConfig` — carried here only for documentation/back-compat
 * and preserved across App-config writes.
 */
export interface GitHubAppConfig {
  /** Numeric GitHub App id (`iss` of the signed JWT). */
  appId?: string | number;
  /** PEM private key; tolerates escaped `\n`, JSON-quoting, and CRLF/BOM. */
  privateKey?: string;
  /** Default installation id when no per-owner match is found. */
  installationId?: string | number;
  /** Per-owner installation map, so one App serving several orgs resolves right. */
  installations?: GitHubAppInstallation[];
  /** Legacy OAuth client id (still read by resolvePersonalOAuthConfig). */
  clientId?: string;
  /** Legacy OAuth client secret (still read by resolvePersonalOAuthConfig). */
  clientSecret?: string;
}

/**
 * Server-global Google OAuth client credentials — the OAuth *app* (web client)
 * registered in Google Cloud Console. Optional: when unset, the per-user
 * "Connect Google" flow degrades to a "not configured" state and
 * `/api/auth/google/start` returns 503. Admin/Owner configure this in-app via
 * `/api/config/google-oauth`. Distinct from a user's *connection* (the linked
 * Google account + tokens), which is per-user and stored separately.
 */
export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Voice-transcription providers selectable for `/api/transcribe`. `'xai'` (the
 * default) uses the xAI Grok speech-to-text endpoint (`/v1/stt`); `'openai'`
 * uses OpenAI Whisper.
 */
export type TranscriptionProvider = 'xai' | 'openai';

/** Allowed transcription providers, exported for runtime validation. */
export const TRANSCRIPTION_PROVIDERS: readonly TranscriptionProvider[] = ['xai', 'openai'];

export interface AppConfig {
  port: number;
  host: string;
  claudeBin: string;
  cursorBin: string;
  geminiBin: string;
  codexBin: string;
  grokBin: string;
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
   * Fallback IANA timezone for scheduled user work when a row has no timezone.
   * New cron rows created from clients persist their own local timezone.
   * Env: `AGENT_HUB_SCHEDULER_TIMEZONE`; config.json: `schedulerTimezone`.
   */
  schedulerTimezone: string;
  /**
   * When true (default), scheduled heartbeat and cron ticks ENQUEUE a job onto
   * the in-house SQLite job queue instead of executing inline in their
   * node-cron timer callbacks. A single worker loop then drains the queue.
   * node-cron still owns scheduling (timezone / interval / missed-run
   * accounting); the queue owns execution. Set false to fall back to the
   * legacy direct-execution path for one release.
   * Env: `AGENT_HUB_SCHEDULED_JOBS_VIA_QUEUE`; config.json: `scheduledJobsViaQueue`.
   */
  scheduledJobsViaQueue: boolean;
  /**
   * Max scheduled jobs (heartbeats + crons) the queue worker runs at once.
   * Only smooths load — runHeartbeat has its own in-flight guard and each run
   * records its own logs, so this never changes user-visible output. Env:
   * `AGENT_HUB_SCHEDULED_JOBS_CONCURRENCY`; config.json: `scheduledJobsConcurrency`.
   */
  scheduledJobsConcurrency: number;
  /**
   * Server-wide default for compose preview health polling (ms). Overridden
   * per project via `prEnv.preview.compose.readyTimeoutMs`. Env:
   * `AGENT_HUB_PREVIEW_READY_TIMEOUT_MS`; config.json:
   * `previewComposeReadyTimeoutMs`. Clamped 5000–3600000 (5 s – 60 min).
   */
  previewComposeReadyTimeoutMs: number;
  /**
   * Wildcard subdomain base for "subdomain preview" mode. When set
   * (e.g. `preview.agenthub.dev.example.com`), the request
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
  /**
   * Optional standalone OAuth App credentials for personal "Sign in with GitHub".
   * PAT connect in Settings works without this.
   */
  personalOAuth: PersonalOAuthConfig | null;
  /**
   * Optional server-global GitHub App credentials (app id + private key +
   * installation id), used ONLY to mint an installation token for the
   * Hub → GitHub mirror push so it can bypass branch protection on the
   * mirrored default branch. Null when the `githubApp` config block lacks a
   * complete app id + private key. See server/github-app-config.ts.
   */
  githubApp: GitHubAppConfig | null;
  /**
   * Optional server-global Google OAuth app credentials (client id/secret) for
   * the per-user "Connect Google" flow. Null = unconfigured, in which case the
   * Google connect surfaces degrade gracefully and `/api/auth/google/start`
   * returns 503.
   */
  googleOAuth: GoogleOAuthConfig | null;
  apiKey: string | null;
  /**
   * First-party SMTP email delivery configuration. Stored in
   * `<dataDir>/config.json` under `smtp`; read responses mask `password`.
   */
  smtp: SmtpConfig;
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
   * Host-wide xAI (Grok) API key. Powers the default `/api/transcribe`
   * provider via the xAI speech-to-text endpoint (`POST https://api.x.ai/v1/stt`)
   * and the Grok CLI when the host has not run `grok login`. Configure via
   * `xaiApiKey` in config.json, `PATCH /api/config`, or env `XAI_API_KEY`.
   */
  xaiApiKey: string | null;
  /**
   * Which provider `/api/transcribe` uses for chat-composer voice
   * transcription. `'xai'` (the default) calls the xAI Grok speech-to-text
   * endpoint with `xaiApiKey`; `'openai'` calls OpenAI Whisper with
   * `openaiApiKey`. Selectable on the settings page (Account → Plugin API
   * keys). The chosen provider's key must be configured or `/api/transcribe`
   * returns 501 so clients fall back to on-device recognition. Configure via
   * `transcriptionProvider` in config.json, `PATCH /api/config`, or env
   * `TRANSCRIPTION_PROVIDER`.
   */
  transcriptionProvider: TranscriptionProvider;
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
   * Which SessionEnv backend runs per-session dev environments (dev server,
   * PTY host, port mapping). `auto` (the default) probes the host at boot and
   * picks the sysbox adapter when sysbox-runc is installed and registered
   * with Docker, else the host adapter. `host` / `sysbox` force a backend;
   * a forced `sysbox` that fails the capability probe falls back to host
   * with a logged warning. Configure via `sessionEnvAdapter` in config.json
   * or env `AGENT_HUB_SESSION_ENV_ADAPTER`. Probe + selection logic:
   * server/session-env/sysbox-capability.ts; host install:
   * docs/deployment/SYSBOX-HOST-SETUP.md.
   */
  sessionEnvAdapter: 'auto' | 'host' | 'sysbox';
  /**
   * When false (the default), a successful push to GitHub parks the linked
   * kanban card in **Review**; only the PR-merge moves it to **Done**. This is
   * the merge-gated §15 Finalize flow (push → Review, merge → Done) and encodes
   * "Done means merged, not pushed."
   * Set true to opt into the legacy "pushed = shipped" behavior: the card is
   * marked Done the moment the branch lands on GitHub, without waiting for merge.
   * Configure via `AGENT_HUB_CARD_DONE_ON_PUSH` (`true` / `1` / `on` to enable).
   */
  cardDoneOnPush: boolean;
  slackWebhookUrl: string | null;
  /** Max simultaneous host Chromium contexts (distinct pinned chat sessions). */
  browserMaxConcurrentContexts: number;
  /** Idle auto-close for host browser contexts (ms). */
  browserIdleTimeoutMs: number;
  /** When false, Playwright downloads are canceled at start. */
  browserAllowDownloads: boolean;
  /** Block common ad/tracker third-party hosts at route level when true. */
  browserBlockAdsTrackers: boolean;
  /**
   * S3 bucket for session artifacts (agent-generated documents/scripts/PDFs).
   * When set, artifacts upload to this bucket and downloads stream from it.
   * When null, the Hub falls back to a local directory under `dataDir/artifacts`
   * (dev / single-host). Env: `AGENT_HUB_ARTIFACTS_BUCKET`; config.json:
   * `artifactsBucket`.
   */
  artifactsBucket: string | null;
  /**
   * AWS region for `artifactsBucket`. Falls back to the SDK's ambient region
   * (AWS_REGION / AWS_DEFAULT_REGION) when null. Env:
   * `AGENT_HUB_ARTIFACTS_BUCKET_REGION`; config.json: `artifactsBucketRegion`.
   */
  artifactsBucketRegion: string | null;
  /**
   * Session-replay retention window in DAYS. When > 0, a background sweeper
   * (server/replays/replay-retention-sweeper.ts) deletes UNLINKED replays whose
   * `created_at` is older than this many days, reclaiming their blobs. Linked
   * captures (attached to a support ticket or kanban card) are intentional
   * triage artifacts and are never expired. `0` (the default) disables retention
   * entirely — nothing is ever swept, matching the off/opt-in posture. This is a
   * hard prerequisite for continuous (Datadog-parity) capture, which would
   * otherwise grow storage without bound. Env:
   * `AGENT_HUB_REPLAY_RETENTION_DAYS`; config.json: `replayRetentionDays`.
   */
  replayRetentionDays: number;
  /**
   * Phase-1 async-DB instrumentation. When `enabled` is true at boot, every
   * prepared statement is wrapped to time its `run`/`get`/`all` calls
   * (`iterate` is intentionally not timed — it returns a lazy iterator);
   * calls at or above `slowThresholdMs` are counted and (when `logSlow`)
   * logged with the statement tag + duration only (never raw SQL / params).
   * Aggregates are exposed at `GET /api/config/db-stats`. Disabled by default —
   * when off, statements are never wrapped, so there is zero per-call overhead.
   * Env: `AGENT_HUB_DB_INSTRUMENTATION` (enable), `AGENT_HUB_DB_SLOW_THRESHOLD_MS`;
   * config.json: `dbInstrumentation: { enabled, slowThresholdMs, logSlow }`.
   * Changing `enabled` requires a restart to (un)wrap statements.
   */
  dbInstrumentation: {
    enabled: boolean;
    slowThresholdMs: number;
    logSlow: boolean;
  };
  /**
   * Phase-2 async-DB reader pool (see `server/db-async`). Sizes the pool of
   * `worker_threads` that hold read-only better-sqlite3 connections for the
   * async read facade. Infrastructure only — no call site routes through it
   * yet; a later card migrates measured-slow read paths onto it.
   * Env: `AGENT_HUB_DB_READER_POOL_SIZE`, `AGENT_HUB_DB_READER_QUERY_TIMEOUT_MS`,
   * `AGENT_HUB_DB_READER_MAX_QUEUE_DEPTH`, `AGENT_HUB_DB_READER_BUSY_TIMEOUT_MS`;
   * config.json: `dbReaderPool: { size, queryTimeoutMs, maxQueueDepth, busyTimeoutMs }`.
   */
  dbReaderPool: {
    size: number;
    queryTimeoutMs: number;
    maxQueueDepth: number;
    busyTimeoutMs: number;
  };
  readonly allValidModels: string[];
}

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  /**
   * `none` = plain SMTP, `starttls` = STARTTLS upgrade required, `ssl` =
   * implicit TLS (`secure: true` in Nodemailer).
   */
  tlsMode: 'none' | 'starttls' | 'ssl';
  username: string | null;
  password: string | null;
  from: string;
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
   * Set to true ONLY by `reconcileOrphanedTasks` → `resumeOrphanedSessions`
   * (server/index.ts) when auto-resuming an orphaned turn after a server
   * restart. It marks the turn as an *automatic* crash-resume so `handleChat`
   * does NOT clear the session's `resume_attempts` cap at turn start — that
   * counter must keep accumulating across consecutive crash-interrupted
   * resumes. Every other (externally-initiated) turn leaves this unset and
   * resets the cap, so a human-initiated turn always supersedes a prior
   * give-up. See `server/resume-attempts.ts`.
   */
  _autoResume?: boolean;
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
  /** Internal: Finalize-dispatched turns run under the Finalize worktree lock. */
  _finalizeInternal?: boolean;
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
   * Optional preview-runtime accessor used by the WS connect handler to
   * replay `agenthub_preview` snapshots for active previews. Returns one
   * runtime or several (compose + dev-server). Optional so legacy test
   * wirings that don't construct a real runtime continue to work — the
   * snapshot block is skipped when this is absent.
   */
  getPreviewSnapshotRuntime?: () =>
    | import('./preview/preview-snapshot.js').PreviewSnapshotRuntime
    | Array<import('./preview/preview-snapshot.js').PreviewSnapshotRuntime | null | undefined>
    | null;
  /** Optional seam for committed customer-log records feeding live-tail subscribers. */
  subscribeLogTail?: (
    listener: (records: readonly import('./logs/logs-db.js').LogRecordRow[]) => void,
  ) => () => void;
}

// ─── Route Dependencies ──────────────────────────────────────────

export interface RouteDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  /**
   * Native PR service for Agent Hub-hosted projects (`gitHost:
   * 'agenthub'`). Constructed once in index.ts; consumed by the
   * pr-list/pr-actions route branches and the Finalize push step.
   */
  nativePr?: import('./native-pr/service.js').NativePrService;
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
  retireIntakeAgents: () => void;
  ensureSkillBuilderAgents: (projectId?: string) => void;
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
  getGrokBin?: () => string;
  setGrokBin?: (v: string) => void;
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
  getDevServerRuntime?: () => {
    stopBySessionId: (sessionId: string) => Promise<number>;
  } | null;
  /**
   * Clone or attach the session git worktree before the first chat turn.
   * Wired from `index.ts` (`ensureWorktree`). Used by
   * `POST /api/sessions/:sessionId/workspace/ensure` so preview can start
   * immediately after opening a session.
   */
  provisionSessionWorkspace?: (sessionId: string) => Promise<string>;
  /** Move a clean session worktree onto an existing remote branch. */
  switchSessionWorkspaceBranch?: (
    sessionId: string,
    branch: string,
  ) => Promise<{ worktreePath: string; branch: string }>;
  /** Resume queued messages after a branch switch releases the worktree lock. */
  drainSessionQueue?: (sessionId: string) => void;
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
