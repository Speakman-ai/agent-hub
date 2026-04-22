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
  /** Soft-delete timestamp. NULL = active; non-NULL = archived (hidden from live list, recoverable for 7 days). */
  deleted_at: string | null;
  /** JSON blob: goal, checklist[], lastFailure (see `server/task-state.ts`). */
  task_state_json?: string | null;
  /** Outer PAV phase slug (`planning` | `acting` | `verifying` | `done` | `escalated`) or NULL = legacy/unset. */
  orchestration_phase?: string | null;
  /** JSON object — host/operator metadata for outer orchestration (see `server/orchestration.ts`). */
  orchestration_meta?: string | null;
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
  created_at: string;
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

export interface RoomRow {
  id: string;
  name: string;
  project_id: string | null;
  max_turns: number;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentRow {
  room_id: string;
  agent_id: string;
  position: number;
  added_at: string;
}

export interface RoomMessageRow {
  id: string;
  room_id: string;
  role: 'user' | 'assistant';
  agent_id: string | null;
  agent_name: string | null;
  agent_color: string | null;
  content: string;
  attachments: string | null;
  created_at: string;
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
  autonomous_iterations: number;
  /** Set when autonomous dispatch increments iterations — controls auto-PR at session end vs Create PR banner. */
  dispatched_by_autonomous: number;
  /** Optional model id chosen at assign time; null/absent means use agent + engine defaults. */
  assign_model?: string | null;
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
  autonomous_max_iterations: number;
  /** When set and valid for the assignee agent's engine, autonomous dispatch uses this instead of the agent's configured model. */
  autonomous_model: string | null;
  /** JSON object: optional overrides merged on top of the project's `orchestrationBudgets`. */
  orchestration_budgets_json?: string | null;
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
  status: 'pending' | 'processing' | 'done' | 'error';
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
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

export interface ThreadEntryRow {
  id: string;
  thread_id: string;
  content: string;
  timestamp: string;
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

export interface ActiveRoomTaskRow {
  room_id: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_color: string | null;
  message_id: string | null;
  streamed_output: string;
  queue_json: string | null;
  turn_count: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  started_at: string;
  updated_at: string;
}

export interface RoomMessageQueueRow {
  id: string;
  room_id: string;
  content: string;
  position: number;
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

/**
 * A PR capture job — tracks an attempt to screenshot/record a PR branch.
 * Replaces the old Docker-based PreviewContainerRow.
 */
export interface PrCaptureRow {
  id: string;
  project_id: string;
  pr_number: number;
  pr_url: string | null;
  branch: string;
  commit_sha: string | null;
  repo_url: string;
  status: 'queued' | 'building' | 'capturing' | 'done' | 'error';
  error_message: string | null;
  build_log: string | null;
  /** Number of screenshots captured */
  screenshot_count: number;
  /** Whether a walkthrough video was captured */
  has_video: boolean;
  /** Duration of the capture process in ms */
  duration_ms: number | null;
  /** URL to the GitHub PR comment with screenshots (if posted) */
  comment_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrCaptureArtifactRow {
  id: string;
  capture_id: string;
  type: 'screenshot' | 'video';
  route: string | null;
  name: string;
  label: string;
  filename: string;
  file_path: string;
  file_size: number;
  /** Console errors captured from the page (for agent self-validation) */
  console_errors: string | null;
  created_at: string;
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
  updateSessionName: Stmt;
  deleteSession: Stmt;
  softDeleteSession: Stmt;
  restoreArchivedSession: Stmt;
  getAllSessionsByAgent: Stmt;
  getArchivedSessionsByAgent: Stmt;
  touchSession: Stmt;
  updateSessionEngine: Stmt;
  updateSessionModel: Stmt;
  updateSessionEngineSessionId: Stmt;
  updateSessionPendingSkillContext: Stmt;
  updateSessionWorktree: Stmt;
  updateSessionWorktreePath: Stmt;
  updateSessionGitWorktreeDetected: Stmt;
  updateSessionAskMode: Stmt;
  updateSessionReactLoop: Stmt;
  updateSessionChangesReady: Stmt;
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

  // Rooms
  getRooms: Stmt;
  getRoom: Stmt;
  createRoom: Stmt;
  createProjectRoom: Stmt;
  getRoomByProjectId: Stmt;
  updateRoomName: Stmt;
  updateRoomMaxTurns: Stmt;
  touchRoom: Stmt;
  deleteRoom: Stmt;

  // Room agents
  getRoomAgents: Stmt;
  addRoomAgent: Stmt;
  removeRoomAgent: Stmt;

  // Room messages
  getRoomMessages: Stmt;
  addRoomMessage: Stmt;

  // Active room tasks
  getActiveRoomTask: Stmt;
  getAllActiveRoomTasks: Stmt;
  insertActiveRoomTask: Stmt;
  updateActiveRoomTaskAgent: Stmt;
  appendActiveRoomTaskOutput: Stmt;
  deleteActiveRoomTask: Stmt;
  deleteAllActiveRoomTasks: Stmt;

  // Room message queue
  enqueueRoomMessage: Stmt;
  getQueuedRoomMessages: Stmt;
  getNextQueuedRoomMessage: Stmt;
  dequeueRoomMessage: Stmt;
  clearRoomQueue: Stmt;
  getMaxRoomQueuePosition: Stmt;
  getAllQueuedRooms: Stmt;

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
  reassignCardToSession: Stmt;
  getKanbanCardBySession: Stmt;
  getKanbanCardByPrUrl: Stmt;
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
  deleteKanbanEpic: Stmt;
  getKanbanCardsByEpic: Stmt;
  updateKanbanCardEpic: Stmt;
  getAutonomousEpic: Stmt;
  getEligibleAutonomousCards: Stmt;
  incrementCardIterations: Stmt;
  resetCardIterations: Stmt;

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
  deleteThreadsByProject: Stmt;
  deleteRoomsByProject: Stmt;
  deleteCronsByProject: Stmt;
  deleteSessionsByAgent: Stmt;
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

  // PR captures (screenshot/video for PRs)
  getPrCaptures: Stmt;
  getPrCapturesByProject: Stmt;
  getPrCapture: Stmt;
  createPrCapture: Stmt;
  updatePrCapture: Stmt;
  updatePrCaptureStatus: Stmt;
  deletePrCapture: Stmt;

  // PR capture artifacts
  getPrCaptureArtifacts: Stmt;
  createPrCaptureArtifact: Stmt;
  deletePrCaptureArtifacts: Stmt;

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
}

// ─── Project / Agent Types ───────────────────────────────────────

export interface HeartbeatConfig {
  enabled: boolean;
  interval: string;
  prompt: string;
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
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
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

export interface Project {
  id: string;
  name: string;
  cwd: string;
  ahw: string;
  color?: string;
  githubRepo?: string;
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
   * Shell commands run in the session worktree before the server moves a
   * linked kanban card to **Done** in response to `<agenthub:close-card>`.
   * On failure the card stays put and a system message is inserted. Empty or
   * absent skips verification.
   */
  verifyBeforeDoneCommands?: string[];
  /**
   * Optional ReAct / auto-continuation budgets for sessions in this project.
   * Shapes match `OrchestrationBudgetsPartial` in `server/orchestration-budgets.ts`.
   */
  orchestrationBudgets?: Record<string, unknown>;
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
  clientId?: string;
  clientSecret?: string;
  installationId?: number;
  installations?: Array<{ id: number; account: string; accountType: string }>;
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
  publicUrl: string | null;
  defaultReviewer: string | null;
  botGithubToken: string | null;
  githubApp: GitHubAppConfig | null;
  apiKey: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  geminiApiKey: string | null;
  codexApiKey: string | null;
  slackWebhookUrl: string | null;
  capturesEnabled: boolean;
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

export interface ErrorEvent extends BaseStreamEvent {
  type: 'error';
  message: string;
}

export interface UnknownEvent extends BaseStreamEvent {
  type: 'unknown';
  text: string;
}

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
  hookSpecificOutput?: { sessionTitle?: string; [key: string]: unknown };
}

export interface RoomChatMessage {
  type: 'room_chat';
  roomId: string;
  content: string;
  images?: string[];
}

export interface CancelMessage {
  type: 'cancel';
  sessionId: string;
}

export interface RoomCancelMessage {
  type: 'room_cancel';
  roomId: string;
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
  | RoomChatMessage
  | CancelMessage
  | RoomCancelMessage
  | DesignChatMessage
  | DesignCancelMessage
  | { type: 'delegation_cancel'; sessionId: string }
  | { type: 'dequeue'; sessionId: string; messageId: string }
  | { type: 'edit_queue_item'; sessionId: string; messageId: string; content: string }
  | { type: 'room_dequeue'; roomId: string; messageId: string }
  | { type: 'ping' };

export interface BroadcastFn {
  (data: Record<string, unknown>): void;
}

// ─── WebSocket Deps ──────────────────────────────────────────────

export interface WebSocketDeps {
  getProjects: () => Project[];
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  handleRoomChat: (ws: unknown, msg: RoomChatMessage) => Promise<void>;
  handleCancel: (sessionId: string) => void;
  handleRoomCancel: (roomId: string) => void;
  handleDelegationCancel: (sessionId: string) => void;
  handleDequeue: (sessionId: string, messageId: string) => void;
  handleEditQueueItem: (sessionId: string, messageId: string, content: string) => void;
  handleRoomDequeue: (roomId: string, messageId: string) => void;
  handleDesignChat: (ws: unknown, msg: DesignChatMessage) => Promise<void>;
  handleDesignCancel: (designId: string) => void;
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
  ensureProjectRoom: (project: Project) => RoomWithAgents | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  pendingReviewComments: Map<string, unknown>;
  lastDispatchedReviewId: Map<string, string>;
  scheduleAutonomousEpic: (projectId: string, epic: KanbanEpicRow) => void;
  autonomousCrons: Map<string, unknown>;
  runAutonomousLoop: (projectId: string) => Promise<void>;
  config: AppConfig;
  getProjects: () => Project[];
  setProjects: (p: Project[]) => void;
  getGhBotUser: () => string | null;
  setGhBotUser: (v: string | null) => void;
  getGhAppSlug: () => string | null;
  setGhAppSlug: (v: string | null) => void;
  serverDir: string;
  buildTranscript: (
    messages: Array<{ role: string; content: string; agent_name?: string | null }>,
    options: { agentName?: string; isRoom?: boolean },
  ) => string;
  summarizeTranscript: (
    transcript: string,
    options: { engine: string; model?: string; cwd?: string },
    config: AppConfig,
  ) => Promise<string>;
  DEFAULT_MODEL: string;
  activeProcesses: Map<string, import('child_process').ChildProcess>;
  getProjectDataDir: (projectId: string) => string;
  ensureDocsAgents: () => void;
  ensureIntakeAgents: () => void;
  ensureReviewerAgents: () => boolean;
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
}

// ─── Room with Agents ────────────────────────────────────────────

export interface RoomAgentDetail {
  id: string;
  name: string;
  color: string;
  position: number;
}

export interface RoomWithAgents extends RoomRow {
  agents: RoomAgentDetail[];
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
