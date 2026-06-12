import { spawn, execFile, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, stmts as _stmts } from './db.js';
import { trackChild, killProcessGroup } from './process-groups.js';
import { createStreamParser } from './stream-parser.js';
import { shouldPersistStreamEvent } from './benign-stream-events.js';
import { clampPayload } from './session-events-store.js';
import config, { buildSpawnEnv, resolveAgentHubApiBaseForSpawn } from './config.js';
import { resolveSessionCliSpawnEnv, EngineAuthRequiredError } from './per-user-cli-spawn.js';
import { resolveEffectiveEngineAndModel, resolveEffectiveModel } from './effective-model.js';
import {
  resolveProjectPaths,
  contextFilePath,
  resolveWorkspaceSkillsDir,
} from './project-paths.js';
import { getWikiContext } from './wiki.js';
import { getMemoryContext, appendDailyNote, reconcileMemoryAfterSession } from './memory.js';
import { listEnabledSkills } from './agent-skills-list.js';
import { summarizeTranscript, buildTranscript } from './routes/sessions.js';
import { writeHooksConfig } from './hooks.js';
import { getSessionOwner } from './session-ownership.js';
import { resolveSessionPrUrl } from './session-title-pr.js';
import { listEnabledMcpServersForUser } from './mcp-servers-store.js';
import { buildMcpServersMap, writeMcpConfigFile } from './mcp-spawn-config.js';
import { getActiveAccessToken } from './github-connections-store.js';
import {
  resolveOAuthAppCredentials,
  applyGithubSpawnCredentials,
  applyReviewerSpawnIsolation,
  applyReviewerRoleLock,
} from './spawn-github-credentials.js';
import { resolveGithubSpawnToken } from './github-spawn-token-resolver.js';
import { getRepoOwnerForCwd } from './github-remote-owner.js';
import type { DelegationResult } from './delegation.js';
import {
  handleMultiAgentChat,
  initSessionMultiAgent,
  sessionHasAdvisors,
  activeMultiAgentRounds,
  handleMultiAgentCancel,
} from './session-multi-agent.js';
import {
  detectHandoffBlock,
  recordMalformedHandoff,
  handoffHasTrailingContent,
  handleHandoff,
  buildHandoffPromptSection,
} from './handoff.js';
import {
  detectCloseCardBlock,
  describeCloseCardReason,
  handleCardAutoClose,
} from './card-auto-close.js';
import { detectPreviewBlock, describePreviewReason } from './preview/preview-block.js';
import { handleMutatingToolUseForCodeChange } from './code-change-tracker.js';
import {
  resolveTurnEndError,
  planTransientErrorRetry,
  buildTurnErrorContinuationPrompt,
  buildTransientRetryNotice,
  buildTurnErrorHaltNotice,
} from './turn-error.js';
import { sessionHasActiveUserPreview } from './preview/preview-worktree-sync.js';
import { syncPreviewAfterWorktreeTurnIfDirty } from './code-change-tracker.js';
import type { PreviewRuntime } from './preview/preview-runtime.js';
import type { PreviewComposeRuntime } from './preview/preview-compose-runtime.js';
import {
  detectSkillBlock as detectSkillInvokeBlock,
  handleSkillInvoke,
  loadSkillByName,
  parseSkillBlock,
} from './skill-invoke.js';
import { routeSkillsFromMessage } from './skill-router.js';
import {
  detectTagBlockInLastFence,
  extractJsonFromTagBody,
  stripFencedCodeBlockBodies,
} from './action-block-parsing.js';
import { stripAssistantControlBlocks } from '../shared/utils/stripAssistantControlBlocks.js';
import { resolveBugReportReroute, extractBugReportTitle } from './bug-report-reroute.js';
import { appendCodexAwsAccessDirs, appendCodexExecSandboxFlags } from './codex-exec-sandbox.js';
import { enrichCodexFileChangeDiffs } from './codex-file-change-diff.js';
import { writeProjectAwsConfigFile } from './project-aws-config-file.js';
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';
import {
  writeSystemPromptFile,
  applyArgvPromptCap,
  logArgvCapTruncation,
  SAFE_ARG_STRLEN_BYTES,
} from './spawn-prompt-payload.js';
import { pickProcessErrorMessage } from './process-error-message.js';
import {
  appendRunCancelledSystemMessage,
  finalizeChatRunAfterTermination,
  formatChatExitLog,
  markSessionTermination,
  resolveChatTerminationOnClose,
} from './process-termination.js';
import { ensureSpawnCwd } from './spawn-cwd.js';
import {
  detectSessionIdInUseError,
  buildSessionIdInUseRecoveryMessage,
  detectNoConversationFoundError,
  buildNoConversationFoundRecoveryMessage,
} from './claude-session-id-conflict.js';
import { allAgents, findProject } from './project-model.js';
import {
  setSessionOwner,
  inheritOwnerFromSession,
  getWsAuthUserId,
  type AuthStampedWs,
} from './session-ownership.js';
import { broadcastActiveTasksSnapshot } from './active-tasks.js';
import { broadcastAwaitingInputForSession } from './awaiting-input.js';
import { recomputeSessionState } from './session-state.js';
import { billSessionTurnDurationIfTaggedToFinalize } from './finalize/budget.js';
import {
  notifyFinalizeSessionTurnEnd,
  notifyFinalizeSessionSpawnFailed,
} from './finalize/turn-end.js';
import { applySessionGitGuards } from './finalize/spawn-ship-guards.js';
import { worktreeHasFinalizeCi } from './finalize/worktree-has-ci.js';
import { hostedBarePathForProject } from './git-host/repo-store.js';
import { applyAgentHubGitSpawnCredentials } from './git-host/spawn-credentials.js';
import {
  detectWikiRequestBlock,
  parseWikiRequestBlock,
  runWikiHybridRagForAssistantRequest,
  runWikiHybridRagForUserTurn,
  MAX_WIKI_RAG_CALLS_PER_SESSION,
  MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES,
  effectiveWikiHybridRagUsedCount,
  nextWikiHybridRagRowAfterIncrement,
} from './wiki-rag.js';
import { runCodeRagForUserTurn, MAX_CODE_RAG_CALLS_PER_SESSION } from './code-rag.js';
import { runWebSearchForQuery } from './web-search.js';
import {
  pickTurnSessionTitle,
  scheduleTitleUpgrade,
  shouldPersistTurnSessionTitlePick,
  titleSourceForPick,
} from './session-title.js';
import { clipUtf8StringToMaxBytes } from './utf8-clip.js';
import {
  applyAssistantTextChunkForDelegationKickoff,
  planDelegationRoundOnProcClose,
} from './delegation-kickoff-buffer.js';
import { isSessionChatBusy } from './session-chat-busy.js';
import { clearDelegationUiMeta } from './delegation-state.js';
import { isDelegationDisabledForAgent } from './delegation-gate.js';
import type {
  Project,
  Agent,
  EnrichedAgent,
  AgentLookup,
  SessionRow,
  MessageRow,
  ActiveTaskRow,
  BackgroundTaskRow,
  NoteProcessingRow,
  KanbanCardRow,
  KanbanEpicRow,
  MessageQueueRow,
  Stmts,
  StreamEvent,
  AppConfig,
  BroadcastFn,
  ChatMessage,
  BrowserToolActivityEvent,
} from './types.js';
import { enrichSessionForClient } from './session-checkpoint-rewind.js';
import {
  HOST_REACT_ACTIONS_PARSE_CAP,
  resolveOrchestrationBudgets,
  evaluateReactContinuationBudgets,
} from './orchestration-budgets.js';
import { emitReactLoopStep, mergeHostActionExitForEmit } from './react-loop-observability.js';
import { formatOuterOrchestrationPromptAppend } from './orchestration.js';
import {
  getProjectMode,
  defaultSessionUseWorktreeFlag,
  sessionUsesWorktree,
} from './project-mode.js';
import { isPreviewSetupWizardSession } from './routes/preview-wizard.js';
import { mergeAllowlistedExtraEnv } from './extra-env-allowlist.js';
import {
  runBrowserReActStep,
  BROWSER_REACT_OP_SET,
  browserToolStartLabel,
} from './browser-tools.js';
import {
  runPreviewReActStep,
  PREVIEW_REACT_OP_SET,
  PREVIEW_DRIVE_OPS,
} from './preview/preview-react.js';
import {
  effectiveBrowserToolsEnabled,
  resolveBrowserSessionOptions,
} from './browser-agent-settings.js';
import {
  buildBrowserActivityEndedEvent,
  buildBrowserActivityEndedThrowEvent,
  buildBrowserActivityScreenshotBroadcast,
  buildBrowserActivityStartedEvent,
} from './browser-activity-emits.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from './project-secrets-spawn.js';
import {
  mergeProjectAwsSpawnEnv,
  getProjectAwsSsoProfiles,
  projectHasAwsSsoProfiles,
  linkAwsSsoHostCacheIntoSpawnHome,
} from './project-aws-spawn.js';
import { effectivePrBaseBranch } from './kanban-pr-base.js';
import { resolveDefaultBranch } from './git-default-branch.js';

const stmts = _stmts!;
const MAX_QUEUE_SIZE = 10;

/**
 * Process-lifetime cache of each checkout's default branch, keyed by cwd.
 * The agent-facing Development Lifecycle / Git Workflow prompt sections need
 * to tell the model which branch to branch from and rebase onto. Hardcoding
 * `main` was wrong for repos whose default is `master` (e.g. surveytracker),
 * so we detect it via `resolveDefaultBranch`. A repo's default branch changes
 * essentially never, so caching it for the process lifetime avoids spawning
 * `git symbolic-ref` on every chat turn. Returns `null` until first resolved.
 */
const defaultBranchByCwd = new Map<string, string>();
export async function getCachedDefaultBranch(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  const cached = defaultBranchByCwd.get(cwd);
  if (cached) return cached;
  const detected = await resolveDefaultBranch(cwd);
  if (detected) defaultBranchByCwd.set(cwd, detected);
  return detected;
}

// ─── Internal types ─────────────────────────────────────────────

interface ImageRef {
  filename: string;
  [key: string]: unknown;
}

interface SlashSkillResult {
  error?: string;
  skillName?: string;
  userArgs?: string;
}

interface DelegateTask {
  agentId: string;
  task: string;
  owner: string;
  scope: string;
  expectedArtifact: string;
  deadline: string;
  returnFormat: string;
}

interface BuildEnrichedPromptOptions {
  useWorktree?: boolean;
  isFirstMessage?: boolean;
  /**
   * Target session id for which the prompt is being built. When provided,
   * the builder checks for an incoming (delivered) handoff and appends a
   * `## HANDOFF FROM ...` section on the first turn so the agent picks up
   * the source session's transcript + handoff note.
   */
  sessionId?: string;
  /** Outer PAV — `sessions.orchestration_phase` / `orchestration_meta`. */
  orchestrationPhase?: string | null;
  orchestrationMetaJson?: string | null;
  /**
   * URL of an already-open PR for this session's worktree branch. When set,
   * the prompt builder appends a `## Active Pull Request` block instructing
   * the agent NOT to run `gh pr create`. Closes the duplicate-PR pattern
   * where a context-resumed session re-opens a PR for a branch that already
   * has one (only the server-side auto-git flow dedupes; the spawned agent
   * itself can still call `gh pr create` from its own toolbox).
   */
  branchPrUrl?: string | null;
  /** Configured base branch for the PR (from card.pr_base_branch). Optional. */
  branchPrBase?: string | null;
  /**
   * Detected default branch of the project checkout (e.g. `main` or `master`).
   * Used for the Development Lifecycle / Git Workflow "branch from / rebase
   * onto" guidance when no explicit `branchPrBase` override is configured.
   * Falls back to `main` when neither is provided. Resolve via
   * `getCachedDefaultBranch(project.cwd)` at the (async) call site.
   */
  defaultBranch?: string | null;
  /**
   * Suppress the "Development Lifecycle" / "Git Workflow" branch-test-ship
   * guidance. Set for non-shipping helper agents (in-session reviewer,
   * multi-agent advisor) that only read/review the worktree — they never
   * branch, rebase, or open PRs, so the ship mechanics are irrelevant
   * (and were emitting a wrong `git checkout main` for `master` repos).
   */
  omitDevLifecycle?: boolean;
  /**
   * True when this session is already linked to a kanban card (via
   * `kanban_cards.session_id`). Suppresses the "create a kanban card"
   * instructions in the Development Lifecycle, Kanban Self-Reporting, and
   * Bias to Action sections — picking up card-spawned work shouldn't file a
   * duplicate card. The agent is instead told to move its existing linked
   * card through the column lifecycle.
   */
  sessionHasLinkedCard?: boolean;
  /**
   * True when the session worktree contains `.agent-hub/ci.yaml`. Suppresses
   * agent-owned push/PR instructions and tells the model to commit only — the
   * human operator ships via Finalize Code Changes.
   */
  finalizeConfigured?: boolean;
  /** Absolute path to this session's git worktree (when useWorktree). */
  sessionWorktreePath?: string | null;
  /** Feature branch checked out in the session worktree. */
  sessionWorktreeBranch?: string | null;
  _getEnrichedAgent?: (id: string) => EnrichedAgent | null;
}

interface InternalChatMessage extends ChatMessage {
  interrupt?: boolean;
  hookSpecificOutput?: { sessionTitle?: string; [key: string]: unknown };
  _autoContinuation?: boolean;
  _continuationDepth?: number;
  /** Retries when a continuation hits a transient active-task collision. */
  _continuationRetry?: number;
  /** Epoch ms when the current user-turn ReAct chain started (first non-continuation handle). */
  _chainStartedAtMs?: number;
  /**
   * Pin the Claude/Cursor spawn cwd across ReAct auto-continuations so
   * `--resume` targets the same on-disk project encoding as the prior turn.
   */
  _spawnCwd?: string;
  /** One-shot retry after Claude "No conversation found" on `--resume`. */
  _noConversationRetry?: number;
  /**
   * Count of auto-retries already performed after a transient engine/API
   * error ended a turn (e.g. "API Error: The socket connection was closed
   * unexpectedly"). Capped at TRANSIENT_TURN_ERROR_MAX_RETRIES — see
   * `server/turn-error.ts`.
   */
  _transientErrorRetry?: number;
}

interface ProjectWithCommands extends Project {
  commands?: {
    install?: string;
    build?: string;
    test?: string;
    lint?: string;
  };
  defaultReviewer?: string;
}

interface AgentWithModel extends Agent {
  workspace?: string;
  cwd?: string;
}

export interface ChatHandlerDeps {
  broadcast: BroadcastFn;
  findAgent: (agentId: string) => AgentLookup | null;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  activeProcesses: Map<string, ChildProcess>;
  activeDelegationSessions: Set<string>;
  autonomousProjects: Set<string>;
  getClaudeBin: () => string;
  getCursorBin: () => string;
  getGeminiBin: () => string;
  getCodexBin: () => string;
  uploadsDir: string;
  resolveSlashSkill: (agent: Agent, content: string, project: Project) => SlashSkillResult | null;
  createCursorChat: ((cwd: string, env: NodeJS.ProcessEnv) => Promise<string>) | undefined;
  ensureWorktree: (
    session: SessionRow,
    projectCwd: string,
    agentId: string,
    installCommand: string | null,
    prBaseBranch?: string | null,
    repoUrl?: string | null,
    projectId?: string,
    onBaseBranchAdvanced?: import('./worktree.js').OnBaseBranchAdvancedFn,
    githubRepo?: string | null,
    hostedBarePath?: string | null,
  ) => Promise<string>;
  drainQueue: (sessionId: string) => void;
  handleDelegation: (
    sessionId: string,
    messageId: string,
    tasks: DelegateTask[],
    enrichedAgent: EnrichedAgent,
    project: Project,
    cwd: string,
  ) => Promise<DelegationResult[]>;
  handleDelegationCancel: (sessionId: string) => void;
  synthesizeResults: (
    sessionId: string,
    agentId: string,
    enrichedAgent: EnrichedAgent,
    project: Project,
    results: DelegationResult[],
    originalContent: string,
    cwd: string,
  ) => Promise<void>;
  parseDelegateBlock: (content: string) => DelegateTask[] | null;
  /**
   * Accessor for the per-session preview runtime. Returns `null` when the
   * runtime has not been wired (e.g. tests of unrelated chat surface or
   * pre-rollout deploys). The accessor pattern matches `getClaudeBin` /
   * `getCursorBin` — callers don't need to know whether the runtime was
   * constructed at process start.
   */
  getPreviewRuntime?: () => PreviewRuntime | null;
  /**
   * Accessor for the per-session **compose** preview runtime. Selected
   * over `getPreviewRuntime` when a project sets
   * `prEnv.preview.compose.entryService`. Same null-when-unwired contract
   * as the legacy accessor.
   */
  getPreviewComposeRuntime?: () => PreviewComposeRuntime | null;
  autoCommitAndPR: (
    sessionId: string,
    agentId: string,
    project: Project,
    agent: Agent,
    cwd: string,
    finalContent: string,
    options?: { allowFinalizeAutoStart?: boolean },
  ) => Promise<void>;
  tryAutonomousDispatch: () => void;
}

export interface ChatHandlerResult {
  handleChat: (ws: WebSocketLike | null, msg: InternalChatMessage) => Promise<void>;
  saveErrorMessage: (
    sessionId: string,
    messageId: string,
    engine: string,
    model: string,
    errorText: string,
  ) => string;
  createCursorChat: (cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
  initMultiAgent: () => void;
}

/** Minimal socket shape used by chat handlers (matches `ws` from the `ws` package). */
export type WebSocketLike = { send: (data: string) => void };

const MAX_PENDING_CONTEXT_BYTES = 128 * 1024;

/**
 * Max times an auto-continuation turn will reschedule itself when the
 * session already has an active task or an in-flight delegation round.
 * Pure constant so callers (and tests) can reason about the cap
 * independently of the `setTimeout`-based scheduler.
 */
export const AUTO_CONTINUATION_MAX_RETRIES = 12;

/**
 * Decision returned by {@link planAutoContinuationRetry} describing whether
 * a blocked auto-continuation turn should be rescheduled (`retry`) or
 * silently dropped (`drop`) once the retry budget is exhausted.
 */
export type AutoContinuationRetryPlan =
  | { action: 'retry'; nextRetry: number }
  | { action: 'drop'; reason: 'retries-exhausted' };

/**
 * Pure planner for the auto-continuation retry loop. Given the current
 * retry count, decide whether we should schedule another attempt or give
 * up. Kept as a small exported helper so the "12-retry cap" semantics are
 * unit-testable without spinning up a real chat session.
 */
export function planAutoContinuationRetry(opts: {
  retries: number;
  maxRetries?: number;
}): AutoContinuationRetryPlan {
  const max = opts.maxRetries ?? AUTO_CONTINUATION_MAX_RETRIES;
  const retries = Number.isFinite(opts.retries) && opts.retries >= 0 ? opts.retries : 0;
  if (retries < max) {
    return { action: 'retry', nextRetry: retries + 1 };
  }
  return { action: 'drop', reason: 'retries-exhausted' };
}

/** Passes through to effectiveBrowserToolsEnabled (project-aware). */
export function agentBrowserToolsEnabled(
  agent: Pick<Agent, 'browserToolsEnabled'>,
  project?: Pick<Project, 'browserToolsDefaultEnabled'> | null,
): boolean {
  return effectiveBrowserToolsEnabled(agent, project ?? undefined);
}

/** Auto-continuation user message — browser wording omitted when tools are off for the agent. */
export function buildAutoContinuationPrompt(browserToolsEnabled = true): string {
  const loadedCtx = browserToolsEnabled ? 'skill/wiki/web/browser' : 'skill/wiki/web';
  const toolGuidance = browserToolsEnabled
    ? 'add more action objects for skill, web, or browser as needed (browser example: {"tool":"browser","op":"navigate","url":"https://example.com"}). '
    : 'add skill or web actions only — omit browser entries from the actions array (browser tools are disabled for this agent). ';
  return (
    `Continue your previous answer using the newly loaded ${loadedCtx} context from this same turn. ` +
    'Use a think -> act -> observe loop when needed. ' +
    `When you need tools, emit <agenthub:react>{"actions":[{"tool":"wiki","query":"kanban api"}]}</agenthub:react> with your own real query strings; ${toolGuidance}` +
    'The JSON between the tags must parse with JSON.parse (no comments, no trailing commas, no doc placeholders like an actions array written as bracket-dot-dot-dot-bracket). ' +
    'Answer the original user request directly when done.'
  );
}

/** Continuation hint when browser tools are enabled (backward-compat constant). */
export const AUTO_CONTINUATION_PROMPT = buildAutoContinuationPrompt(true);

/** One-time DB align for legacy hybrid RAG gate rows (`budget_version` 0 + `consumed` ≥ 1). */
function persistLegacyWikiHybridGateIfNeeded(session: SessionRow, sessionId: string): void {
  const bv = session.wiki_hybrid_rag_budget_version ?? 0;
  const c = session.wiki_hybrid_rag_consumed ?? 0;
  if (bv === 0 && c >= 1) {
    try {
      stmts.updateSessionWikiHybridRagBudget.run(MAX_WIKI_RAG_CALLS_PER_SESSION, 1, sessionId);
      session.wiki_hybrid_rag_consumed = MAX_WIKI_RAG_CALLS_PER_SESSION;
      session.wiki_hybrid_rag_budget_version = 1;
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[wiki-rag] failed to migrate legacy hybrid RAG gate: ${m}`);
    }
  }
}

type ReActTool = 'wiki' | 'skill' | 'web' | 'browser' | 'preview';

interface ReActAction {
  tool: ReActTool;
  query?: string;
  name?: string;
  /** browser — see server/browser-tools.ts; preview — see server/preview/preview-react.ts */
  op?: string;
  url?: string;
  target?: string;
  text?: string;
  instruction?: string;
  schema?: Record<string, unknown>;
  direction?: string;
  condition?: string;
  /** preview navigate — path within the preview app (must start with `/`). */
  route?: string;
  /** preview logs — tail line count. */
  tail?: number;
}

interface ParsedReAct {
  actions: ReActAction[];
}

interface ParsedReActMalformed {
  error: 'malformed';
  detail: string;
}

// ─── Project agent roster (same project) ───────────────────────────

export type ProjectAgentRosterPeer = { id: string; name: string; role?: string };

/**
 * Markdown block listing peer agents for injection into the enriched system prompt.
 * Excludes the current agent; empty when there are no peers.
 *
 * The `delegateAllowlist` parameter is retained for source compatibility but
 * is intentionally ignored — the `<delegate>`/`<handoff>` sub-agent system
 * has been removed. Peers are listed neutrally; agents coordinate via plain
 * chat or multi-agent sessions, not via dispatched blocks.
 */
export function formatProjectAgentRosterSection(
  peers: ProjectAgentRosterPeer[],
  delegateAllowlist?: string[],
): string {
  void delegateAllowlist;
  if (peers.length === 0) return '';
  const lines = peers.map((p) => {
    const display = (p.name || '').trim() || p.id;
    const roleBit = p.role ? ` · Role: ${p.role}` : '';
    return `- **${display}** (\`${p.id}\`)${roleBit}`;
  });
  return `\n\n## Project agent roster (same project)\nOther agents on this project you may reference by name or \`id\` in chat and multi-agent sessions:\n${lines.join('\n')}`;
}

function peersOnProject(projectId: string, excludeAgentId: string): ProjectAgentRosterPeer[] {
  return allAgents()
    .filter((a) => a.projectId === projectId && a.id !== excludeAgentId)
    .map((a) => ({
      id: a.id,
      name: (a.name || '').trim() || a.id,
      role: typeof a.role === 'string' && a.role.trim() ? a.role.trim() : undefined,
    }));
}

/**
 * Max bytes we keep from a single skill description when rendering the
 * `Available Skills` block in the enriched system prompt.
 *
 * Default skill descriptions average ~700 B and include long
 * `TRIGGER`/`DO NOT TRIGGER` natural-language explanations that are useful
 * inside SKILL.md but bloat the per-turn prompt: the 16 default skills on
 * agent-hub re-send roughly 12 KB of description text every single turn.
 * Capping at 160 B keeps the first sentence (the "what it does") plus a
 * few words of trigger hint, which is enough for the model to recognize a
 * relevant skill and load it via `<agenthub:skill>`. The full SKILL.md
 * body is still injected when the skill is actually loaded.
 *
 * Exported so tests can pin the constant.
 */
export const SKILL_DESCRIPTION_MAX_BYTES = 160;

/**
 * Compress a SKILL.md `description:` frontmatter value to a single line of
 * at most `SKILL_DESCRIPTION_MAX_BYTES` UTF-8 bytes. Collapses internal
 * whitespace, prefers cutting at a sentence boundary, and appends an
 * ellipsis when truncation actually happened.
 *
 * Pure — no DB / FS / env access — so it is cheap to unit-test.
 */
export function compressSkillDescription(
  raw: string | null | undefined,
  maxBytes: number = SKILL_DESCRIPTION_MAX_BYTES,
): string {
  const collapsed = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (Buffer.byteLength(collapsed, 'utf-8') <= maxBytes) return collapsed;
  // Reserve bytes for the trailing ellipsis (U+2026 is 3 bytes in UTF-8).
  const ELLIPSIS = '\u2026';
  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, 'utf-8');
  const sliced = clipUtf8StringToMaxBytes(collapsed, Math.max(0, maxBytes - ellipsisBytes));
  // Prefer the FIRST sentence boundary inside the kept slice. Skill
  // descriptions lead with a "what it does" sentence and follow with
  // verbose TRIGGER / DO-NOT-TRIGGER prose, so the first period is the
  // signal-rich break. Non-greedy match.
  const sentenceCut = sliced.match(/^(.*?[.!?])\s/);
  const body = sentenceCut ? sentenceCut[1] : sliced.replace(/[\s,;:]+\S*$/, '');
  return `${body.trim()}${ELLIPSIS}`;
}

// ─── buildEnrichedPrompt ───────────────────────────────────────────

export function buildEnrichedPrompt(
  projectOrAgent: ProjectWithCommands | EnrichedAgent,
  maybeAgent?: AgentWithModel,
  options: BuildEnrichedPromptOptions = {},
): string {
  let project: ProjectWithCommands;
  let agent: AgentWithModel;
  if (maybeAgent) {
    project = projectOrAgent as ProjectWithCommands;
    agent = maybeAgent;
  } else {
    agent = projectOrAgent as EnrichedAgent;
    project = {
      cwd: agent.cwd,
      ahw: (agent as EnrichedAgent).ahw || agent.workspace,
    } as ProjectWithCommands;
  }

  // Identity anchor — name + id + role at the very top of the prompt.
  // Without this, newly-created agents whose project has an AGENTS.md
  // describing the team (e.g. "agent-hub-lead", "hub-frontend", …) tend
  // to latch onto one of the listed roles instead of their own
  // configured identity. The anchor pins "who you are" before any
  // shared project context can reframe it.
  const displayName = (agent.name || '').trim() || agent.id;
  const roleSuffix = agent.role ? ` · Role: ${agent.role}` : '';
  const identityAnchor = `# You are ${displayName}\n\nAgent id: \`${agent.id}\`${roleSuffix}\n\n`;
  const projectId =
    (project as ProjectWithCommands & { id?: string }).id ||
    (agent as EnrichedAgent).projectId ||
    undefined;
  const projectMode = getProjectMode(project as Project);
  const promptWorktree = !!(options.useWorktree && projectMode !== 'workflow');
  // The sub-agent delegation system has been removed; the roster is now a
  // neutral list of project peers without a delegate-allowlist annotation.
  const rosterSection = projectId
    ? formatProjectAgentRosterSection(peersOnProject(projectId, agent.id))
    : '';
  const systemPromptBody = (agent.systemPrompt || '').trim();
  let prompt: string = identityAnchor + rosterSection + systemPromptBody;

  // Resolve flags used by both the early capability callout and the
  // existing ReAct Loop section further down.
  const isFirstMessage = options.isFirstMessage !== false; // default true for backward compat
  const browserProject = projectId ? findProject(projectId) : null;
  const browserToolsOn = effectiveBrowserToolsEnabled(agent as Agent, browserProject ?? undefined);

  // Browser-automation awareness callout — surfaced near the top of the
  // prompt so the model notices it has live Chromium access before any
  // AGENTS.md / SOUL.md / skill description has a chance to claim "I
  // cannot access URLs". The full operation list and egress caveats
  // remain in the "ReAct Loop" section further down; this is just the
  // attention-grabbing pointer that prevents capability refusals.
  if (browserToolsOn && isFirstMessage) {
    prompt += `\n\n## Browser Automation Available
You have access to a real Chromium browser in this session. When a user asks you to navigate to a URL, take a screenshot, fill out a form, click around a website, scrape a page, or read content from any web page, **do it** — do not claim you lack web access. Drive the browser by emitting a \`<agenthub:react>\` block with a \`browser\` action, e.g. \`{"tool":"browser","op":"navigate","url":"https://example.com"}\`. The full operation list (\`navigate\`, \`click\`, \`type\`, \`extract\`, \`screenshot\`, \`scroll\`, \`back\`, \`forward\`, \`wait\`, \`read_page\`, \`close\`) and the URL-egress caveats are in the **ReAct Loop** section further down — read them before driving sensitive pages.`;
  }

  if (projectId) {
    const awsProject = findProject(projectId);
    const awsProfiles = awsProject ? getProjectAwsSsoProfiles(awsProject) : {};
    const awsNames = Object.keys(awsProfiles).sort((a, b) => a.localeCompare(b));
    if (awsNames.length > 0) {
      prompt += `\n\n## Project AWS (IAM Identity Center)
Configured SSO profiles for this project: ${awsNames.join(', ')}.
This session sets \`AWS_CONFIG_FILE\` to the project-specific config. SSO tokens cache under your per-user HOME.

**Before any AWS CLI work:**
1. Ask which profile to use if the user did not say (e.g. dev, staging, prod).
2. Check login: \`GET $AGENT_HUB_URL/api/projects/${projectId}/aws-sso/status?profile=<name>\` with \`Authorization: Bearer $AGENT_HUB_API_KEY\`.
3. If \`loggedIn\` is false, \`POST $AGENT_HUB_URL/api/projects/${projectId}/aws-sso/login\` with body \`{"profile":"<name>"}\`, give the user the \`loginUrl\` to open in a browser, wait for them to finish, then re-check status.
4. Use \`scripts/aws-whoami.sh --profile <name>\` and \`scripts/aws-q.sh\` with \`--profile <name>\` for reads; confirm profile/region in output.

Do not print access keys or session tokens. Prefer the Hub SSO login API over running \`aws sso login\` directly so the device URL is surfaced in chat.`;
    }
  }

  if (!project.ahw) return prompt;

  const paths = resolveProjectPaths(project as Project, agent as Agent);

  // Project workspace docs (ahw). CLAUDE.md: repo dev commands, architecture, testing —
  // same file Cursor often injects as workspace rules; include here for CLI engines.
  //
  // CLAUDE.md is the single largest per-turn cost in the enriched prompt
  // (22 KB on the agent-hub repo, May 2026 audit). It carries dev-loop
  // guidance that the model only needs to absorb once per session, so we
  // gate it behind `isFirstMessage`. Identity / team files (AGENTS.md,
  // SOUL.md, IDENTITY.md) stay on every turn because the model regularly
  // role-confuses without the identity reminder anchored mid-prompt.
  const baseContextOrder = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'];
  const contextOrder = isFirstMessage ? [...baseContextOrder, 'CLAUDE.md'] : baseContextOrder;
  let agentsMdIncluded = false;
  let identityMdIncluded = false;
  for (const filename of contextOrder) {
    const filePath = contextFilePath(paths, filename);
    if (filePath && existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim()) {
          prompt += `\n\n## ${filename}\n${content}`;
          if (filename === 'AGENTS.md') agentsMdIncluded = true;
          if (filename === 'IDENTITY.md') identityMdIncluded = true;
        }
      } catch {
        /* skip */
      }
    }
  }

  // Identity reaffirmation — only needed when AGENTS.md was loaded.
  // AGENTS.md describes the project's agent team, and newly-created
  // agents routinely pattern-match onto one of those team roles
  // instead of following the system prompt / IDENTITY.md above.
  // Re-pin the identity after the shared context so the model's last
  // instruction on "who am I" is the right one.
  if (agentsMdIncluded) {
    const identitySources = identityMdIncluded
      ? 'your system prompt and IDENTITY.md'
      : 'your system prompt';
    prompt += `\n\n## Identity Reminder\nYou are **${displayName}** (agent id: \`${agent.id}\`). The team descriptions in AGENTS.md above describe the project's agent team — they are context about your collaborators, **not** a role for you to adopt. Your own identity is defined by ${identitySources} at the top of this message. Do not impersonate any other agent listed in AGENTS.md unless that agent's id matches \`${agent.id}\`.`;
  }

  {
    const allSkills = listEnabledSkills(agent.id, paths.skillsDir, agent.allowedSkills ?? null);
    if (allSkills.length > 0) {
      const skillsList = allSkills.map(
        (s) => `- **${s.name}**: ${compressSkillDescription(s.description)}`,
      );
      // First-message turn carries the full "how to load + what's real"
      // contract. Follow-up turns get a tight one-line reminder plus the
      // compressed catalog so the agent can still discover skills it hasn't
      // loaded yet without paying for the preamble every turn.
      const preamble = isFirstMessage
        ? `## Available Skills
To load a skill for your next turn, end your turn with this block (emit as a naked XML tag — do NOT wrap it in backtick/code fences):
<agenthub:skill>
{"name": "<skill-id>", "reason": "<one-liner why>"}
</agenthub:skill>
The SKILL.md body and referenced files will be injected into your next turn. This replaces the native \`Skill\` tool and works uniformly across claude-code, cursor-agent, and codex; calling Skill() with an unregistered id fails with \`Unknown skill\`. Only the skills listed below are real — use their exact \`name\` (any other id will not load). For capabilities not listed, use Bash, WebFetch, or your other normal tools.`
        : `## Available Skills
Load one by ending your turn with \`<agenthub:skill>{"name":"<id>","reason":"..."}</agenthub:skill>\`.`;
      prompt += `\n\n${preamble}

${skillsList.join('\n')}`;
    }
  }

  if (isFirstMessage) {
    const reactExampleJson = browserToolsOn
      ? '{"actions":[{"tool":"wiki","query":"..."},{"tool":"skill","name":"kanban"},{"tool":"web","query":"..."},{"tool":"browser","op":"navigate","url":"https://example.com"}]}'
      : '{"actions":[{"tool":"wiki","query":"..."},{"tool":"skill","name":"kanban"},{"tool":"web","query":"..."}]}';
    const browserToolLines = browserToolsOn
      ? `- \`browser\` — host Chromium via Stagehand (field: \`op\` + operands). Ops: \`navigate\` (\`url\`), \`click\` / \`type\` (\`target\` — natural language or CSS/XPath; \`type\` also needs \`text\`), \`extract\` (optional \`instruction\`, optional JSON \`schema\`), \`screenshot\`, \`scroll\` (\`direction\`: up|down|top|bottom), \`back\`, \`forward\`, \`wait\` (\`condition\`: load|domcontentloaded|networkidle|selector or \`selector:…\`), \`read_page\`, \`close\`. Requires Playwright Chromium on the server and an LLM API key for natural-language \`act\`/\`extract\` (override model with \`STAGEHAND_MODEL\`).
- **Browser egress note (operators / models):** URL policy that blocks private, loopback, metadata-style, and similar targets applies to explicit \`navigate\` (redirect targets during that \`goto\` when CDP Fetch works, plus a committed-URL check), and to the URL after \`back\`/\`forward\`. It is **not** a blanket guarantee on every page transition — e.g. \`act\`/\`click\`-driven link navigations and client-side redirects are not funneled through that path. Hostname/string checks also do not defeat DNS rebinding. Plan network egress and isolation accordingly.`
      : `- **Browser tools** are turned off for this agent (project default or \`browserToolsEnabled: false\`). Omit browser entries from the ReAct \`actions\` array — the host will reject them.`;
    const previewEnabledForPrompt = Boolean(project.prEnv?.preview?.enabled);
    const previewToolLines = previewEnabledForPrompt
      ? `\n- \`preview\` — observe and drive **this session's dev preview** after the human starts it via **Start preview** (field: \`op\` + operands). Observe ops (always on): \`state\`, \`logs\` (optional \`tail\`, default 200). Drive ops (host Chromium pinned to the preview's origin${browserToolsOn ? '' : ' — currently OFF because browser tools are disabled for this agent'}): \`screenshot\`, \`navigate\` (\`route\` — a path like \`/settings\`, never a full URL), \`click\` / \`type\` (\`target\`; \`type\` also needs \`text\`), \`scroll\`, \`wait\`, \`read_page\`, \`extract\`, \`close\`. You cannot start or stop the preview — if none is running you'll get a "not running" observation; ask the human to start it.`
      : '';

    prompt += `\n\n## ReAct Loop
When you need extra context mid-answer, use a host-mediated ReAct action block (emit as a naked XML tag — do NOT wrap it in backtick/code fences):
<agenthub:react>
${reactExampleJson}
</agenthub:react>
Replace each string with real values you need (the example must stay valid JSON — never replace the \`actions\` array with bracket-dot-dot-dot-bracket or other non-JSON shorthand).
Supported tools:
- \`wiki\` — hybrid project wiki retrieval (field: \`query\`).
- \`skill\` — load a registered Agent Hub skill (field: \`name\`).
- \`web\` — live web search via Serper (field: \`query\`). Only works when the server has \`SERPER_API_KEY\` or \`WEB_SEARCH_API_KEY\` set; otherwise the host returns a clear configuration error.
${browserToolLines}${previewToolLines}
The host executes actions, appends a compact observation + loaded context, and may auto-continue the same turn within budget caps.`;
  }

  {
    if (projectId) {
      const wikiContext = getWikiContext(projectId);
      if (wikiContext) {
        prompt += '\n\n' + wikiContext;
      }

      // Static instructional blocks — only on first message to save tokens
      if (isFirstMessage) {
        prompt += `\n\n## Wiki Documentation Guidelines
After significant work, update the wiki to preserve knowledge. Search first (\`GET /api/projects/${projectId}/wiki?q=...\`), update existing pages rather than duplicating. Create via \`POST /api/projects/${projectId}/wiki\` with \`{title, content, category, updatedBy}\`. Update via \`PUT /api/projects/${projectId}/wiki/:slug\`. Categories: general, api-docs, architecture, conventions, test-patterns, troubleshooting, onboarding. Focus on decisions, patterns, and knowledge that would be lost when the session ends.`;

        if (projectMode !== 'workflow') {
          const linkedCardLine = options.sessionHasLinkedCard
            ? `**This session is already linked to a kanban card** (the card whose assignment spawned you). Do NOT create another card for this task — pick up the linked card, move it through the column lifecycle (To Do → In Progress → Review → Done), and self-report progress via comments on that card. Only create *new* cards for genuinely separate follow-up work you discover along the way.`
            : `Use the \`kanban\` skill and the \`scripts/kanban-create-card.sh\` / \`scripts/kanban-move-card.sh\` wrappers (auth + base URL are handled for you). Do **not** call the board API with hand-rolled curl — JWT-enabled deployments return 401 without \`x-api-key\`. Skip cards for trivial tasks.
When creating cards: use a **concise title** (under 60 chars) summarizing the problem/task, and include **acceptance criteria** as a bulleted checklist in the description. \`kanban-create-card.sh\` auto-links via \`$AGENT_HUB_SESSION_ID\` (this auto-renames the sidebar to the card title). On failure, log \`scripts/log-tool-error.sh\` and surface the stderr — do not treat a non-zero exit as success.`;
          prompt += `\n\n## Kanban Board — Task Self-Reporting
${linkedCardLine}

### Auto-closing a card as duplicate / already-done
If you pick up a card and discover the work is redundant — either covered by an earlier ticket or already shipped — don't just leave the card parked. End your turn with a fenced block like:
\`\`\`
<agenthub:close-card>
{"reason": "duplicate", "note": "Covered by card 5c8f2a — see PR #313.", "duplicateOfCardId": "5c8f2a..."}
</agenthub:close-card>
\`\`\`
- \`reason\`: \`"duplicate"\` or \`"already-done"\` (required)
- \`note\`: one-line explanation shown in the auto-close comment (required)
- \`duplicateOfCardId\`: optional, the canonical card id the work duplicates
The server moves the session's linked card to Done and appends an explanatory comment referencing this session. Malformed payloads (missing/invalid fields) are rejected with a system message and the card is **not** moved.`;
        }

        if (project.prEnv?.preview?.enabled) {
          prompt += `\n\n## Worktree preview (lifecycle is human-only)
Do **not** emit \`<agenthub:preview>\` blocks — the host ignores them. Only the human starts or stops the dev preview using **Start preview** in the chat toolbar (first boot can take several minutes). Once it is running you can observe and drive it yourself with the ReAct \`preview\` tool — check \`{"tool":"preview","op":"state"}\`, read boot/runtime logs with \`"op":"logs"\`, and verify UI changes with \`"op":"screenshot"\` plus \`navigate\`/\`click\`/\`type\`. Your file edits may hot-reload the running preview automatically.`;
        }
      }
    }
  }

  // Yesterday's notes (~1.5 KB) are useful when a session starts cold but
  // rarely add signal on every follow-up turn, so gate them behind
  // `isFirstMessage`. MEMORY.md (long-term) and today's notes still ship
  // on every turn — they carry the live context the model needs for
  // in-session continuity.
  const memoryContext = getMemoryContext(project.ahw, { includeYesterday: isFirstMessage });
  if (memoryContext) {
    prompt += '\n\n' + memoryContext;
  }

  // Tasks-only projects (no `githubRepo` field, no git remote) must not get
  // the GitHub-Connected lifecycle prompt or any PR/branch guidance. We
  // prefer the declarative `project.githubRepo` field; if it is unset we
  // fall back to a `git remote -v` probe to preserve historical behavior
  // for projects that pre-date the field.
  let isGitHubConnected = Boolean((project as Project).githubRepo);
  if (!isGitHubConnected) {
    try {
      // Pipe stderr only (ignore) so prompt tests' temp dirs — not git repos —
      // do not print "fatal: not a git repository" to the test runner.
      const remoteOutput = execSync('git remote -v', {
        cwd: project.cwd,
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      isGitHubConnected = remoteOutput.includes('github.com');
    } catch {}
  }

  // Agent Hub-hosted repos (gitHost 'agenthub') have the full branch/PR
  // lifecycle without GitHub: origin is the Hub's repo and PRs are
  // native. Treat them as "connected" for lifecycle guidance and label
  // the push target accordingly.
  const repoHostedOnHub = (project as Project).gitHost === 'agenthub';
  if (repoHostedOnHub) isGitHubConnected = true;
  const pushTargetLabel = repoHostedOnHub ? 'Agent Hub' : 'GitHub';

  const finalizeConfigured = options.finalizeConfigured === true;
  const finalizeTargetedTestGuidance =
    'When the Finalize runner is configured, only run tests you added or changed while debugging them. Existing tests and broader lint/check suites run in the runner/reviewer workflow.';

  // Static instructional blocks — only on first message to save tokens
  if (isFirstMessage) {
    if (finalizeConfigured && isGitHubConnected && projectMode !== 'workflow') {
      prompt += `\n\n## Finalize Code Changes — No Direct Ship
This project has \`.agent-hub/ci.yaml\` configured. **You must not run \`git push\` or \`gh pr create\`** — the spawn environment blocks them until the human operator completes **Finalize Code Changes** on the session (rebase, review, tests) and clicks **Push to ${pushTargetLabel}**.

Your job ends at a clean local commit on the feature branch after tests pass. Do not ask permission to push or open a PR.`;
      if (promptWorktree && options.sessionWorktreePath) {
        const branchHint = options.sessionWorktreeBranch
          ? ` (\`${options.sessionWorktreeBranch}\`)`
          : '';
        prompt += `

**Session worktree only:** All \`git add\` / \`git commit\` / test runs that should ship must happen in this session's worktree — \`${options.sessionWorktreePath}\`${branchHint}. The project checkout at \`${project.cwd}\` is a **different** working copy; commits there do **not** enable Finalize on this session. Never \`cd\` to the project checkout to commit.`;
      }
    }

    // Branch the agent should fork from / rebase onto. Prefer an explicit
    // per-card PR base override, else the detected repo default branch
    // (resolved by the caller), else `main`. Avoids telling the agent to
    // `git checkout main` / `rebase on origin/main` in repos whose default
    // branch is `master`.
    const lifecycleBaseBranch = (
      options.branchPrBase?.trim() ||
      options.defaultBranch?.trim() ||
      'main'
    ).trim();

    if (options.omitDevLifecycle) {
      // Non-shipping helper (reviewer/advisor): emit no branch/ship guidance.
    } else if (isGitHubConnected && projectMode !== 'workflow') {
      const lifecycleStep1 = options.sessionHasLinkedCard
        ? `1. **Kanban Card**: Your session is **already linked to a card** — do NOT create a new one. Move that card to "In Progress" if it isn't already, and treat its acceptance criteria as the contract for this work.`
        : `1. **Kanban Card**: Check \`GET /api/projects/${projectId}/board\`. Create a card with a **concise title** (under 60 chars, summarizing the problem) and a description that includes:
   - **Problem**: 1-2 sentences on what's wrong or what's needed
   - **Acceptance Criteria**: Bulleted checklist of conditions that must be met for this to be complete
   Include \`session_id: "$AGENT_HUB_SESSION_ID"\` when creating the card — this links it to your session and **auto-renames the sidebar** to the card title.
   Move to "In Progress" when you begin.`;
      prompt += `\n\n## Development Lifecycle — GitHub-Connected Project
This project is connected to GitHub. Follow this lifecycle for changes:

${lifecycleStep1}
2. **Branch**: \`git checkout ${lifecycleBaseBranch} && git pull && git checkout -b feature/<name>\`${promptWorktree ? ' (worktree — safe to branch here)' : ''}
3. **Implement**: Follow existing patterns.${project.commands?.install ? ` Install: \`${project.commands.install}\`` : ''}
4. **Test & Lint**: ${finalizeConfigured ? `Run **targeted** tests only while iterating. ${finalizeTargetedTestGuidance} **Do not run the full \`.agent-hub/ci.yaml\` suite in-session** — the human uses **Finalize Code Changes** for that; read pass/fail and step logs in the session strip.` : `${project.commands?.test ? `\`${project.commands.test}\`` : '`npm test`'}${project.commands?.lint ? ` / \`${project.commands.lint}\`` : ''} — fix before proceeding`}
5. **${finalizeConfigured ? 'Commit (Finalize ships)' : 'Ship'}**: Rebase on latest \`origin/${lifecycleBaseBranch}\`${finalizeConfigured ? ', commit locally' : ', run tests/lint, and commit'}.${finalizeConfigured ? ` **Stop there** — do not push or open a PR. The human uses **Finalize Code Changes** on the session, then **Push to ${pushTargetLabel}** after gates pass.` : ` Commit, push, and open the PR ${repoHostedOnHub ? 'via the Agent Hub API (`ah-api.sh POST "/api/projects/$PROJECT_ID/pulls"` with headBranch/title/body — this repo is hosted on Agent Hub, do NOT use `gh pr create`)' : 'with `gh pr create`'} yourself. Keep PR title concise (<70 chars) and include **Summary** + **Test plan** in the body. If linked to a kanban card, include the card reference in the PR body and add a comment on the card containing the PR URL.`} Never merge your own PR.

**Existing PRs**: Check out branch, read failures (\`gh pr checks\`), fix, commit${finalizeConfigured ? ' locally' : ', and push to the same branch'}. Do not open duplicate PRs. Do NOT merge.
**Shortcuts**: Trivial fixes skip card creation. Found a bug? Create a "To Do" card.`;
    } else if (isGitHubConnected && projectMode === 'workflow') {
      prompt += `\n\n## Development — Workflow mode
This project is in **workflow** mode (not the default dev/kanban automation profile). Prioritize workflow definitions, runs, and step outcomes. Work in the project checkout — **per-session git worktrees are off**, and the autonomous kanban→server-PR lifecycle described elsewhere does not apply. Use Git, tests, and the wiki as usual; coordinate shipping through the product's workflow surfaces rather than Agent Hub session PR automation.`;
    } else if (promptWorktree) {
      const worktreeShipHint = finalizeConfigured
        ? `, rebase on \`origin/${lifecycleBaseBranch}\`, run tests, and commit — **do not push or open a PR** (Finalize Code Changes handles ship)`
        : `, then ship by rebasing on \`origin/${lifecycleBaseBranch}\`, pushing, and opening/updating a PR with \`gh\``;
      prompt += `\n\n## Git Workflow
You are in a git worktree. Never commit to main. Commit to the current feature branch${worktreeShipHint}. Do not merge your own PR.`;
    }

    // Bias to Action — single block, parameterized over the three modes
    // (workflow, normal-no-linked-card, normal-with-linked-card). Before
    // the May 2026 prompt-trim audit these were three near-duplicate
    // blocks each restating "do not emit questions like…" and the
    // "ask first" exceptions — saved ~2 KB on the first message.
    const biasToActionSteps =
      projectMode === 'workflow'
        ? `**Just do the work:** implement, test, and commit in the project checkout following team conventions.`
        : finalizeConfigured
          ? options.sessionHasLinkedCard
            ? `**Just do the work:**
1. Move your **already-linked** kanban card to In Progress (do NOT create a new card).
2. Implement on a feature branch.
3. Rebase and commit locally — run only tests you added or changed while fixing. Existing tests run in Finalize. **Do not push or open a PR** (human uses Finalize Code Changes).`
            : `**Just do the work:**
1. Create the kanban card (concise title + acceptance criteria + \`session_id\`).
2. Move it to In Progress.
3. Implement on a feature branch.
4. Rebase and commit locally — run only tests you added or changed while fixing. Existing tests run in Finalize. **Do not push or open a PR** (human uses Finalize Code Changes).`
          : options.sessionHasLinkedCard
            ? `**Just do the work:**
1. Move your **already-linked** kanban card to In Progress (do NOT create a new card).
2. Implement on a feature branch.
3. Rebase, test, commit, push, and open/update the PR.
4. Move card to Review and comment with PR URL.`
            : `**Just do the work:**
1. Create the kanban card (concise title + acceptance criteria + \`session_id\`).
2. Move it to In Progress.
3. Implement on a feature branch.
4. Rebase, test, commit, push, and open the PR.
5. Move card to Review and comment with PR URL.`;
    const biasToActionScope =
      projectMode === 'workflow'
        ? 'starting implementation'
        : finalizeConfigured
          ? 'creating a card or starting implementation'
          : 'creating a card, shipping a PR, or starting implementation';
    const biasToActionTitle = finalizeConfigured
      ? "Bias to Action — Don't Ask, Just Build"
      : "Bias to Action — Don't Ask, Just Ship";
    prompt += `\n\n## ${biasToActionTitle}
When a user describes a problem, feature, or change, **do not ask permission for ${biasToActionScope}.** The default answer is "yes" ~95% of the time, and the review process (PR review, card rejection, human merge gate) lets you act now and be corrected cheaply later. Skip prompts like "Should I implement this?", "Want me to open a PR?", "Should I add a test?", "Do you want me to create a card?".

${biasToActionSteps}

**When to actually ask first** (rare — use \`agenthub:ask\` picker or prose):
- The request is genuinely ambiguous and multiple reasonable interpretations would produce very different work (e.g. "refactor this" with no direction).
- The action is destructive and irreversible (e.g. \`git push --force\` to main, deleting production data, rotating shared secrets).
- The user has explicitly asked you to propose a plan before executing.

Everything else: ship it. A rejected change costs a few minutes; a blocked agent costs the user's entire turn.

## Research Questions — Answer on the Spot, Don't Card It
When a user asks a research or investigation question (how something works, why it behaves a certain way, where a feature lives, what the current state of X is), just do the research and answer inline. Do **not** offer to open a ticket for the investigation itself. Cards are for work to ship, not questions to answer — if research surfaces a concrete bug or feature, *then* create a card for that follow-up work.

## No Shell — Don't Tell the User to Run Commands
The user is talking to you through a web/chat UI and has **no shell access**. They cannot run \`npm\`, \`git\`, \`curl\`, or any other terminal command. Never respond with "run this in your terminal", a copy-pasteable command block presented as instructions, or "you can check by running…". You have a \`Bash\` tool — when work needs a command, **run it yourself** and report the actual output. The only acceptable shell snippets in chat are ones you've already executed (showing what *you* ran) or short illustrative examples inside a larger explanation, never something the user is expected to execute.`;

    prompt += `\n\n## Memory Instructions
You have access to memory files. The memory context above shows your current knowledge. Mention important learnings (decisions, preferences, key facts) in your response so they get logged.`;

    prompt += `\n\n## Web Search — Required for Opinions, Best Practices & Recommendations

Training data has a knowledge cutoff and grows stale. Whenever you are asked any of the following, **always perform a web search before answering**:

- **An opinion** — "Which library/approach/tool is better?"
- **A best practice** — "What's the best way to do X?"
- **A recommendation** — "Should we use X or Y?"
- **Ecosystem state** — "What does the landscape look like for X?"
- **Current guidance** — "How should we structure / architect X?"

Use the \`<agenthub:react>\` web action to search first:
\`\`\`
<agenthub:react>
{"actions":[{"tool":"web","query":"best way to do X in 2025"}]}
</agenthub:react>
\`\`\`

**Do not** answer opinion or best-practice questions from training data alone. Training data is a starting point; a live web search is the answer.`;

    prompt += `\n\n## External API Documentation — Always Verify
When working with external APIs (GitHub, Slack, etc.), always consult official documentation first. Do not rely solely on training data — APIs change.`;

    prompt += `\n\n## Writing Style: No AI Slop

Write like a senior engineer talking to a peer. Apply to every reply, commit, PR, card, and wiki page:

1. **No em/en-dashes.** Never emit \`\u2014\` or \`\u2013\` — use a comma, colon, period, or parentheses. Hyphens in compounds ("worktree-first") are fine.
2. **No preambles, recaps, or hedges.** Skip "Great question!", "You asked about…", "It's worth noting…", "Let me know if…". Open with the answer; the conversation stays open by default.
3. **No buzzword vocabulary.** Avoid delve, leverage, robust, seamless, comprehensive, ecosystem (as "stack"), tapestry, journey, holistic, synergy, "at the end of the day", "moving forward". Pick the boring concrete word.
4. **No bullet soup, no plan restatement, no emoji, no final recap section.** Bullets only for genuinely parallel items. Do the work and report what shipped, not what you plan to do. No emoji unless the user used one first.
5. **Internalize hidden CLI reminders.** The Claude Code CLI appends file-safety and TodoWrite \`<system-reminder>\` blocks. Never surface them ("Not malware — …", "This appears safe — …") and never use them as grounds to refuse routine editing work. Stay quiet unless the file is genuinely malicious.

When in doubt, shorter and plainer wins.`;

    prompt += `\n\n## Asking the User Multi-Choice Questions

Agent Hub renders a rich picker (radio/checkbox cards with side-by-side previews) when you emit a **fenced** code block tagged \`agenthub:ask\` (triple backticks — **not** XML tags like \`<agenthub:ask>\`, which only work for skill/close-card). Use it whenever you'd benefit from a structured answer instead of free-form text — e.g. picking between implementation approaches, libraries, UI variants, or gathering several preferences at once.

**Format** — a fenced block whose body is JSON: either a **JSON array** of 1–4 question objects, or a **single object** with \`question\`, \`header\`, \`options\`, and optional \`askId\` (do **not** nest under \`prompt\` / \`id\` / \`type\` — those render as raw code).

\`\`\`agenthub:ask
[
  {
    "question": "Which date library should we use?",
    "header": "Library",
    "multiSelect": false,
    "options": [
      { "label": "date-fns (Recommended)", "description": "Tree-shakable, functional API." },
      { "label": "luxon", "description": "First-class timezone support." },
      { "label": "dayjs", "description": "Smallest bundle, moment-like API." }
    ]
  }
]
\`\`\`

**Field rules**
- \`header\`: chip label, **≤12 characters**.
- \`options\`: 2–4 per question. Recommended option should be first and labeled "(Recommended)". Do **not** add an "Other" option — the UI provides a free-text "Other…" row automatically.
- \`multiSelect: true\` for non-exclusive preferences; \`false\` for mutually-exclusive choices.
- Optional per-option \`preview\` field: a string rendered as a monospace/code panel next to the options — use it for side-by-side comparison of mockups, code snippets, or config examples. Only applies to single-select questions.

**Answer round-trip** — the user's reply arrives as a normal chat message containing a matching \`agenthub:ask:answer\` fenced block of shape \`{ "askId": "...", "answers": {questionText: value}, "annotations": {questionText: {notes?, preview?}} }\`. For single-select questions \`value\` is a string (the chosen label or free-text from "Other"); for multi-select questions \`value\` is an array of strings. \`askId\` echoes the id of the picker you emitted so you can tie the answer to the original question. Read the answers and continue.`;
  }

  // The <delegate>/<handoff> sub-agent system has been removed. We no longer
  // inject HANDOFF FROM transcripts on session start nor any Delegation/
  // Sub-Agents/Handoff guidance on lead agents. Agents are now flat
  // ("full-stack" or otherwise dedicated) and coordinate via plain chat or
  // conference rooms. The Lead Response Contract still applies for any
  // agent whose `role === 'lead'` because it's a structured-output rule,
  // not a delegation instruction.
  if (agent.role === 'lead' && isFirstMessage) {
    prompt += `\n\n## Lead Response Contract
For non-trivial execution updates, end with a compact structured block in prose (not JSON) using these headings:
- \`Goal\`
- \`Actions taken\`
- \`Evidence\`
- \`Result\`
- \`Next step\` *(optional — only for genuinely deferred work)*

Do not omit \`Evidence\`. **\`Next step\` is optional and must NOT be a parking lot for unexecuted work.** If the next action is something you can do right now in this same turn — write the code, open the PR, run the test, ask the picker question — **do it in this turn** and fold the result into \`Actions taken\` / \`Result\` instead of naming it as a follow-up. Only include \`Next step\` when the work is genuinely deferred: a follow-up card you've already created (cite its id), a question that needs the user's answer, or a hand-off blocked on something outside this turn. Lines like "Next step: implement X" or "Next step: open the PR" are the anti-pattern this rule exists to kill.`;
  }

  const outerOrch = formatOuterOrchestrationPromptAppend(
    options.orchestrationPhase ?? null,
    options.orchestrationMetaJson ?? null,
  );
  if (outerOrch) prompt += `\n\n${outerOrch}`;

  // Active-PR awareness. When a previous session for this kanban card
  // already opened a PR (see `auto-git.ts` → `setCardPrUrl`), the server
  // surfaces the URL here so a context-resumed or autonomous-redispatched
  // session does not blindly run `gh pr create` and produce a duplicate PR
  // for the same branch (the recurring failure pattern documented at
  // duplicate-PR investigation in 2026-05-14 notes). The server-side
  // auto-PR flow dedupes by branch, but it cannot intercept `gh pr create`
  // calls that the spawned agent runs from its own Bash tool — this prompt
  // block is the contract-level fix.
  if (options.branchPrUrl) {
    const baseSuffix = options.branchPrBase ? ` (base: \`${options.branchPrBase}\`)` : '';
    prompt += `\n\n## Active Pull Request
A pull request is already open for this worktree's branch: ${options.branchPrUrl}${baseSuffix}

Do **NOT** run \`gh pr create\` — that produces a duplicate PR for the same branch (and possibly a different base). Commit and push to the existing branch instead; GitHub attaches new commits to the open PR automatically. If you genuinely believe a new PR is needed (e.g. you intentionally changed the base), ask the user first.`;
  }

  logEnrichedPromptSize(prompt, agent.id, isFirstMessage, options.sessionId ?? null);
  return prompt;
}

/**
 * Total enriched-prompt byte size observability.
 *
 * The audit (May 14 2026) found that the only existing signal for prompt
 * bloat fires at the argv soft cap (100 KB, `SAFE_ARG_STRLEN_BYTES`), which
 * means anything between 0 and 100 KB was invisible. This log emits the
 * final byte size once per build so growth is graphable below the
 * tripwire. `console.log` is intentional (matches the rest of chat.ts's
 * structured logs); suppressed under vitest so test runs stay clean.
 *
 * Visible for tests via `__resetEnrichedPromptSizeForTest` and the
 * `PROMPT_SIZE_LOG_FORCE` env var.
 */
const ENRICHED_PROMPT_SIZE_LOG_PREFIX = '[enriched-prompt]';

function shouldEmitEnrichedPromptSizeLog(): boolean {
  if (process.env.PROMPT_SIZE_LOG_FORCE === '1') return true;
  return process.env.NODE_ENV !== 'test';
}

export function logEnrichedPromptSize(
  prompt: string,
  agentId: string,
  isFirstMessage: boolean,
  sessionId: string | null,
): number {
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (shouldEmitEnrichedPromptSizeLog()) {
    const sessionSuffix = sessionId ? ` session=${sessionId}` : '';
    console.log(
      `${ENRICHED_PROMPT_SIZE_LOG_PREFIX} bytes=${bytes} agent=${agentId} firstMessage=${isFirstMessage}${sessionSuffix}`,
    );
  }
  return bytes;
}

/**
 * One-shot pending skill context for the next model turn.
 * Clears the DB column **before** building the prompt suffix so a failed
 * `UPDATE` never pairs an in-memory injection with a still-stored value
 * (which would re-append on every later turn until the clear succeeds).
 */
export function consumePendingSkillInjection(
  pendingRaw: string | null | undefined,
  clearPending: () => void,
): { suffix: string; forceSystemPromptThisTurn: boolean } {
  const trimmed = pendingRaw?.trim() || '';
  if (!trimmed) return { suffix: '', forceSystemPromptThisTurn: false };
  try {
    clearPending();
    return { suffix: `\n\n${trimmed}`, forceSystemPromptThisTurn: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[skill-invoke] failed to clear pending_skill_context:', message);
    return { suffix: '', forceSystemPromptThisTurn: false };
  }
}

export { stripAssistantControlBlocks };

export function detectReActBlock(text: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Mask fenced code-block bodies so documentation examples that show
  // `<agenthub:react>...` syntax inside ``` / ~~~ aren't parsed as
  // real ReAct invocations. See the longer rationale on
  // `detectSkillBlock` — the same auto-continuation feedback loop
  // applied to ReAct blocks before this guard was in place.
  const scanned = stripFencedCodeBlockBodies(text);
  const re = /<agenthub:react>\s*[\s\S]*?\s*<\/agenthub:react>/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(scanned)) !== null) {
    last = match[0];
  }
  if (last) return last;
  // Fallback: handle agents that wrapped the block in backtick fences per
  // the documentation example. Only try the LAST fenced block so we don't
  // accidentally fire on mid-message usage examples.
  return detectTagBlockInLastFence(text, 'agenthub:react');
}

export function parseReActBlock(raw: string): ParsedReAct | ParsedReActMalformed {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'malformed', detail: 'Empty react block payload' };
  }
  const tagMatch = raw.match(/<agenthub:react>\s*([\s\S]*?)\s*<\/agenthub:react>/i);
  const payload = (tagMatch ? tagMatch[1] : raw).trim();
  if (Buffer.byteLength(payload, 'utf-8') > MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES) {
    return {
      error: 'malformed',
      detail: `ReAct block JSON exceeds ${MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES} byte cap`,
    };
  }
  // Tolerate fenced/prose-wrapped/multi-line bodies — see action-block-parsing.ts.
  const normalized = extractJsonFromTagBody(payload);
  let parsed: unknown;
  try {
    parsed = normalized === null ? JSON.parse(payload) : JSON.parse(normalized);
  } catch (err) {
    return { error: 'malformed', detail: `Invalid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'malformed', detail: 'ReAct block payload must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.actions)) {
    return { error: 'malformed', detail: 'Missing required array field: actions' };
  }
  if (obj.actions.length > HOST_REACT_ACTIONS_PARSE_CAP) {
    return {
      error: 'malformed',
      detail: `actions array exceeds maximum of ${HOST_REACT_ACTIONS_PARSE_CAP} entries`,
    };
  }
  const actions: ReActAction[] = [];
  for (const item of obj.actions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'malformed', detail: 'Each action must be an object' };
    }
    const a = item as Record<string, unknown>;
    if (a.tool === 'wiki') {
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (!query) return { error: 'malformed', detail: 'wiki action requires non-empty query' };
      actions.push({ tool: 'wiki', query });
      continue;
    }
    if (a.tool === 'skill') {
      const name = typeof a.name === 'string' ? a.name.trim() : '';
      if (!name) return { error: 'malformed', detail: 'skill action requires non-empty name' };
      actions.push({ tool: 'skill', name });
      continue;
    }
    if (a.tool === 'web') {
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (!query) return { error: 'malformed', detail: 'web action requires non-empty query' };
      actions.push({ tool: 'web', query });
      continue;
    }
    if (a.tool === 'browser') {
      const op = typeof a.op === 'string' ? a.op.trim().toLowerCase() : '';
      if (!op || !BROWSER_REACT_OP_SET.has(op)) {
        return {
          error: 'malformed',
          detail: 'browser action requires op as a supported browser operation',
        };
      }
      const url = typeof a.url === 'string' ? a.url : undefined;
      const targetRaw =
        (typeof a.target === 'string' ? a.target : undefined) ||
        (typeof (a as { selector_or_description?: unknown }).selector_or_description === 'string'
          ? String((a as { selector_or_description: string }).selector_or_description)
          : undefined);
      const target = targetRaw?.trim() || undefined;
      const text = typeof a.text === 'string' ? a.text : undefined;
      const instruction = typeof a.instruction === 'string' ? a.instruction : undefined;
      const direction = typeof a.direction === 'string' ? a.direction : undefined;
      const condition = typeof a.condition === 'string' ? a.condition : undefined;
      let schema: Record<string, unknown> | undefined;
      if (
        a.schema !== undefined &&
        a.schema !== null &&
        typeof a.schema === 'object' &&
        !Array.isArray(a.schema)
      ) {
        schema = a.schema as Record<string, unknown>;
      }
      if (op === 'navigate' && !url?.trim()) {
        return { error: 'malformed', detail: 'browser navigate requires non-empty url' };
      }
      if ((op === 'click' || op === 'type') && !target) {
        return {
          error: 'malformed',
          detail: `browser ${op} requires target (or selector_or_description)`,
        };
      }
      if (op === 'type' && text === undefined) {
        return { error: 'malformed', detail: 'browser type requires text' };
      }
      if (op === 'scroll' && !direction?.trim()) {
        return { error: 'malformed', detail: 'browser scroll requires direction' };
      }
      if (op === 'wait' && !condition?.trim()) {
        return { error: 'malformed', detail: 'browser wait requires condition' };
      }
      if (op === 'extract' && schema && !instruction?.trim()) {
        return {
          error: 'malformed',
          detail: 'browser extract with schema requires instruction',
        };
      }
      actions.push({
        tool: 'browser',
        op,
        url,
        target,
        text,
        instruction,
        schema,
        direction,
        condition,
      });
      continue;
    }
    if (a.tool === 'preview') {
      const op = typeof a.op === 'string' ? a.op.trim().toLowerCase() : '';
      if (!op || !PREVIEW_REACT_OP_SET.has(op)) {
        return {
          error: 'malformed',
          detail: 'preview action requires op as a supported preview operation',
        };
      }
      const route = typeof a.route === 'string' ? a.route.trim() : undefined;
      const target = (typeof a.target === 'string' ? a.target : undefined)?.trim() || undefined;
      const text = typeof a.text === 'string' ? a.text : undefined;
      const instruction = typeof a.instruction === 'string' ? a.instruction : undefined;
      const direction = typeof a.direction === 'string' ? a.direction : undefined;
      const condition = typeof a.condition === 'string' ? a.condition : undefined;
      const tail =
        typeof a.tail === 'number' && Number.isFinite(a.tail) ? Math.floor(a.tail) : undefined;
      let schema: Record<string, unknown> | undefined;
      if (
        a.schema !== undefined &&
        a.schema !== null &&
        typeof a.schema === 'object' &&
        !Array.isArray(a.schema)
      ) {
        schema = a.schema as Record<string, unknown>;
      }
      if (op === 'navigate' && !route?.startsWith('/')) {
        return {
          error: 'malformed',
          detail: 'preview navigate requires route starting with "/" (path within the preview app)',
        };
      }
      if ((op === 'click' || op === 'type') && !target) {
        return { error: 'malformed', detail: `preview ${op} requires target` };
      }
      if (op === 'type' && text === undefined) {
        return { error: 'malformed', detail: 'preview type requires text' };
      }
      if (op === 'scroll' && !direction?.trim()) {
        return { error: 'malformed', detail: 'preview scroll requires direction' };
      }
      if (op === 'wait' && !condition?.trim()) {
        return { error: 'malformed', detail: 'preview wait requires condition' };
      }
      actions.push({
        tool: 'preview',
        op,
        route,
        tail,
        target,
        text,
        instruction,
        schema,
        direction,
        condition,
      });
      continue;
    }
    return {
      error: 'malformed',
      detail: 'Unsupported action.tool; expected "wiki", "skill", "web", "browser", or "preview"',
    };
  }
  return { actions };
}

export { clipUtf8StringToMaxBytes };

/** Last `maxSuffixBytes` UTF-8 bytes of `s`, aligned to a character boundary. */
export function utf8SuffixMaxBytes(s: string, maxSuffixBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxSuffixBytes) return s;
  let start = buf.length - maxSuffixBytes;
  while (start < buf.length && start > 0 && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString('utf-8');
}

export function mergePendingContextWithCap(
  existingRaw: string,
  additionRaw: string,
  maxBytes = MAX_PENDING_CONTEXT_BYTES,
): string {
  const existing = existingRaw.trim();
  const addition = additionRaw.trim();
  if (!addition) return existing;
  const combined = existing ? `${existing}\n\n${addition}` : addition;
  if (Buffer.byteLength(combined, 'utf-8') <= maxBytes) return combined;

  const truncatedMarker = '\n\n[Truncated: pending context byte cap reached]';
  const markerBytes = Buffer.byteLength(truncatedMarker, 'utf-8');
  const maxBodyBytes = Math.max(0, maxBytes - markerBytes);

  const additionBytes = Buffer.byteLength(addition, 'utf-8');
  if (additionBytes >= maxBodyBytes) {
    const clipped = clipUtf8StringToMaxBytes(addition, maxBodyBytes);
    return `${clipped}${truncatedMarker}`.trim();
  }

  const remainingForExisting = maxBodyBytes - additionBytes - Buffer.byteLength('\n\n', 'utf-8');
  const existingTail = utf8SuffixMaxBytes(existing, Math.max(0, remainingForExisting)).trim();
  const body = existingTail ? `${existingTail}\n\n${addition}` : addition;
  return `${body}${truncatedMarker}`.trim();
}

/** Shape returned by {@link ChatHandlerDeps.resolveSlashSkill} (success or error). */
export interface SlashSkillResolveShape {
  error?: string;
  skillName?: string;
  userArgs?: string;
}

export interface SlashSkillTurnAugmentation {
  slashSkillSuffix: string;
  cliContent: string;
}

/**
 * Slash `/skillId` turns: inject skill body via `loadSkillByName` into the
 * enriched prompt suffix, and pass only the user args to the CLI as
 * `cliContent` (no legacy `<skill>` XML). Kept exported for regression
 * tests — `createChatHandler` delegates here.
 */
export function augmentChatTurnForSlashSkill(args: {
  slashResult: SlashSkillResolveShape | null;
  project: Project;
  agent: Agent;
  sessionId: string;
  stmts: Stmts;
  broadcast: BroadcastFn;
  isAutoContinuation: boolean;
  content: string;
}): SlashSkillTurnAugmentation {
  const { slashResult, project, agent, sessionId, stmts, broadcast, isAutoContinuation, content } =
    args;
  let cliContent = content;
  let slashSkillSuffix = '';
  if (slashResult && !slashResult.error && slashResult.skillName && !isAutoContinuation) {
    const userArgs = slashResult.userArgs || 'Please use this skill as instructed.';
    const slashSkillsDir = resolveWorkspaceSkillsDir(project, agent);
    slashSkillSuffix = `\n\n${loadSkillByName({
      name: slashResult.skillName,
      reason: 'slash-command',
      paths: { skillsDir: slashSkillsDir },
      sessionId,
      stmts,
      broadcast,
    })}`;
    cliContent = userArgs;
  }
  return { slashSkillSuffix, cliContent };
}

// ─── createChatHandler (factory) ───────────────────────────────────

export default function createChatHandler(deps: ChatHandlerDeps): ChatHandlerResult {
  const {
    broadcast,
    findAgent,
    getEnrichedAgent,
    activeProcesses,
    activeDelegationSessions,
    autonomousProjects,
    getClaudeBin,
    getCursorBin,
    getGeminiBin,
    getCodexBin,
    uploadsDir,
    resolveSlashSkill,
    createCursorChat: _createCursorChat,
    ensureWorktree,
    drainQueue,
    handleDelegation,
    handleDelegationCancel,
    synthesizeResults,
    parseDelegateBlock,
    getPreviewRuntime,
    getPreviewComposeRuntime,
    autoCommitAndPR,
    tryAutonomousDispatch,
  } = deps;

  function saveErrorMessage(
    sessionId: string,
    messageId: string,
    engine: string,
    model: string,
    errorText: string,
  ): string {
    const content = `⚠️ Error: ${errorText}`;
    try {
      stmts.addMessage.run(
        messageId,
        sessionId,
        'assistant',
        content,
        engine,
        model,
        null,
        null,
        null,
        null,
        null,
      );
      stmts.touchSession.run(sessionId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to persist error message:', message);
    }
    return content;
  }

  // Persist a system message explaining why a close-card gate rejected a
  // malformed `<agenthub:close-card>` block. Best-effort: on DB failure we
  // still broadcast to live clients so the rejection is visible in the
  // running session, even if a reload wouldn't show it.
  function persistCloseCardGateSystemMessage(
    sessionId: string,
    content: string,
    meta: Record<string, unknown>,
  ): void {
    const msgId = uuidv4();
    const metadata = JSON.stringify(meta);
    try {
      stmts.addMessage.run(
        msgId,
        sessionId,
        'system',
        content,
        null,
        null,
        null,
        metadata,
        null,
        null,
        null,
      );
      stmts.touchSession.run(sessionId);
      const insertedMessage = (stmts.getMessageById.get(msgId) as MessageRow | undefined) ?? {
        id: msgId,
        session_id: sessionId,
        role: 'system' as const,
        content,
        engine: null,
        model: null,
        attachments: null,
        metadata,
        created_at: new Date().toISOString(),
      };
      broadcast({ type: 'message_added', sessionId, message: insertedMessage });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[close-card-gate] Failed to persist system message:', message);
      const fallback: MessageRow = {
        id: msgId,
        session_id: sessionId,
        role: 'system',
        content,
        engine: null,
        model: null,
        attachments: null,
        metadata,
        created_at: new Date().toISOString(),
      };
      broadcast({ type: 'message_added', sessionId, message: fallback });
    }
  }

  function createCursorChat(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
    const CURSOR_BIN = getCursorBin();
    return new Promise((resolve, reject) => {
      execFile(CURSOR_BIN, ['create-chat'], { cwd, env }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`cursor create-chat failed: ${stderr || err.message}`));
          return;
        }
        const id = (stdout || '').trim().split(/\s+/).pop();
        if (!id) {
          reject(new Error('cursor create-chat returned no id'));
          return;
        }
        resolve(id);
      });
    });
  }

  /**
   * Resolve the user id to attribute to a session created on the chat
   * spawn paths (orphan-session auto-create, etc.). The websocket
   * handshake stamps `_authUserId` on the ws object when JWT auth
   * succeeds. There is no org-owner fallback: an unauthenticated /
   * system caller resolves to `null`, and any per-account engine spawn
   * for a null owner hard-fails downstream (`assertEngineCredsOrThrow`).
   */
  function ownerUserIdForChatSpawn(ws: WebSocketLike | null): string | null {
    return getWsAuthUserId(ws as unknown as AuthStampedWs | null) ?? null;
  }

  async function handleChat(ws: WebSocketLike | null, msg: InternalChatMessage): Promise<void> {
    const persistHook = msg._onUserMessagePersisted;
    let persistReported = false;
    const reportUserMessagePersisted = (accepted: boolean) => {
      if (!persistHook || persistReported) return;
      persistReported = true;
      persistHook(accepted);
    };

    try {
      const { agentId, sessionId, content, images, hookSpecificOutput } = msg;
      const isAutoContinuation = msg._autoContinuation === true;
      const continuationDepth = msg._continuationDepth || 0;
      const attachments: string | null =
        images && images.length > 0 ? JSON.stringify(images) : null;

      const found = findAgent(agentId);
      if (!found) {
        if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown agent: ${agentId}` }));
        return;
      }
      const { project, agent } = found;
      // Reviewer agents are write-only from the system spawn path
      // (GitHub webhook → runReviewerDispatch). A client WS message
      // (ws !== null) targeting a reviewer agent means a user is
      // trying to chat with a reviewer — refuse. System spawns pass
      // ws === null and continue through.
      if (ws && agent.role === 'reviewer') {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId,
            error:
              'Reviewer agents only run from the GitHub PR webhook; chat sessions cannot be started manually.',
          }),
        );
        return;
      }
      const enrichedAgent = getEnrichedAgent(agentId);

      // ── Bug-report reroute guard ──────────────────────────────────
      // User-request bug reports (payloads starting with "## Bug Report")
      // must be owned by the project's intake agent — never a lead,
      // specialist, reviewer, or docs agent. If a bug-report payload is
      // addressed to anyone else, dispatch a fresh session for the intake
      // agent and notify the caller. See `server/bug-report-reroute.ts`.
      const intakeTarget = resolveBugReportReroute(project, agent, content, {
        fromQueue: msg._fromQueue,
        alreadyRerouted: msg._reroutedFromBugReport,
        fromBoardAssign: msg._fromBoardAssign,
      });
      if (intakeTarget) {
        const intakeSessionId = uuidv4();
        const intakeEngine = intakeTarget.engine || 'claude-code';
        const intakeOwnerUid = getSessionOwner(sessionId);
        const intakeModel = resolveEffectiveModel(config, intakeEngine, {
          agentModel: (intakeTarget as AgentWithModel).model,
          ownerUserId: intakeOwnerUid,
        });
        const title = extractBugReportTitle(content) || 'Bug Report';
        const sessionName = `[Bug] ${title.substring(0, 80)}`;

        try {
          const intakeWt = defaultSessionUseWorktreeFlag(project);
          stmts.createSession.run(
            intakeSessionId,
            intakeTarget.id,
            sessionName,
            intakeEngine,
            intakeModel,
            intakeWt,
            0,
            1,
          );
          // Bug-report reroute: rerouted intake session inherits ownership from
          // the user's original session so the bug-report transcript stays
          // attributable to the same user who filed it.
          inheritOwnerFromSession(intakeSessionId, sessionId);
          const taskId = uuidv4();
          stmts.insertBackgroundTask.run(taskId, intakeSessionId, intakeTarget.id, content);
        } catch (err) {
          console.error('[Bug Reroute] Failed to create intake session:', (err as Error).message);
          if (ws) {
            ws.send(
              JSON.stringify({
                type: 'error',
                sessionId,
                error: 'Failed to reroute bug report to intake agent.',
              }),
            );
          }
          return;
        }

        if (ws) {
          ws.send(
            JSON.stringify({
              type: 'bug_report_rerouted',
              originalAgentId: agentId,
              originalSessionId: sessionId,
              intakeAgentId: intakeTarget.id,
              intakeSessionId,
              message: `Bug reports are handled by ${intakeTarget.name || intakeTarget.id}. Dispatched a fresh session there.`,
            }),
          );
        }

        setImmediate(() => {
          try {
            const result = handleChat(null, {
              type: 'chat',
              agentId: intakeTarget.id,
              sessionId: intakeSessionId,
              content,
              _reroutedFromBugReport: true,
            } as InternalChatMessage);
            if (result && typeof (result as Promise<unknown>).catch === 'function') {
              (result as Promise<unknown>).catch((err: Error) => {
                console.error(
                  `[Bug Reroute] handleChat failed for intake session ${intakeSessionId}:`,
                  err.message,
                );
              });
            }
          } catch (err) {
            console.error(
              `[Bug Reroute] handleChat threw for intake session ${intakeSessionId}:`,
              (err as Error).message,
            );
          }
        });
        return;
      }

      const slashResult = resolveSlashSkill(agent, content, project);
      if (slashResult?.error) {
        if (ws) ws.send(JSON.stringify({ type: 'error', sessionId, error: slashResult.error }));
        return;
      }

      let cliContent: string = content;

      let session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) {
        const orphanWt = defaultSessionUseWorktreeFlag(project);
        const orphanOwner = ownerUserIdForChatSpawn(ws);
        const { engine: initialEngine, model: orphanModel } = resolveEffectiveEngineAndModel(
          config,
          {
            agentId,
            agentEngine: agent.engine || 'claude-code',
            agentModel: (agent as AgentWithModel).model ?? null,
            ownerUserId: orphanOwner,
          },
        );
        stmts.createSession.run(
          sessionId,
          agentId,
          `Session ${new Date().toLocaleString()}`,
          initialEngine,
          orphanModel,
          orphanWt,
          0,
          1,
        );
        // Orphan-session auto-create: the WebSocket handshake validated the
        // caller's identity; attribute the new row to that user (or fall back
        // to the org owner in the local-bypass / system-spawn path).
        setSessionOwner(sessionId, ownerUserIdForChatSpawn(ws));
        session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      }

      if (session) {
        persistLegacyWikiHybridGateIfNeeded(session, sessionId);
      }

      if (session && !msg._multiAgentInternal && sessionHasAdvisors(stmts!, sessionId)) {
        await handleMultiAgentChat(ws, msg);
        return;
      }

      const existingTask = stmts.getActiveTask.get(sessionId) as ActiveTaskRow | undefined;
      const sessionBusy =
        isSessionChatBusy(sessionId, activeProcesses, activeDelegationSessions, existingTask) ||
        activeMultiAgentRounds.has(sessionId);

      if (sessionBusy && !msg._fromQueue && !msg._multiAgentInternal) {
        if (isAutoContinuation) {
          const retries = msg._continuationRetry ?? 0;
          const plan = planAutoContinuationRetry({ retries });
          if (plan.action === 'retry') {
            console.warn(
              `[auto-continuation] session ${sessionId}: active task or delegation present; ` +
                `scheduling retry ${plan.nextRetry}/${AUTO_CONTINUATION_MAX_RETRIES}`,
            );
            setTimeout(() => {
              void handleChat(null, {
                ...msg,
                _continuationRetry: plan.nextRetry,
              } as InternalChatMessage);
            }, 500);
          } else {
            console.error(
              `[auto-continuation] session ${sessionId}: exhausted ${AUTO_CONTINUATION_MAX_RETRIES} retries; dropping continuation.`,
            );
          }
          return;
        }
        const isInterrupt = msg.interrupt === true;

        if (isInterrupt && msg._existingMsgId) {
          const existingId = msg._existingMsgId;
          stmts.dequeueMessage.run(existingId);
          broadcast({
            type: 'queue_updated',
            sessionId,
            queue: stmts.getQueuedMessages.all(sessionId),
          });

          const runExistingQueued = () => {
            void handleChat(null, {
              type: 'chat',
              agentId,
              sessionId,
              content,
              images: msg.images,
              _fromQueue: true,
              _existingMsgId: existingId,
            } as InternalChatMessage);
          };

          console.log(
            `[chat] Interrupt-now on queued message ${existingId} for session ${sessionId}`,
          );
          const proc = activeProcesses.get(sessionId);
          if (proc) {
            markSessionTermination(sessionId, 'chat_interrupt_queued');
            console.info(`[chat] chat_interrupt_queued: sending SIGTERM session=${sessionId}`);
            killProcessGroup(proc, 'SIGTERM');
          }
          if (activeDelegationSessions.has(sessionId)) {
            handleDelegationCancel(sessionId);
            setTimeout(runExistingQueued, 500);
          } else {
            setTimeout(runExistingQueued, 100);
          }
          broadcast({ type: 'interrupted', sessionId });
          return;
        }

        if (!isInterrupt) {
          const currentQueue = stmts.getQueuedMessages.all(sessionId) as MessageQueueRow[];
          if (currentQueue.length >= MAX_QUEUE_SIZE) {
            if (ws) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  sessionId,
                  error: `Queue is full (max ${MAX_QUEUE_SIZE} messages). Wait for current task to complete.`,
                }),
              );
            } else {
              console.error(
                `[chat] Queue full (${MAX_QUEUE_SIZE}); dropped non-interrupt inject for session ${sessionId}` +
                  ` (agent ${agentId}). Webhook / review feedback may need a free slot or manual nudge.`,
              );
            }
            return;
          }
        }

        const queueMsgId = uuidv4();

        let position: number;
        if (isInterrupt) {
          const minPos = stmts.getMinQueuePosition.get(sessionId) as
            | { min_pos: number | null }
            | undefined;
          position = (minPos?.min_pos ?? 0) - 1;
        } else {
          const maxPos = stmts.getMaxQueuePosition.get(sessionId) as
            | { max_pos: number | null }
            | undefined;
          position = (maxPos?.max_pos ?? -1) + 1;
        }

        stmts.addMessage.run(
          queueMsgId,
          sessionId,
          'user',
          content,
          null,
          null,
          attachments,
          null,
          null,
          null,
          null,
        );
        stmts.touchSession.run(sessionId);

        stmts.enqueueMessage.run(queueMsgId, sessionId, agentId, content, attachments, position);

        broadcast({
          type: 'message',
          message: {
            id: queueMsgId,
            session_id: sessionId,
            role: 'user',
            content,
            attachments,
            queued: !isInterrupt,
            interrupted: isInterrupt,
            created_at: new Date().toISOString(),
          },
        });

        broadcast({
          type: 'queue_updated',
          sessionId,
          queue: stmts.getQueuedMessages.all(sessionId),
        });

        reportUserMessagePersisted(true);

        if (isInterrupt) {
          console.log(`[chat] Interrupt received for session ${sessionId} — stopping current task`);
          const proc = activeProcesses.get(sessionId);
          if (proc) {
            markSessionTermination(sessionId, 'chat_interrupt');
            console.info(`[chat] chat_interrupt: sending SIGTERM session=${sessionId}`);
            killProcessGroup(proc, 'SIGTERM');
          }
          if (activeDelegationSessions.has(sessionId)) {
            handleDelegationCancel(sessionId);
            setTimeout(() => drainQueue(sessionId), 500);
          }
          broadcast({ type: 'interrupted', sessionId });
        }

        // Session may look busy only because of a stale `active_tasks` row; try
        // draining now and again when the in-flight turn completes.
        setImmediate(() => drainQueue(sessionId));

        return;
      }

      let userMsgId: string | null = null;
      if (msg._fromQueue) {
        userMsgId = msg._existingMsgId!;
        broadcast({ type: 'queue_item_processing', sessionId, messageId: userMsgId });
        reportUserMessagePersisted(true);
      } else if (!isAutoContinuation && !msg._skipUserMessagePersist) {
        userMsgId = uuidv4();
        stmts.addMessage.run(
          userMsgId,
          sessionId,
          'user',
          content,
          null,
          null,
          attachments,
          null,
          null,
          null,
          null,
        );
        stmts.touchSession.run(sessionId);

        broadcast({
          type: 'message',
          message: {
            id: userMsgId,
            session_id: sessionId,
            role: 'user',
            content,
            attachments,
            created_at: new Date().toISOString(),
          },
        });
        reportUserMessagePersisted(true);
      }

      const priorMessages = (stmts.getMessages.all(sessionId) as MessageRow[]).filter((m) =>
        userMsgId ? m.id !== userMsgId : true,
      );
      const isFirstMessage = priorMessages.length === 0;

      // Auto-rename on every user turn while the title is still owned by the
      // automatic title flow. Manual/card/hook titles are not clobbered.
      if (session) {
        let linkedCardTitle: string | null = null;
        try {
          const linkedCard = (stmts as Stmts).getKanbanCardBySession?.get(sessionId) as
            | KanbanCardRow
            | undefined;
          linkedCardTitle = linkedCard?.title ?? null;
        } catch {
          /* table missing — ignore */
        }

        const priorUserMessages = priorMessages
          .filter((m) => m.role === 'user')
          .map((m) => m.content);
        const pick = pickTurnSessionTitle({
          currentTitle: session.name,
          currentTitleSource: session.title_source ?? null,
          content,
          priorUserMessages,
          explicitTitle: hookSpecificOutput?.sessionTitle ?? null,
          linkedCardTitle,
        });

        if (shouldPersistTurnSessionTitlePick(pick, session.name, session.title_source ?? null)) {
          const titleSource = titleSourceForPick(pick.source);
          stmts.updateSessionNameWithTitleSource.run(pick.title, titleSource, sessionId);
          // Refresh the local row so downstream consumers see the new name.
          session = stmts.getSession.get(sessionId) as SessionRow | undefined;
          if (session) {
            broadcast({
              type: 'session-updated',
              session: enrichSessionForClient(session, stmts),
            });
          }

          if (pick.usedHeuristic) {
            const sessSnapshot = session;
            const heuristicTitle = pick.title;
            void scheduleTitleUpgrade({
              sessionId,
              heuristicTitle,
              content,
              config: {
                // No host Anthropic key — Claude auth is per-account. The
                // LLM title upgrade uses the host OpenAI key when configured.
                anthropicApiKey: null,
                openaiApiKey: config.openaiApiKey ?? null,
              },
              getSessionName: (id) =>
                (stmts.getSession.get(id) as SessionRow | undefined)?.name ?? null,
              getSessionTitleSource: (id) =>
                (stmts.getSession.get(id) as SessionRow | undefined)?.title_source ?? null,
              updateSessionName: (title, id, expectedCurrentTitle) => {
                const result = stmts.updateAutoSessionNameIfCurrent.run(
                  title,
                  id,
                  expectedCurrentTitle,
                ) as { changes?: number };
                return (result.changes ?? 0) > 0;
              },
              onUpgrade: (newTitle) => {
                if (!sessSnapshot) return;
                broadcast({
                  type: 'session-updated',
                  session: enrichSessionForClient(
                    {
                      ...sessSnapshot,
                      name: newTitle,
                      title_source: 'auto',
                    } as SessionRow,
                    stmts,
                  ),
                });
              },
            });
          }
        }
      }

      const engine: string = session!.engine || 'claude-code';
      const sessOwnerUid = getSessionOwner(sessionId);
      const model: string =
        session!.model?.trim() ||
        resolveEffectiveModel(config, engine, {
          agentModel: (agent as AgentWithModel).model,
          ownerUserId: sessOwnerUid,
        });
      const paths = resolveProjectPaths(project as Project, agent as Agent);
      const slashAug = augmentChatTurnForSlashSkill({
        slashResult,
        project: project as Project,
        agent: agent as Agent,
        sessionId,
        stmts: stmts as Stmts,
        broadcast,
        isAutoContinuation,
        content,
      });
      const slashSkillSuffix = slashAug.slashSkillSuffix;
      cliContent = slashAug.cliContent;

      let routedSkillSuffix = '';
      const loadedRoutedSkillIds = new Set<string>();
      if (!slashResult && !isAutoContinuation) {
        const availableSkills = listEnabledSkills(
          agent.id,
          paths.skillsDir,
          agent.allowedSkills ?? null,
        );
        // Seed the dedupe set from the pending-skill suffix so we don't
        // re-inject a skill the previous `<agenthub:skill>` block already
        // queued. The header format is `## Loaded Skill: <skill-id>` —
        // a best-effort extraction; missing match just means no dedupe.
        const pendingRaw = session!.pending_skill_context?.trim() || '';
        if (pendingRaw) {
          const m = pendingRaw.match(/^## Loaded Skill:\s*([\w.-]+)/m);
          if (m) loadedRoutedSkillIds.add(m[1]!);
        }
        const routedMatches = routeSkillsFromMessage({
          message: content,
          skills: availableSkills,
          agentId: agent.id,
          agentSystemPrompt: agent.systemPrompt || '',
          cwd: session!.worktree_path || project.cwd,
          projectSlug: project.id,
        });
        const injections: string[] = [];
        for (const routed of routedMatches) {
          if (loadedRoutedSkillIds.has(routed.skillId)) continue;
          const injection = loadSkillByName({
            name: routed.skillId,
            reason: `auto-route: ${routed.reason}`,
            paths: { skillsDir: paths.skillsDir },
            sessionId,
            stmts: stmts as Stmts,
            broadcast,
          });
          injections.push(injection);
          loadedRoutedSkillIds.add(routed.skillId);
        }
        if (injections.length > 0) {
          routedSkillSuffix = `\n\n${injections.join('\n\n')}`;
        }
      }

      // Look up the kanban card linked to this session so the prompt + spawn
      // env can surface any already-open PR for this branch (see
      // BuildEnrichedPromptOptions.branchPrUrl). `auto-git.ts` writes the PR
      // URL onto the card via `setCardPrUrl` when it opens a PR; a follow-up
      // session redispatched on the same card inherits that URL through this
      // lookup. Failure is non-fatal — we just skip the warning block.
      let linkedCardForPr: KanbanCardRow | null = null;
      try {
        linkedCardForPr =
          ((stmts as Stmts).getKanbanCardBySession?.get(sessionId) as KanbanCardRow | undefined) ??
          null;
      } catch {
        /* no-op — warning block simply omitted */
      }
      // Resolve the branch's open PR the same way the session header does:
      // linked card `pr_url`, else inferred from the session title (Resolve /
      // Review PR flows or a pasted PR URL). This keeps the "Active Pull
      // Request — commit & push to the existing branch" prompt guidance in
      // sync with the ship-gate, which now lets such sessions push directly.
      const resolvedBranchPrUrl = resolveSessionPrUrl({
        sessionName: session!.name,
        githubRepo: (project as ProjectWithCommands & { githubRepo?: string }).githubRepo ?? null,
        cardPrUrl: linkedCardForPr?.pr_url ?? null,
      });
      // Detect the repo's default branch (cached) so the Development
      // Lifecycle / Git Workflow guidance branches from / rebases onto the
      // real default (e.g. `master`) rather than a hardcoded `main`. The
      // worktree and the project checkout share the same remote default, so
      // either cwd resolves it; non-fatal — falls back to `main` in-builder.
      let resolvedDefaultBranch: string | null = null;
      try {
        resolvedDefaultBranch = await getCachedDefaultBranch(
          session!.worktree_path || (project as ProjectWithCommands).cwd,
        );
      } catch {
        /* leave null — builder falls back to `main` */
      }
      let enrichedPrompt = buildEnrichedPrompt(
        project as ProjectWithCommands,
        agent as AgentWithModel,
        {
          useWorktree: sessionUsesWorktree(session!),
          isFirstMessage,
          sessionId,
          orchestrationPhase: session!.orchestration_phase ?? null,
          orchestrationMetaJson: session!.orchestration_meta ?? null,
          branchPrUrl: resolvedBranchPrUrl,
          branchPrBase: linkedCardForPr?.pr_base_branch ?? null,
          defaultBranch: resolvedDefaultBranch,
          sessionHasLinkedCard: !!linkedCardForPr,
          finalizeConfigured: worktreeHasFinalizeCi(session!.worktree_path),
          sessionWorktreePath: session!.worktree_path ?? null,
          sessionWorktreeBranch: session!.worktree_branch ?? null,
          _getEnrichedAgent: getEnrichedAgent,
        },
      );
      const { suffix: pendingSkillSuffix, forceSystemPromptThisTurn } =
        consumePendingSkillInjection(session!.pending_skill_context, () =>
          stmts.updateSessionPendingSkillContext.run(null, sessionId),
        );
      if (pendingSkillSuffix) enrichedPrompt += pendingSkillSuffix;
      if (slashSkillSuffix) enrichedPrompt += slashSkillSuffix;
      if (routedSkillSuffix) enrichedPrompt += routedSkillSuffix;

      const projectId =
        (project as ProjectWithCommands & { id?: string }).id ||
        (enrichedAgent as EnrichedAgent | null | undefined)?.projectId ||
        '';

      let linkedEpicForBudgets: KanbanEpicRow | null = null;
      try {
        const cardRow = (stmts as Stmts).getKanbanCardBySession?.get(sessionId) as
          | KanbanCardRow
          | undefined;
        if (cardRow?.epic_id) {
          linkedEpicForBudgets =
            (stmts.getKanbanEpic.get(cardRow.epic_id) as KanbanEpicRow | undefined) ?? null;
        }
      } catch {
        linkedEpicForBudgets = null;
      }
      const orchestrationBudgets = resolveOrchestrationBudgets(
        project as Project,
        linkedEpicForBudgets,
      );
      const maxWikiSession = orchestrationBudgets.maxWikiRagCallsPerSession;

      if (projectId && !isAutoContinuation) {
        const wikiRag = await runWikiHybridRagForUserTurn(projectId, content, {
          wikiHybridRagUsedCount: effectiveWikiHybridRagUsedCount(
            session!.wiki_hybrid_rag_consumed,
            session!.wiki_hybrid_rag_budget_version,
            maxWikiSession,
          ),
          maxCallsPerSession: maxWikiSession,
          slashSkillActive: !!slashResult,
        });
        if (wikiRag.promptSuffix) {
          enrichedPrompt += wikiRag.promptSuffix;
        }
        if (wikiRag.logWarning) {
          console.warn(
            `[wiki-rag] retrieval failed for session ${sessionId}: ${wikiRag.logWarning}`,
          );
        }
        if (wikiRag.shouldIncrementWikiHybridRagUsage) {
          try {
            const next = nextWikiHybridRagRowAfterIncrement(
              session!.wiki_hybrid_rag_consumed,
              session!.wiki_hybrid_rag_budget_version,
              maxWikiSession,
            );
            stmts.updateSessionWikiHybridRagBudget.run(
              next.consumed,
              next.budgetVersion,
              sessionId,
            );
            session!.wiki_hybrid_rag_consumed = next.consumed;
            session!.wiki_hybrid_rag_budget_version = next.budgetVersion;
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.error(`[wiki-rag] failed to persist consumption flag: ${m}`);
          }
        }

        // Code-RAG: hybrid retrieval over the project's indexed source. No-ops
        // (no embedding call) unless the project has been indexed and budget
        // remains. Mirrors the wiki-RAG consumption accounting.
        const codeRag = await runCodeRagForUserTurn(projectId, content, {
          codeRagUsedCount: session!.code_rag_consumed ?? 0,
          maxCallsPerSession: MAX_CODE_RAG_CALLS_PER_SESSION,
          slashSkillActive: !!slashResult,
        });
        if (codeRag.promptSuffix) {
          enrichedPrompt += codeRag.promptSuffix;
        }
        if (codeRag.logWarning) {
          console.warn(
            `[code-rag] retrieval failed for session ${sessionId}: ${codeRag.logWarning}`,
          );
        }
        if (codeRag.shouldIncrementCodeRagUsage) {
          try {
            const nextCount = Math.min(
              (session!.code_rag_consumed ?? 0) + 1,
              MAX_CODE_RAG_CALLS_PER_SESSION,
            );
            stmts.updateSessionCodeRagConsumed.run(nextCount, sessionId);
            session!.code_rag_consumed = nextCount;
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.error(`[code-rag] failed to persist consumption counter: ${m}`);
          }
        }
      }
      const assistantMsgId = uuidv4();

      let engineSessionId: string | null = session!.engine_session_id || null;
      const isNewEngineSession = !engineSessionId;

      // Same cwd as the later `spawn` (worktree path when isolation is on) so
      // `cursor-agent create-chat` and `--resume` agree on repo root / `.cursor`.
      let sessionPrBase: string | null = null;
      try {
        const cardForWorktree = (stmts as Stmts).getKanbanCardBySession?.get(sessionId) as
          | KanbanCardRow
          | undefined;
        let epicForBase: KanbanEpicRow | undefined;
        if (cardForWorktree?.epic_id) {
          epicForBase = stmts.getKanbanEpic.get(cardForWorktree.epic_id) as
            | KanbanEpicRow
            | undefined;
        }
        const rawBase = effectivePrBaseBranch(cardForWorktree, epicForBase);
        sessionPrBase =
          typeof rawBase === 'string' && rawBase.trim() !== '' ? rawBase.trim() : null;
      } catch {
        sessionPrBase = null;
      }

      // Captured for the reuse-path drift case below — populated by the
      // `onBaseBranchAdvanced` callback when origin/<pr_base_branch> moved
      // since this session forked. We consume it after the worktree settles
      // so we can post a card comment + augment the system prompt in one
      // place, regardless of which engine eventually spawns.
      let baseBranchAdvanced: import('./worktree.js').BaseBranchAdvancedInfo | null = null;

      let effectiveCwd: string = project.cwd;
      const pinnedSpawnCwd =
        typeof msg._spawnCwd === 'string' && msg._spawnCwd.trim() !== ''
          ? msg._spawnCwd.trim()
          : null;
      if (pinnedSpawnCwd) {
        effectiveCwd = pinnedSpawnCwd;
      } else if (isPreviewSetupWizardSession(session!) && !sessionUsesWorktree(session!)) {
        // Legacy Preview setup wizard rows were read-only over project.cwd.
        // New rows are worktree-backed so they can be finalized like runner setup.
        effectiveCwd = project.cwd;
        msg._spawnCwd = project.cwd;
      } else if (
        sessionUsesWorktree(session!) &&
        getProjectMode(project as Project) !== 'workflow' &&
        (session!.worktree_path || isNewEngineSession)
      ) {
        const priorWorktree = session!.worktree_path;
        effectiveCwd = await ensureWorktree(
          session!,
          project.cwd,
          agentId,
          (project as ProjectWithCommands).commands?.install || null,
          sessionPrBase,
          (project as Project).repoUrl ?? null,
          project.id,
          (info) => {
            baseBranchAdvanced = info;
          },
          (project as Project).githubRepo ?? null,
          hostedBarePathForProject(project as Project),
        );
        session = stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (session) {
          persistLegacyWikiHybridGateIfNeeded(session, sessionId);
        }

        if (!isNewEngineSession && priorWorktree && priorWorktree !== effectiveCwd) {
          console.log(
            `[chat] Cross-worktree resume: session ${sessionId} moved from ${priorWorktree} → ${effectiveCwd}`,
          );
        }
      } else if (!isNewEngineSession && !sessionUsesWorktree(session!) && session!.worktree_path) {
        console.log(
          `[chat] Resuming session ${sessionId} in project cwd (worktree disabled, cross-worktree resume)`,
        );
      }

      // Surface base-branch drift (umbrella moved while this card was
      // iterating). We post a card comment for the human-visible audit
      // trail and append a one-shot suffix to `enrichedPrompt` so the
      // agent's next turn sees the "rebase first" notice. The detection
      // runs once per turn — if the drift persists across turns (dirty /
      // conflict cases), the callback fires again and the notice is
      // re-injected each time, which is the correct behavior.
      if (baseBranchAdvanced) {
        const drift: import('./worktree.js').BaseBranchAdvancedInfo = baseBranchAdvanced;
        const shortNew = drift.newTipSha.slice(0, 7);
        let promptNote: string;
        let commentBody: string;
        if (drift.rebased) {
          promptNote =
            `\n\n[base-branch advanced] Your worktree's base branch \`${drift.baseBranch}\` ` +
            `advanced by ${drift.commitsAdvanced} commit(s) (now at \`${shortNew}\`) since you ` +
            `forked. The working tree was clean, so Agent Hub auto-rebased you onto the new tip. ` +
            `Continue your work — no action required.`;
          commentBody =
            `Base branch \`${drift.baseBranch}\` advanced by ${drift.commitsAdvanced} ` +
            `commit(s) on origin (now at \`${shortNew}\`). Working tree was clean — ` +
            `auto-rebased onto the new tip.`;
        } else if (drift.conflict) {
          promptNote =
            `\n\n[base-branch advanced — REBASE FIRST] Your worktree's base branch ` +
            `\`${drift.baseBranch}\` advanced by ${drift.commitsAdvanced} commit(s) (now at ` +
            `\`${shortNew}\`) since you forked. Agent Hub attempted an auto-rebase but hit ` +
            `conflicts and aborted, restoring your prior tree. **Rebase manually before ` +
            `continuing or pushing** — \`git fetch origin && git rebase origin/${drift.baseBranch}\` ` +
            `and resolve conflicts. Otherwise your next push will be rejected.`;
          commentBody =
            `Base branch \`${drift.baseBranch}\` advanced by ${drift.commitsAdvanced} ` +
            `commit(s) on origin (now at \`${shortNew}\`). Auto-rebase attempted but hit ` +
            `conflicts; rebase aborted. Agent will be prompted to rebase manually.`;
        } else {
          // Dirty working tree — no rebase attempted.
          promptNote =
            `\n\n[base-branch advanced — REBASE FIRST] Your worktree's base branch ` +
            `\`${drift.baseBranch}\` advanced by ${drift.commitsAdvanced} commit(s) (now at ` +
            `\`${shortNew}\`) since you forked. Your working tree has uncommitted changes, ` +
            `so Agent Hub did not auto-rebase. **Commit or stash your changes, then run ` +
            `\`git fetch origin && git rebase origin/${drift.baseBranch}\` before continuing** — ` +
            `your next push will otherwise be rejected.`;
          commentBody =
            `Base branch \`${drift.baseBranch}\` advanced by ${drift.commitsAdvanced} ` +
            `commit(s) on origin (now at \`${shortNew}\`). Working tree was dirty — ` +
            `auto-rebase skipped. Agent will be prompted to commit/stash and rebase manually.`;
        }
        enrichedPrompt += promptNote;

        // Best-effort card comment + UI broadcast. Failure here must not
        // block the chat turn — the prompt note still gets through.
        try {
          const cardForComment = (stmts as Stmts).getKanbanCardBySession?.get(sessionId) as
            | KanbanCardRow
            | undefined;
          if (cardForComment) {
            const author = drift.rebased ? 'Agent Hub (auto-rebase)' : 'Agent Hub';
            stmts.createKanbanCardComment.run(uuidv4(), cardForComment.id, author, commentBody);
            try {
              broadcast({ type: 'kanban_update', projectId: project.id });
            } catch {
              /* broadcast failures are non-fatal */
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[chat] Failed to post base-branch-advanced comment for session ${sessionId}: ${message}`,
          );
        }
      }

      // Resolve session owner + billing creds owner before any CLI spawn
      // (cursor create-chat and the main agent child must share the same env).
      let ownerId: string | null = null;
      try {
        ownerId = getSessionOwner(sessionId);
      } catch (err) {
        const summary = (err as Error).message
          .replace(/[\r\n|]+/g, ' ')
          .trim()
          .slice(0, 200);
        const meta = JSON.stringify({
          v: 2,
          sev: 'soft',
          resolution: 'recovered',
          session: sessionId,
          tags: ['session-owner', 'spawn'],
        });
        console.error(
          `TOOL_ERROR | ${new Date().toISOString()} | session-owner | spawn lookup | error | ${summary} | ${meta}`,
        );
      }
      // No org-owner fallback: the session's own owner is the only identity
      // whose credentials may flow into the spawn.
      const credsOwnerId: string | null = ownerId;
      let sessionCliEnv: NodeJS.ProcessEnv;
      try {
        sessionCliEnv = resolveSessionCliSpawnEnv({
          cfg: config,
          ownerId,
          credsOwnerId,
          sessionId,
          engine,
        });
      } catch (err) {
        if (err instanceof EngineAuthRequiredError) {
          // Strictly account-based auth: refuse to spawn rather than borrow
          // another identity or run a CLI that would silently 401.
          saveErrorMessage(sessionId, assistantMsgId, engine, model, err.message);
          broadcast({
            type: 'error',
            messageId: assistantMsgId,
            sessionId,
            error: err.message,
          });
          return;
        }
        throw err;
      }

      if (engine === 'cursor-agent' && !engineSessionId) {
        try {
          engineSessionId = await createCursorChat(effectiveCwd, sessionCliEnv);
          stmts.updateSessionEngineSessionId.run(engineSessionId, sessionId);
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          console.error(errMessage);
          const errText = `Failed to create cursor chat: ${errMessage}`;
          saveErrorMessage(sessionId, assistantMsgId, engine, model, errText);
          broadcast({
            type: 'error',
            messageId: assistantMsgId,
            sessionId,
            error: errText,
          });
          return;
        }
      }

      try {
        stmts.insertActiveTask.run(
          sessionId,
          assistantMsgId,
          agentId,
          null,
          content,
          engine,
          model,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Failed to insert active_tasks row:', message);
      }
      // Turn-start signal boundary: the session is now `working`. Persist the
      // resolved state to the `sessions.state` cache and push a `session_state`
      // event so every sidebar (web + mobile) flips to the working glyph live.
      recomputeSessionState(stmts, sessionId, { agentId, broadcast });

      broadcast({
        type: 'thinking',
        messageId: assistantMsgId,
        sessionId,
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color ?? null,
        engine,
        model,
      });

      const needsHistoryBootstrap = isNewEngineSession && priorMessages.length > 0;
      const promptWithHistory: string = (() => {
        if (!needsHistoryBootstrap) return cliContent;
        let p = 'Previous conversation:\n';
        for (const m of priorMessages) {
          const prefix = m.role === 'user' ? 'Human' : 'Assistant';
          p += `${prefix}: ${m.content}\n\n`;
        }
        p += `Human: ${cliContent}`;
        if (Buffer.byteLength(p, 'utf8') > SAFE_ARG_STRLEN_BYTES) {
          console.warn(
            `[chat] session=${sessionId} history bootstrap ${Buffer.byteLength(p, 'utf8')}B ` +
              `exceeds argv cap ${SAFE_ARG_STRLEN_BYTES}B — using current turn only`,
          );
          return cliContent;
        }
        return p;
      })();

      let imagePromptSuffix = '';
      if (images && images.length > 0) {
        const imgCwd = session!.worktree_path || project.cwd;
        const imgDir = path.join(imgCwd, '.agent-hub-images');
        mkdirSync(imgDir, { recursive: true });
        const imgPaths: string[] = [];
        for (const img of images as unknown as ImageRef[]) {
          const srcPath = path.join(uploadsDir, img.filename);
          if (existsSync(srcPath)) {
            const destPath = path.join(imgDir, img.filename);
            writeFileSync(destPath, readFileSync(srcPath));
            imgPaths.push(destPath);
          }
        }
        if (imgPaths.length > 0) {
          const n = imgPaths.length;
          imagePromptSuffix =
            '\n\n[The user has attached ' +
            (n === 1 ? 'a file' : `${n} files`) +
            '. Open ' +
            (n === 1 ? 'it' : 'them') +
            ' with the Read tool at: ' +
            imgPaths.map((p) => `"${p}"`).join(', ') +
            ']';
        }
      }

      const finalPrompt = promptWithHistory + imagePromptSuffix;

      const CLAUDE_BIN = getClaudeBin();
      const CURSOR_BIN = getCursorBin();
      const GEMINI_BIN = getGeminiBin();
      const CODEX_BIN = getCodexBin();

      // `ownerId` / `credsOwnerId` / `sessionCliEnv` resolved above (before
      // cursor create-chat). Per-user MCP servers (claude-code only — cursor/gemini/codex have
      // their own MCP loading rules and don't take --mcp-config). Resolved
      // BEFORE the engine arg branch so the Claude branch can append
      // `--mcp-config` / `--strict-mcp-config` flags. The actual file write
      // happens just below this block once `effectiveCwd` semantics are in
      // play; the resolved map is also reused by the hooks-config branch.
      let mergedMcpServers: Record<string, import('./types.js').McpServerConfig> | undefined;
      let mcpConfigPath: string | null = null;
      if (engine === 'claude-code') {
        try {
          const userMcpRows = ownerId ? listEnabledMcpServersForUser(ownerId) : [];
          if (
            (agent.mcpServers && Object.keys(agent.mcpServers).length > 0) ||
            userMcpRows.length > 0
          ) {
            mergedMcpServers = buildMcpServersMap(userMcpRows, agent.mcpServers);
          }
        } catch (err) {
          // Best-effort; the spawn proceeds with agent.mcpServers only.
          const summary = (err as Error).message
            .replace(/[\r\n|]+/g, ' ')
            .trim()
            .slice(0, 200);
          const meta = JSON.stringify({
            v: 2,
            sev: 'soft',
            resolution: 'recovered',
            session: sessionId,
            tags: ['mcp-servers', 'spawn'],
          });
          console.error(
            `TOOL_ERROR | ${new Date().toISOString()} | mcp-servers | spawn lookup | error | ${summary} | ${meta}`,
          );
          mergedMcpServers = agent.mcpServers;
        }
        // Write `.claude/mcp-config.json`. Returns null when there are no
        // servers to emit; the Claude args branch checks the path before
        // appending the flag so an empty/missing file never gets passed
        // to `--mcp-config` (which would, paired with `--strict-mcp-config`,
        // unintentionally suppress whatever's at higher scopes).
        try {
          mcpConfigPath = writeMcpConfigFile(effectiveCwd, mergedMcpServers);
        } catch (err) {
          const summary = (err as Error).message
            .replace(/[\r\n|]+/g, ' ')
            .trim()
            .slice(0, 200);
          const meta = JSON.stringify({
            v: 2,
            sev: 'soft',
            resolution: 'recovered',
            session: sessionId,
            tags: ['mcp-servers', 'spawn-write'],
          });
          console.error(
            `TOOL_ERROR | ${new Date().toISOString()} | mcp-config-file | write | error | ${summary} | ${meta}`,
          );
          mcpConfigPath = null;
        }
      }

      const awsSsoEnabledForProject = projectHasAwsSsoProfiles(project);
      let projectAwsConfigPath: string | undefined;
      if (awsSsoEnabledForProject) {
        try {
          projectAwsConfigPath = writeProjectAwsConfigFile(
            project.id,
            getProjectAwsSsoProfiles(project),
          );
        } catch {
          /* mergeProjectAwsSpawnEnv logs when applying env */
        }
      }

      let args: string[];
      let bin: string;
      // Prompt content to write to the child's stdin after spawn. Used by
      // the codex-cli branch (which uses the `-` stdin sentinel) — null
      // for every other engine so the spawn site can switch stdio modes
      // without branching the handle logic.
      let stdinPrompt: string | null = null;
      // Temp-file cleanup thunk for the claude-code branch's
      // `--system-prompt-file <path>` payload. null when no temp file
      // was written. Invoked from the `proc.on('close')` handler so we
      // don't leak per-spawn tmp dirs.
      let systemPromptFileCleanup: (() => void) | null = null;
      if (engine === 'cursor-agent') {
        const rawPrompt =
          isNewEngineSession || forceSystemPromptThisTurn
            ? `${enrichedPrompt}\n\n${finalPrompt}`
            : cliContent + imagePromptSuffix;
        // cursor-agent has no documented stdin or --prompt-file flag, so
        // the entire prompt rides in a single `-p` argv element. Apply
        // the soft cap to avoid the kernel's 128 KiB MAX_ARG_STRLEN
        // cliff; emit TOOL_ERROR when we trim so growth shows up in
        // session health.
        const capped = applyArgvPromptCap(rawPrompt);
        if (capped.truncated) {
          logArgvCapTruncation('cursor-agent', sessionId, capped.originalBytes, rawPrompt.length);
        }
        const prompt = capped.prompt;
        args = [
          '-p',
          prompt,
          '--force',
          '--model',
          model,
          '--resume',
          engineSessionId!,
          '--output-format',
          'stream-json',
          '--stream-partial-output',
        ];
        bin = CURSOR_BIN;
      } else if (engine === 'gemini-cli') {
        // Gemini CLI flags per https://geminicli.com/docs/cli/cli-reference:
        //   -p / --prompt         prompt text (forces non-interactive mode)
        //   -m / --model          model selector (we pass through the session model)
        //   -o / --output-format  'stream-json' emits JSONL events we parse in
        //                         normalizeGemini (init / message / tool_use /
        //                         tool_result / result).
        //   --yolo                auto-approve tool calls — matches how we run
        //                         Claude Code with --permission-mode bypassPermissions.
        // Gemini does not (yet) expose a --resume flag for stateful sessions, so
        // we always inject the enriched prompt + full history on each turn. The
        // `needsHistoryBootstrap` branch earlier already concatenates prior
        // messages into `finalPrompt` when engineSessionId is null, which is
        // exactly the shape Gemini expects.
        const rawPrompt = `${enrichedPrompt}\n\n${finalPrompt}`;
        // Gemini CLI takes the prompt as a single `-p` argv string with
        // no documented stdin/file alternative. Same kernel cap applies
        // as cursor-agent — see spawn-prompt-payload.ts.
        const capped = applyArgvPromptCap(rawPrompt);
        if (capped.truncated) {
          logArgvCapTruncation('gemini-cli', sessionId, capped.originalBytes, rawPrompt.length);
        }
        const prompt = capped.prompt;
        args = ['-p', prompt, '--output-format', 'stream-json'];
        if (model && model !== 'auto') {
          args.push('--model', model);
        }
        const isAskMode = !!session!.ask_mode;
        if (!isAskMode) {
          args.push('--yolo');
        }
        bin = GEMINI_BIN;
      } else if (engine === 'codex-cli') {
        // Codex CLI flags per https://developers.openai.com/codex/noninteractive:
        //   codex exec --json "<prompt>"                  — new turn
        //   codex exec resume <session-id> --json "..."   — continue a session
        //   codex exec resume --last --json "..."         — continue the newest recorded session
        //   --sandbox read-only|workspace-write|danger-full-access
        //   --full-auto                                   — workspace-write convenience (still prompts for escalations)
        //   --dangerously-bypass-approvals-and-sandbox — full bypass (alias `--yolo`; default on via `codexDangerBypass` / env, opt out with false)
        //   -m / --model                                  — model selector
        //   -C / --cd <dir>                               — working root
        //   --skip-git-repo-check                         — allow non-git cwds (worktrees are fine)
        //   --ephemeral                                   — don't persist session rollout files
        //
        // Codex has its own on-disk session store; we key resumes off the
        // `thread_id` captured from the `thread.started` JSONL event (see
        // `engine_session_id` tracking in stream-parser.ts + chat event hook).
        // On the first turn we pass the enriched system prompt inline (Codex has
        // no `--system-prompt` flag) and rely on `--skip-git-repo-check` so
        // fresh project cwds without a `.git` dir don't fail.
        const isAskMode = !!session!.ask_mode;
        const prompt =
          isNewEngineSession || forceSystemPromptThisTurn
            ? `${enrichedPrompt}\n\n${finalPrompt}`
            : cliContent + imagePromptSuffix;
        args = ['exec'];
        if (!isNewEngineSession && engineSessionId) {
          args.push('resume', engineSessionId);
        }
        args.push('--json', '--skip-git-repo-check');
        appendCodexExecSandboxFlags(args, {
          askMode: isAskMode,
          dangerBypass: !!config.codexDangerBypass,
          awsSsoEnabled: awsSsoEnabledForProject,
        });
        if (awsSsoEnabledForProject && projectAwsConfigPath) {
          appendCodexAwsAccessDirs(args, {
            HOME: sessionCliEnv.HOME,
            AWS_CONFIG_FILE: projectAwsConfigPath,
          });
        }
        // Auth-mode-aware --model gating. Under ChatGPT OAuth the Codex backend
        // rejects most explicit `--model` IDs (HTTP 400 "not supported when
        // using Codex with a ChatGPT account"). shouldPassModelFlag() filters
        // the model against the ChatGPT allowlist; unsupported values get
        // dropped so Codex falls back to its built-in ChatGPT default rather
        // than 400ing the turn. API-key / unknown modes keep the prior
        // pass-through behavior.
        const codexAuth = detectCodexAuthMode();
        if (model && shouldPassModelFlag(codexAuth.mode, model)) {
          args.push('--model', model);
        } else if (model) {
          console.warn(
            `[chat] Dropping --model ${model} for codex-cli session ${sessionId}: ` +
              `auth_mode=${codexAuth.mode} does not accept it. Falling back to codex default.`,
          );
        }
        // Optional named profile from `~/.codex/config.toml` — when
        // operators configure `codexProfile` we forward it as `--profile <name>`
        // so Codex applies the profile's model/provider/sandbox overrides on
        // top of the flags we've already set. `config.ts` normalizes empty /
        // whitespace to null on load; the `?.trim()` guard here is belt-and-
        // braces in case a future `PATCH /api/config` path bypasses it (else
        // codex sees `--profile ""` and errors with a confusing CLI message).
        const codexProfileVal = config.codexProfile?.trim();
        if (codexProfileVal) {
          args.push('--profile', codexProfileVal);
        }
        // Pass the prompt via stdin using the documented `-` sentinel.
        // Per `codex exec` docs: "If you omit the prompt argument, Codex
        // reads the prompt from stdin. Use `codex exec -` when you want
        // to force that behavior explicitly." This sidesteps the kernel
        // MAX_ARG_STRLEN cap (128 KiB) — the previous shape of pushing
        // `${enrichedPrompt}\n\n${finalPrompt}` as a single argv element
        // would `spawn E2BIG` once the combined prompt cleared that
        // threshold (which is now routine for reviewer dispatches that
        // load the full `agent-hub` skill + references).
        args.push('-');
        stdinPrompt = prompt;
        bin = CODEX_BIN;
      } else {
        const isAskMode = !!session!.ask_mode;
        // Write the enriched system prompt to a temp file and pass it
        // via `--system-prompt-file` instead of `--system-prompt
        // <huge-string>`. The argv-string form trips the Linux kernel's
        // 128 KiB MAX_ARG_STRLEN cap once the enriched prompt
        // (identity + AGENTS.md + SOUL.md + MEMORY.md + skill bodies
        // including their references/*.md + wiki retrieval) gets large,
        // surfacing as `spawn E2BIG`. The file form has no such cap.
        // Cleanup is wired into the `proc.on('close')` handler below.
        const promptFile = writeSystemPromptFile(enrichedPrompt, sessionId);
        systemPromptFileCleanup = promptFile.cleanup;
        args = [
          '--print',
          '--permission-mode',
          claudePermissionModeForSpawn(isAskMode ? 'plan' : 'bypassPermissions'),
          '--model',
          model,
          '--system-prompt-file',
          promptFile.path,
          '--output-format',
          'stream-json',
          '--include-partial-messages',
          '--verbose',
          // Agent Hub provides skills via the `<agenthub:skill>` block protocol;
          // disable Claude Code's native `Skill` tool so agents don't fall back
          // to it for skills outside the bundled list (see claude-cli-args.ts).
          ...disableNativeSkillToolArgs(),
        ];
        // Wire per-session MCP config when we wrote one above. `--mcp-config`
        // is the only documented Claude Code MCP source that fits Agent
        // Hub's per-session lifecycle; `.claude/settings.json::mcpServers`
        // is silently ignored by the loader (verified via `claude mcp list`).
        // `--strict-mcp-config` ensures the agent only sees servers Agent
        // Hub controls — no surprises from hand-edited `~/.claude.json` or
        // `.mcp.json` files in the worktree.
        if (mcpConfigPath) {
          args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
        }
        if (isNewEngineSession) {
          args.push('--session-id', sessionId);
        } else {
          args.push('--resume', engineSessionId!);
        }
        let userPrompt = finalPrompt;
        const userPromptBytes = Buffer.byteLength(userPrompt, 'utf8');
        if (userPromptBytes > SAFE_ARG_STRLEN_BYTES) {
          const capped = applyArgvPromptCap(userPrompt);
          logArgvCapTruncation(
            'claude-code-user',
            sessionId,
            capped.originalBytes,
            userPromptBytes,
          );
          userPrompt = capped.prompt;
        }
        // `--` terminates option parsing so `--disallowed-tools` (variadic) and
        // trailing flags cannot swallow the positional prompt (Claude CLI 2.x).
        args.push('--', userPrompt);
        bin = CLAUDE_BIN;
      }

      const parser = createStreamParser(engine);
      let finalText = '';
      let partialFallback = '';
      let seq = 0;
      let errorOutput = '';
      // Accumulates error payloads that arrive on *stdout* (as JSONL for Codex /
      // Gemini) so the close handler can surface a meaningful message even when
      // stderr is empty or only contains informational noise (see
      // CODEX_STDERR_NOISE below). Examples:
      //   codex → turn.failed.error.message (HTTP 400 model-not-supported)
      //   codex → unknown `codex error: ...`
      let streamErrorMessage = '';

      /** Set once we have a complete `<delegate>...</delegate>` block in the stream — workers may start before the lead CLI exits. Synthesis still runs after close (see `synthesizeResults`). */
      let delegationWorkPromise: Promise<DelegationResult[]> | null = null;
      let delegationSafetyTimer: ReturnType<typeof setTimeout> | null = null;

      function clearDelegationSafetyTimer(): void {
        if (delegationSafetyTimer != null) {
          clearTimeout(delegationSafetyTimer);
          delegationSafetyTimer = null;
        }
      }

      function startDelegationOnce(tasks: DelegateTask[]): void {
        if (delegationWorkPromise !== null) return;
        activeDelegationSessions.add(sessionId);
        delegationSafetyTimer = setTimeout(
          () => {
            if (activeDelegationSessions.has(sessionId)) {
              console.error(
                `[Delegation] Safety timeout reached for session ${sessionId} — force-unlocking`,
              );
              handleDelegationCancel(sessionId);
              broadcast({
                type: 'delegation_error',
                sessionId,
                parentMessageId: assistantMsgId,
                error: 'Delegation timed out (safety limit reached)',
              });
              drainQueue(sessionId);
            }
          },
          (config as AppConfig & { delegationSafetyTimeoutMs?: number })
            .delegationSafetyTimeoutMs || 900000,
        );

        delegationWorkPromise = handleDelegation(
          sessionId,
          assistantMsgId,
          tasks,
          enrichedAgent!,
          project,
          effectiveCwd,
        );
        void delegationWorkPromise.finally(() => {
          clearDelegationSafetyTimer();
        });
      }

      function tryKickoffDelegationFromStream(assistantAccumulated: string): void {
        // Sub-agent delegation has been removed. This function is retained as a
        // no-op so existing call sites continue to compile while the surrounding
        // infrastructure is progressively deleted.
        void assistantAccumulated;
        return;
      }

      if (engine === 'claude-code') {
        const isWorktree = effectiveCwd !== project.cwd;
        const hasAgentHooks = agent.hooks && Object.keys(agent.hooks).length > 0;
        // MCP server emission moved up: see the `mergedMcpServers` /
        // `mcpConfigPath` block before the args branch. The hooks-config
        // file is now strictly about hooks (Stop, format guard, agent
        // hooks); MCP lives in `.claude/mcp-config.json` paired with the
        // Claude CLI's `--mcp-config` flag.
        if (isWorktree || hasAgentHooks) {
          try {
            writeHooksConfig(effectiveCwd, sessionId, {
              agentHooks: agent.hooks,
              includeSystemHooks: isWorktree,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[chat] Failed to write hooks config: ${message}`);
          }
        }
      }

      const spawnEnv: NodeJS.ProcessEnv = await (async () => {
        // ownerId resolved above. The lookup is reused here for per-user
        // Claude auth (below) and per-user GitHub auth (further down).
        // `credsOwnerId` is exactly `ownerId` — there is no org-owner
        // fallback; per-account engine spawns without an owner already
        // hard-failed above.

        const base = sessionCliEnv;
        // Resolve the session owner's per-user GitHub OAuth/PAT (if any).
        // We always perform the lookup so non-reviewer spawns get the
        // human-identity path; the reviewer policy in
        // `resolveGithubSpawnToken` (github-spawn-token-resolver.ts)
        // deliberately ignores this value to prevent identity leaks.
        // Best-effort: failures are observable via TOOL_ERROR but never
        // block the spawn.
        let userGhToken: string | null = null;
        try {
          if (ownerId) {
            const oauthCreds = resolveOAuthAppCredentials(config);
            userGhToken = await getActiveAccessToken(ownerId, oauthCreds);
          }
        } catch (err) {
          const summary = (err as Error).message
            .replace(/[\r\n|]+/g, ' ')
            .trim()
            .slice(0, 200);
          const meta = JSON.stringify({
            v: 2,
            sev: 'soft',
            resolution: 'recovered',
            session: sessionId,
            tags: ['per-user-github-auth', 'spawn'],
          });
          console.error(
            `TOOL_ERROR | ${new Date().toISOString()} | per-user-github-auth | spawn lookup | error | ${summary} | ${meta}`,
          );
        }
        // Pick the credential to inject. The policy lives in
        // `resolveGithubSpawnToken` (org-aware chain) so the reviewer /
        // non-reviewer / autonomous-dispatch behaviour stays testable in
        // isolation and chat.ts can't drift from it:
        //   - **App installation token for the repo's org (preferred)** —
        //     `ghs_…` minted via the GitHub App's private key. Bound to
        //     the org, not a human, so it does not re-introduce the
        //     autonomous-dispatch identity leak. Pre-validated against
        //     the repo with `GET /repos/:owner/:repo` so a stale
        //     installation falls through instead of poisoning the spawn.
        //     Closes the recurring "Write access to repository not
        //     granted" failures where the org owner's per-user OAuth
        //     had lost mcsteen/<repo> access.
        //   - reviewer role → bot installation token only when the App
        //     path didn't produce one. No per-user fallback (which
        //     historically mis-attributed reviews to the org owner's
        //     human GitHub account).
        //   - non-reviewer, interactive → per-user OAuth token so
        //     `gh`/`git push` authenticate as the human at the keyboard
        //     when no App is installed for the repo.
        //   - non-reviewer, autonomous-dispatch origin → no per-user
        //     fallback. Autonomous sessions are system-spawned and
        //     attributed to the org owner; if we injected the owner's
        //     OAuth the agent could call `gh api
        //     repos/.../reviews -X POST` directly and post formal PR
        //     reviews under the human's identity, bypassing the
        //     `gh-pr.sh` wrapper guard (`AGENT_HUB_REVIEWER_LOCK`). The
        //     server-side auto-PR push (`auto-git.ts`) runs
        //     out-of-process so PR creation is unaffected. See card
        //     395e044c-… for the wrapper-bypass rationale.
        // Resolve the repo's `{owner, repo}` from the project's git
        // `origin` remote. When available, this lets the credential
        // resolver below prefer a GitHub-App installation token bound
        // to the repo's org over the session owner's personal OAuth
        // token — which is the structural fix for the recurring
        // "Write access to repository not granted" failures on
        // webhook-triggered clones of org-owned repos. A missing or
        // non-GitHub remote silently falls back to the historical
        // per-user OAuth path.
        let repoOwner: string | null = null;
        let repoName: string | null = null;
        try {
          const owner = await getRepoOwnerForCwd(project.cwd);
          if (owner) {
            repoOwner = owner.owner;
            repoName = owner.repo;
          }
        } catch {
          /* best-effort — resolver falls back to user OAuth */
        }
        const tokenToInject = await resolveGithubSpawnToken({
          role: agent.role,
          config,
          userGhToken,
          repoOwner,
          repoName,
          autonomousOrigin: msg._fromAutonomousDispatch === true,
        });
        // Universal reviewer-spawn isolation (option A in card
        // 1f9c8215-…). `applyReviewerSpawnIsolation` runs on every spawn
        // regardless of role so:
        //   1. AGENT_HUB_REVIEWER_LOCK=1 is set everywhere. The github
        //      skill's `gh-pr.sh review` subcommand is disabled outright:
        //      the reviewer is an in-session advisor that emits its verdict
        //      in session output, so Agent Hub never posts a formal review
        //      to GitHub. Without this isolation, dev/author/lead spawns
        //      were able to post formal PR reviews under the session-owner's
        //      OAuth token, mis-attributing automated reviews to the
        //      human (see surveytracker PR #604 evidence).
        //   2. Inherited GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN /
        //      GITHUB_ENTERPRISE_TOKEN vars are scrubbed from the cloned
        //      process.env. `applyGithubSpawnCredentials` below then
        //      re-installs the per-user OAuth/PAT (non-reviewer roles)
        //      or bot installation token (reviewer role) via env vars
        //      plus a process-scoped git credential helper, so
        //      `git push` / `gh pr create` continue to attribute commits
        //      to the human (intentional — only formal PR reviews are
        //      gated).
        //   3. GH_CONFIG_DIR is rerouted to an empty Hub-managed
        //      directory so `gh` cannot fall back to the host operator's
        //      `gh auth login` identity.
        applyReviewerSpawnIsolation(base, config);
        // Reviewer-role-only structural lock (card 1cb9b461-…). Stacks
        // on top of the universal AGENT_HUB_REVIEWER_LOCK to block a
        // broader write surface (`gh pr create/merge/close/ready` and
        // `gh api` writes outside the formal-review allowlist) when the
        // agent role is `reviewer`. Defense-in-depth: even if a future
        // change accidentally leaks a token into the reviewer spawn env,
        // the credential cannot be used to forge commits or open PRs.
        applyReviewerRoleLock(base, agent.role);
        applyGithubSpawnCredentials(base, tokenToInject);
        // Hub-hosted git remotes (gitHost: 'agenthub'): register a git
        // credential helper for the Hub's own /git/<id>.git origins that
        // derefs AGENT_HUB_API_KEY (injected by buildSpawnEnv). Harmless
        // for GitHub-hosted projects — the helper only matches Hub origins.
        applyAgentHubGitSpawnCredentials(base, config);
        // AGENT_HUB_API_KEY + AGENT_HUB_DATA_DIR are now injected by
        // `buildSpawnEnv` (server/config.ts) so every spawn site —
        // heartbeat, cron, delegation, room-chat, etc. — picks them up
        // uniformly. Only AGENT_HUB_SESSION_ID is per-session and stays
        // here.
        base.AGENT_HUB_SESSION_ID = sessionId;
        // Inject the Hub API base and project ID so spawned CLIs reach `/api`.
        // Defaults to loopback with the bound port (`getActualPort` inside the
        // resolver); deployments with remote tool hosts set AGENT_HUB_AGENT_URL /
        // AGENT_HUB_PUBLIC_URL (config `publicUrl`). See resolveAgentHubApiBaseForSpawn.
        base.AGENT_HUB_URL = resolveAgentHubApiBaseForSpawn(config);
        base.PROJECT_ID = project.id;
        // Active-PR awareness for the spawned process — companion to the
        // `## Active Pull Request` system-prompt block (see buildEnrichedPrompt).
        // Scripts and skills that key off env vars (e.g. a future "before you
        // run `gh pr create`" guard) can read these without re-querying the
        // kanban API. We re-look up `linkedCardForPr` here because spawn-env
        // assembly happens in its own closure further down the function and
        // doesn't see the prompt-builder closure's locals.
        try {
          const cardForEnv = (stmts as Stmts).getKanbanCardBySession?.get(sessionId) as
            | KanbanCardRow
            | undefined;
          if (cardForEnv?.pr_url) {
            base.AGENT_HUB_BRANCH_PR_URL = cardForEnv.pr_url;
            if (cardForEnv.pr_base_branch) {
              base.AGENT_HUB_BRANCH_PR_BASE = cardForEnv.pr_base_branch;
            }
          }
        } catch {
          /* non-fatal — env var simply omitted, prompt block already covers the agent */
        }
        mergeSkillCredentialSpawnEnv(base, { ownerId, agentId: agent.id, project });
        mergeProjectSecretsSpawnEnv(base, { projectId: project.id, sessionId });
        mergeProjectAwsSpawnEnv(base, project, { configPath: projectAwsConfigPath });
        applySessionGitGuards(base, session!.worktree_path);
        return base;
      })();

      if (engine === 'codex-cli' && spawnEnv.AGENT_HUB_AWS_PROFILE_NAMES) {
        linkAwsSsoHostCacheIntoSpawnHome(spawnEnv);
      }

      // Merge allowlisted caller-supplied env vars (e.g. DEV_HUB_API_KEY from
      // autonomous-dispatch for cross-hub cards). See `mergeAllowlistedExtraEnv`.
      mergeAllowlistedExtraEnv(spawnEnv, msg.extraEnv);

      if (process.env.AGENT_HUB_DEBUG_CLAUDE_AUTH === '1' && engine === 'claude-code') {
        console.log('[chat] claude-code spawn auth:', {
          sessionId,
          hasAnthropicApiKey: Boolean(spawnEnv.ANTHROPIC_API_KEY),
          hasClaudeOAuthToken: Boolean(spawnEnv.CLAUDE_CODE_OAUTH_TOKEN),
          cwd: effectiveCwd,
        });
      }

      const chainStartedAtMs = msg._chainStartedAtMs ?? Date.now();

      // Pre-spawn cwd guard. Node's child_process.spawn reports ENOENT against
      // the *command* when the cwd doesn't exist, which historically surfaced
      // as the misleading "binary not found at <bin>" error even though the bin
      // itself was fine. Catch this case up front: auto-create the directory
      // when possible (recoverable) or fail with a precise, actionable message.
      const ensureCwd = ensureSpawnCwd(effectiveCwd);
      if (ensureCwd.status === 'auto-created') {
        console.warn(`[chat] auto-created missing cwd for session ${sessionId}: ${effectiveCwd}`);
      } else if (ensureCwd.status === 'failed') {
        const errText =
          `Working directory does not exist and could not be created: ${effectiveCwd}. ` +
          `Update the project's "cwd" in Settings or create the directory. ` +
          `(${ensureCwd.reason})`;
        console.error(`[chat] ${errText}`);
        saveErrorMessage(sessionId, assistantMsgId, engine, model, errText);
        broadcast({
          type: 'error',
          messageId: assistantMsgId,
          sessionId,
          error: errText,
        });
        try {
          stmts.deleteActiveTask.run(sessionId);
        } catch {}
        // The turn never spawned (bad cwd) — leave the cache out of `working`.
        recomputeSessionState(stmts, sessionId, { agentId, broadcast });
        drainQueue(sessionId);
        return;
      }

      const cliTurnStartMs = Date.now();
      // Open stdin as a pipe only when the engine branch staged a
      // `stdinPrompt` (currently codex-cli using the `-` sentinel).
      // Every other engine leaves stdin closed so an over-eager CLI
      // never blocks on a read that will never come.
      const childStdin: 'ignore' | 'pipe' = stdinPrompt !== null ? 'pipe' : 'ignore';
      const proc = spawn(bin, args, {
        cwd: effectiveCwd,
        env: spawnEnv,
        stdio: [childStdin, 'pipe', 'pipe'],
        // Run as its own process-group leader so killProcessGroup(proc) reaches
        // grandchildren (bash → npm → vitest workers) on cancel/shutdown.
        detached: true,
      });
      // Feed the prompt to the child once the pipe is open. We
      // explicitly call `.end()` so the child sees EOF and codex's
      // `exec -` finalizes the prompt buffer. If the write fails (e.g.
      // the child died between spawn and write) we swallow the error
      // — the close handler picks up the exit code and surfaces a
      // sane message.
      if (stdinPrompt !== null && proc.stdin) {
        try {
          proc.stdin.end(stdinPrompt, 'utf8');
        } catch (err) {
          console.error(
            `[chat] failed to write stdin prompt for ${engine} (${sessionId}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const S = stmts;

      /** Persist + fan-out host `<agenthub:react>` browser step telemetry like stream-json events. */
      const emitBrowserActivityEvent = (evt: BrowserToolActivityEvent): void => {
        const nextSeq = ++seq;
        try {
          S.addSessionEvent.run(
            'message',
            assistantMsgId,
            nextSeq,
            evt.type,
            clampPayload(JSON.stringify(evt)),
          );
        } catch (err: unknown) {
          console.error(
            `[chat] failed to persist browser_tool_activity (${evt.actionId}):`,
            err instanceof Error ? err.message : err,
          );
        }
        broadcast({
          type: 'session-event',
          sessionId,
          messageId: assistantMsgId,
          seq: nextSeq,
          event: evt,
        });
      };

      activeProcesses.set(sessionId, proc);
      trackChild(proc);
      // NOTE: `sessions.last_turn_error` is intentionally NOT cleared here.
      // Clearing at spawn would reopen the Finalize automation gate while a
      // recovery turn is still in flight (a parked ready_to_push run could
      // auto-push mid-recovery). The flag clears only in the close handler,
      // after this turn has verifiably ended cleanly. See server/turn-error.ts.
      if (proc.pid) {
        try {
          S.updateActiveTaskPid.run(proc.pid, sessionId);
        } catch {}
      }

      const handleEvent = (event: StreamEvent): void => {
        if (!shouldPersistStreamEvent(event)) {
          return;
        }
        try {
          // Clamp the serialized payload to MAX_PAYLOAD_BYTES so a single
          // huge tool_result / tool_use cannot blow up the table. See
          // session-events-store.ts for the truncation envelope shape.
          S.addSessionEvent.run(
            'message',
            assistantMsgId,
            ++seq,
            event.type,
            clampPayload(JSON.stringify(event)),
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('Failed to persist session_event:', message);
        }

        if (event.type === 'assistant_text') {
          const text =
            typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
          const { next, accumulatedForKickoff } = applyAssistantTextChunkForDelegationKickoff(
            { finalText, partialFallback },
            text,
            event.partial,
            event.replacesAssistantBuffer ? { replace: true } : undefined,
          );
          finalText = next.finalText;
          partialFallback = next.partialFallback;
          try {
            S.appendActiveTaskOutput.run(finalText || partialFallback, sessionId);
          } catch {}
          tryKickoffDelegationFromStream(accumulatedForKickoff);
        }

        if (event.type === 'system' && event.gitWorktree != null) {
          try {
            S.updateSessionGitWorktreeDetected.run(event.gitWorktree ? 1 : 0, sessionId);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[chat] Failed to persist git_worktree_detected:', message);
          }
          broadcast({
            type: 'session-worktree-detected',
            sessionId,
            gitWorktree: event.gitWorktree,
          });
        }

        // Codex emits the engine-side session id inside the first `thread.started`
        // event (normalized to a `system` event by normalizeCodex). Persist it on
        // the first appearance so subsequent turns can `codex exec resume <id>`.
        if (
          engine === 'codex-cli' &&
          event.type === 'system' &&
          event.sessionId &&
          !engineSessionId
        ) {
          engineSessionId = event.sessionId;
          try {
            S.updateSessionEngineSessionId.run(event.sessionId, sessionId);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[chat] Failed to persist codex engine_session_id:', message);
          }
        }

        // Claude Code emits a `system` (subtype=init) event the moment it has
        // booted and created its on-disk JSONL. Persist `engine_session_id`
        // immediately so subsequent turns use `--resume` instead of `--session-id`.
        // Without this, if the spawn dies before any `assistant_text` arrives
        // (cancel, network blip, upstream API error), the JSONL exists on disk
        // but our DB still has `engine_session_id = NULL`. The next turn would
        // re-spawn with `--session-id <same X>` and the CLI would reject it
        // with "Session ID X is already in use." See claude-session-id-conflict.ts.
        if (
          engine === 'claude-code' &&
          event.type === 'system' &&
          event.sessionId &&
          !engineSessionId
        ) {
          engineSessionId = event.sessionId;
          try {
            S.updateSessionEngineSessionId.run(event.sessionId, sessionId);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[chat] Failed to persist claude engine_session_id:', message);
          }
        }

        if (event.type === 'checkpoint' && event.uuid) {
          S.addCheckpoint.run(sessionId, assistantMsgId, event.uuid, event.turnIndex, null);
          broadcast({
            type: 'checkpoint',
            sessionId,
            uuid: event.uuid,
            turnIndex: event.turnIndex,
            messageId: assistantMsgId,
          });
        }

        // Capture upstream engine errors that arrive on stdout so the close
        // handler can surface them. For Codex the stream-parser turns a
        // `turn.failed` JSONL event into `{type:'result', isError:true, text}`
        // and an `error` event into `{type:'unknown', text:"codex error: ..."}`.
        // Without this, the close handler only sees stderr — which for Codex
        // is usually just the "Reading additional input from stdin..." notice.
        if (event.type === 'result' && event.isError && event.text) {
          if (!streamErrorMessage) streamErrorMessage = event.text;
        }
        if (
          event.type === 'unknown' &&
          typeof event.text === 'string' &&
          (event.text.startsWith('codex error:') || event.text.startsWith('codex item error:'))
        ) {
          if (!streamErrorMessage) streamErrorMessage = event.text;
        }

        // Progress-panel persistence: mirror progress_step events into the
        // session_progress table so reopening the session rehydrates the
        // ProgressPanel. Also broadcast a typed `session-progress` WS message
        // so the client can update without having to parse the raw session
        // event stream. Best-effort — failures don't block the chat turn.
        if (event.type === 'progress_step') {
          try {
            if (event.status === 'started') {
              S.addSessionProgress.run(
                sessionId,
                assistantMsgId,
                event.step,
                'started',
                event.startedAt,
                null,
              );
            } else {
              // `completed` / `failed` — close the most recent open row for
              // (session_id, step). If no matching row exists (e.g. agent
              // skipped the `started` marker), insert a one-shot row so the
              // panel still shows the outcome.
              const finishedAt = event.finishedAt ?? event.startedAt;
              const info = S.completeSessionProgress.run(
                event.status,
                finishedAt,
                sessionId,
                event.step,
              );
              if ((info as { changes?: number }).changes === 0) {
                S.addSessionProgress.run(
                  sessionId,
                  assistantMsgId,
                  event.step,
                  event.status,
                  event.startedAt,
                  finishedAt,
                );
              }
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[chat] Failed to persist session_progress:', message);
          }
          broadcast({
            type: 'session-progress',
            sessionId,
            messageId: assistantMsgId,
            step: event.step,
            status: event.status,
            startedAt: event.startedAt,
            finishedAt: event.finishedAt ?? null,
          });
        }

        if (event.type === 'tool_use' && typeof event.tool === 'string') {
          const toolInput = (event.input as Record<string, unknown>) || {};
          handleMutatingToolUseForCodeChange(sessionId, event.tool, toolInput, {
            stmts: S,
            broadcast,
            project,
            worktreePath: effectiveCwd,
            getPreviewComposeRuntime,
            getPreviewRuntime,
          });
        }

        broadcast({
          type: 'session-event',
          messageId: assistantMsgId,
          sessionId,
          seq,
          event,
        });

        if (event.type === 'assistant_text') {
          const chunkText =
            typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
          broadcast({
            type: 'stream',
            messageId: assistantMsgId,
            sessionId,
            agentId: agent.id,
            agentName: agent.name,
            agentColor: agent.color ?? null,
            chunk: chunkText,
            content: finalText || partialFallback,
            engine,
            model,
          });
        }
      };

      // Tracks whether proc.on('error') fired before 'close'. When spawn fails
      // (e.g. ENOENT because the configured bin path doesn't exist), Node emits
      // 'error' first with a useful message, then 'close' with code=-2 (-errno
      // for ENOENT). Without this flag the close handler overwrites the useful
      // "Failed to spawn codex: spawn /usr/local/bin/codex ENOENT" error with
      // the cryptic "codex-cli exited with code -2".
      let spawnErrored = false;
      const codexFileChangeToolUseIds = new Set<string>();

      function handleParsedEvents(events: StreamEvent[]): void {
        const enriched =
          engine === 'codex-cli'
            ? enrichCodexFileChangeDiffs(events, effectiveCwd, {
                fileChangeToolUseIds: codexFileChangeToolUseIds,
              })
            : events;
        for (const event of enriched) handleEvent(event);
      }

      proc.stdout!.on('data', (chunk: Buffer) => {
        handleParsedEvents(parser.feed(chunk));
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });

      proc.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
        activeProcesses.delete(sessionId);
        // Best-effort cleanup of the per-spawn system-prompt temp file
        // (claude-code only — see writeSystemPromptFile in
        // spawn-prompt-payload.ts). Failures are swallowed inside
        // cleanup(); we null the ref so a long-lived closure (e.g.
        // delegationWorkPromise) can't accidentally re-trigger.
        if (systemPromptFileCleanup) {
          systemPromptFileCleanup();
          systemPromptFileCleanup = null;
        }
        try {
          S.deleteActiveTask.run(sessionId);
        } catch {}

        // If spawn already failed with ENOENT/EACCES/etc, the 'error' listener
        // has already saved a clearer message. Bail out before we clobber it.
        if (spawnErrored) {
          // A spawn failure is an errored turn: keep the Finalize automation
          // gate closed (fail-closed) until some later turn closes cleanly.
          try {
            S.updateSessionLastTurnError.run(`${engine} failed to spawn`, sessionId);
          } catch {}
          emitReactLoopStep(broadcast, {
            sessionId,
            messageId: assistantMsgId,
            stepId: `${assistantMsgId}:cli`,
            phase: 'cli_turn',
            tool: engine,
            exitCode: -1,
            durationMs: Date.now() - cliTurnStartMs,
            continuationDepth,
            chainElapsedMs: Date.now() - chainStartedAtMs,
            detail: 'spawn_errored',
          });
          try {
            notifyFinalizeSessionSpawnFailed(sessionId);
          } catch (err) {
            console.warn(
              `[chat] finalize spawn-failed notify threw for ${sessionId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          if (delegationWorkPromise) {
            handleDelegationCancel(sessionId);
            delegationWorkPromise = null;
          }
          drainQueue(sessionId);
          return;
        }

        const cliDurationMs = Date.now() - cliTurnStartMs;
        emitReactLoopStep(broadcast, {
          sessionId,
          messageId: assistantMsgId,
          stepId: `${assistantMsgId}:cli`,
          phase: 'cli_turn',
          tool: engine,
          exitCode: code === null ? -1 : code,
          durationMs: cliDurationMs,
          continuationDepth,
          chainElapsedMs: Date.now() - chainStartedAtMs,
          detail: isAutoContinuation ? 'auto_continuation' : 'user_turn',
        });

        handleParsedEvents(parser.flush());

        const assembled = (finalText || partialFallback).trim();

        const termination = resolveChatTerminationOnClose(sessionId, code, signal);
        if (termination) {
          console.info(
            formatChatExitLog({
              engine,
              sessionId,
              code,
              signal,
              reason: termination.reason,
            }),
          );
          appendRunCancelledSystemMessage({ stmts: S, broadcast }, sessionId, termination.reason);
        }

        if (termination) {
          if (delegationWorkPromise) {
            handleDelegationCancel(sessionId);
            delegationWorkPromise = null;
          }
          finalizeChatRunAfterTermination({
            stmts: S,
            broadcast,
            sessionId,
            assistantMsgId,
            engine,
            model,
            agentId: agent.id,
            agentName: agent.name,
            agentColor: agent.color ?? null,
            assembled,
          });
          drainQueue(sessionId);
          return;
        }

        if (code !== 0 && !assembled) {
          // Node reports `-errno` on the close event when spawn fails without
          // an 'error' listener firing first (rare, but guards against edge
          // cases). -2 = ENOENT, -13 = EACCES. Produce a message that points
          // at the actual bin path + the config key to edit, rather than the
          // cryptic "codex-cli exited with code -2".
          //
          // pickProcessErrorMessage strips known stderr noise (e.g. Codex's
          // "Reading additional input from stdin..." line) and falls back to
          // streamErrorMessage (real upstream errors captured from stdout
          // JSONL) before the generic exit-code message.
          let errorMsg = pickProcessErrorMessage({
            stderr: errorOutput,
            streamErrorMessage,
            engine,
            exitCode: code,
          });
          if (code === -2 || code === -13) {
            const configKey =
              engine === 'cursor-agent'
                ? 'cursorBin'
                : engine === 'gemini-cli'
                  ? 'geminiBin'
                  : engine === 'codex-cli'
                    ? 'codexBin'
                    : 'claudeBin';
            const reason = code === -2 ? 'not found (ENOENT)' : 'not executable (EACCES)';
            errorMsg =
              `${engine} binary ${reason} at ${bin}. ` +
              `Update ${configKey} in Settings (or ~/.agent-hub/data/config.json) to the correct path.`;
          }

          // Self-heal "Session ID X is already in use" — the session's on-disk
          // JSONL exists but our DB never recorded `engine_session_id` (e.g. the
          // first turn died before any assistant_text). Persist the id so the
          // next retry uses `--resume`, and rewrite the surfaced error to point
          // the user at a retry instead of the cryptic CLI line.
          if (engine === 'claude-code' && isNewEngineSession && !engineSessionId) {
            const conflict =
              detectSessionIdInUseError(errorOutput) ||
              detectSessionIdInUseError(streamErrorMessage) ||
              detectSessionIdInUseError(errorMsg);
            if (conflict) {
              engineSessionId = conflict.sessionId;
              try {
                S.updateSessionEngineSessionId.run(conflict.sessionId, sessionId);
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(
                  '[chat] Failed to persist claude engine_session_id during recovery:',
                  message,
                );
              }
              errorMsg = buildSessionIdInUseRecoveryMessage(conflict.sessionId);
            }
          }

          // Self-heal "No conversation found with session ID" — usually a cwd
          // mismatch between turns (worktree vs project checkout) or a resume
          // attempt before Claude finished writing the JSONL. Clear the engine
          // link so the next turn uses `--session-id` + transcript bootstrap.
          if (engine === 'claude-code' && !isNewEngineSession) {
            const missing =
              detectNoConversationFoundError(errorOutput) ||
              detectNoConversationFoundError(streamErrorMessage) ||
              detectNoConversationFoundError(errorMsg);
            if (missing) {
              try {
                S.updateSessionEngineSessionId.run(null, sessionId);
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(
                  '[chat] Failed to clear claude engine_session_id during no-conversation recovery:',
                  message,
                );
              }
              const noConvRetries = msg._noConversationRetry ?? 0;
              if (noConvRetries < 1) {
                console.warn(
                  `[chat] No conversation for resume on session ${sessionId} (${isAutoContinuation ? 'auto-continuation' : 'user turn'}); ` +
                    `retrying once with --session-id (cwd=${effectiveCwd})`,
                );
                setImmediate(() => {
                  void handleChat(null, {
                    ...msg,
                    _noConversationRetry: noConvRetries + 1,
                    _spawnCwd: effectiveCwd,
                  } as InternalChatMessage).catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error('[auto-continuation] No-conversation retry failed:', message);
                    drainQueue(sessionId);
                  });
                });
                if (delegationWorkPromise) {
                  handleDelegationCancel(sessionId);
                  delegationWorkPromise = null;
                }
                return;
              }
              errorMsg = buildNoConversationFoundRecoveryMessage(missing.sessionId);
            }
          }

          // Record the errored turn on the session — Finalize automation
          // (auto-start/auto-push) is blocked while this flag is set, so an
          // autonomous session can never ship a half-finished turn. Cleared
          // at the next spawn (including the retry below).
          try {
            S.updateSessionLastTurnError.run(errorMsg, sessionId);
          } catch {}

          // Transient upstream failure (socket drop, 5xx/overloaded, rate
          // limit, timeout): retry the SAME message after a short backoff
          // instead of stranding the session on an error. Claude resumes via
          // `--resume <engine_session_id>` so no context is lost.
          {
            const transientRetries = msg._transientErrorRetry ?? 0;
            const retryPlan = planTransientErrorRetry(transientRetries, errorMsg);
            if (retryPlan.retry) {
              const attempt = transientRetries + 1;
              console.warn(
                `[chat] Transient engine error on session ${sessionId} (attempt ${attempt}); ` +
                  `retrying in ${retryPlan.delayMs}ms: ${errorMsg.slice(0, 200)}`,
              );
              persistCloseCardGateSystemMessage(
                sessionId,
                buildTransientRetryNotice(errorMsg, attempt, retryPlan.delayMs),
                { kind: 'turn_error_retry', attempt, errorText: errorMsg.slice(0, 500) },
              );
              if (delegationWorkPromise) {
                handleDelegationCancel(sessionId);
                delegationWorkPromise = null;
              }
              setTimeout(() => {
                void handleChat(null, {
                  ...msg,
                  _transientErrorRetry: attempt,
                  _spawnCwd: effectiveCwd,
                } as InternalChatMessage).catch((err: unknown) => {
                  const message = err instanceof Error ? err.message : String(err);
                  console.error('[turn-error-retry] Retry dispatch failed:', message);
                  drainQueue(sessionId);
                });
              }, retryPlan.delayMs);
              return;
            }
            if (transientRetries > 0) {
              // Retries exhausted — make the give-up explicit in the
              // transcript (the ⚠️ Error message below carries the error
              // itself; this explains why no further retry happens and that
              // Finalize automation stays paused).
              persistCloseCardGateSystemMessage(
                sessionId,
                buildTurnErrorHaltNotice(errorMsg, transientRetries),
                { kind: 'turn_error_halt', retries: transientRetries },
              );
            }
          }

          if (!termination) {
            console.error(
              formatChatExitLog({
                engine,
                sessionId,
                code,
                signal,
                reason: null,
              }),
            );
          }
          console.error(`  bin: ${bin}`);
          console.error(`  cwd: ${effectiveCwd}`);
          console.error(`  args: ${JSON.stringify(args)}`);
          if (errorOutput.trim()) console.error(`  stderr:\n${errorOutput.trim()}`);
          else console.error('  stderr: <empty>');
          try {
            S.addSessionEvent.run(
              'message',
              assistantMsgId,
              ++seq,
              'error',
              JSON.stringify({ type: 'error', message: errorMsg }),
            );
          } catch {}
          saveErrorMessage(sessionId, assistantMsgId, engine, model, errorMsg);
          broadcast({
            type: 'error',
            messageId: assistantMsgId,
            sessionId,
            error: errorMsg,
          });
          if (delegationWorkPromise) {
            handleDelegationCancel(sessionId);
            delegationWorkPromise = null;
          }
          try {
            const bgTask = S.getBackgroundTaskBySession.get(sessionId) as
              | BackgroundTaskRow
              | undefined;
            if (bgTask && bgTask.status === 'running') {
              S.updateBackgroundTaskStatus.run('error', bgTask.id);
              broadcast({
                type: 'task_complete',
                taskId: bgTask.id,
                sessionId,
                agentId,
                status: 'error',
              });
            }
          } catch {}
          try {
            const np = (S as Stmts).getNoteProcessingBySession?.get(sessionId) as
              | NoteProcessingRow
              | undefined;
            if (np && (np.status === 'pending' || np.status === 'running')) {
              S.updateNoteProcessing.run('error', JSON.stringify({ error: errorMsg }), np.id);
            }
          } catch {}
          drainQueue(sessionId);
          return;
        }

        // Turn ended WITH output but ALSO with an upstream error — e.g. text
        // streamed for a while, then "API Error: The socket connection was
        // closed unexpectedly" arrived as an `isError` result event and the
        // CLI exited non-zero. Historically this fell through to the success
        // path, so autonomous sessions auto-started Finalize on a
        // half-finished worktree. The partial message is still persisted
        // below (it's real context, and the engine session holds it for
        // `--resume`), but the session is flagged: Finalize automation is
        // blocked until a clean turn, and transient errors auto-retry via a
        // continuation at the tail of this handler.
        const turnEndError = resolveTurnEndError({
          exitCode: code,
          signal,
          streamErrorMessage,
          engine,
        });
        if (turnEndError) {
          try {
            S.updateSessionLastTurnError.run(turnEndError.errorText, sessionId);
          } catch {}
          console.warn(
            `[chat] Turn for session ${sessionId} ended with output but errored ` +
              `(code=${code}, signal=${signal ?? 'none'}): ${turnEndError.errorText.slice(0, 200)}`,
          );
        } else {
          // Clean close — the ONLY place the turn-error gate reopens. A
          // recovery turn that is merely in flight keeps the flag set (it was
          // written by the errored close that scheduled it), so Finalize
          // automation stays blocked until this verifiably clean exit.
          try {
            S.updateSessionLastTurnError.run(null, sessionId);
          } catch {}
        }

        const rawFinalContent = assembled || errorOutput.trim() || '(empty response)';
        let finalContent = rawFinalContent;
        const closeCardDetection = detectCloseCardBlock(rawFinalContent);
        const closeTask = closeCardDetection.task;
        // `<agenthub:preview>` block — request a per-session worktree
        // preview. Detected here alongside the other action blocks so the
        // post-stream hook below can dispatch boot + screenshot async.
        const previewDetection = detectPreviewBlock(rawFinalContent);
        // Sub-agent delegation and handoff have been removed. We retain the
        // local symbols as `null` so the rest of this handler — which still
        // branches on `handoffDetection` / `delegateTasks` while the rest of
        // the system is being progressively deleted — compiles and behaves as
        // if the model had emitted neither a `<delegate>` nor a `<handoff>`
        // block. Any literal `<delegate>...</delegate>` text the model still
        // produces is left in the assistant message as inert prose; the
        // dispatcher will not run.
        const handoffDetection = null as ReturnType<typeof detectHandoffBlock> | null;
        const delegationDisabled = false;
        const delegateTasks = null as ReturnType<typeof parseDelegateBlock> | null;
        // Platform-wide kill-switch: both systems are globally off. Guards the
        // malformed-gate and disabled-gate branches below so they behave
        // consistently instead of giving a misleading "bad JSON shape" nudge
        // when the real cause is global removal.
        // TODO(cleanup-card): delete with delegation modules
        const delegationGloballyOff = true;
        let shouldAutoContinue = false;
        let budgetResult: { ok: boolean; reasons: string[] } = { ok: false, reasons: [] };
        let continuationContextAdded = false;
        let assistantContextToAppend = '';
        const reactObservations: string[] = [];
        const reactLoopEnabled = (session!.react_loop_enabled ?? 1) !== 0;

        try {
          const actions: ReActAction[] = [];
          if (!reactLoopEnabled) {
            const rawSkillBlock = detectSkillInvokeBlock(rawFinalContent);
            if (rawSkillBlock) {
              const injection = handleSkillInvoke({
                rawBlock: rawSkillBlock,
                paths: { skillsDir: paths.skillsDir },
                sessionId,
                stmts: stmts as Stmts,
                broadcast,
                allowedSkills: agent.allowedSkills ?? null,
              });
              if (injection.trim()) {
                assistantContextToAppend = assistantContextToAppend
                  ? `${assistantContextToAppend}\n\n${injection}`
                  : injection;
                reactObservations.push('- Loaded skill context (legacy skill block).');
              }
            }
            // Standalone <agenthub:wiki> (no <agenthub:react>): must run the same
            // hybrid RAG path as the react-on / no-react-block branch, via `actions`
            // + the shared executor loop below.
            const rawWikiBlockLegacy = detectWikiRequestBlock(rawFinalContent);
            if (rawWikiBlockLegacy) {
              const parsedWiki = parseWikiRequestBlock(rawWikiBlockLegacy);
              if ('error' in parsedWiki) {
                reactObservations.push(`- Legacy wiki block malformed: ${parsedWiki.detail}`);
              } else {
                actions.push({ tool: 'wiki', query: parsedWiki.query });
              }
            }
          } else {
            const rawReactBlock = detectReActBlock(rawFinalContent);
            if (rawReactBlock) {
              const parsedReact = parseReActBlock(rawReactBlock);
              if ('error' in parsedReact) {
                reactObservations.push(`- ReAct block malformed: ${parsedReact.detail}`);
              } else {
                actions.push(...parsedReact.actions);
                // Same assistant message may also include legacy blocks; merge so
                // they are not dropped when a ReAct block is present.
                const legacySkillRaw = detectSkillInvokeBlock(rawFinalContent);
                if (legacySkillRaw) {
                  const pst = parseSkillBlock(legacySkillRaw);
                  if ('error' in pst) {
                    reactObservations.push(`- Legacy <agenthub:skill> malformed: ${pst.detail}`);
                  } else {
                    const dup = actions.some((a) => a.tool === 'skill' && a.name === pst.name);
                    if (dup) {
                      reactObservations.push(
                        `- Legacy <agenthub:skill> skipped (same skill already in the merged action list).`,
                      );
                    } else {
                      actions.push({ tool: 'skill', name: pst.name });
                      reactObservations.push(
                        `- Legacy <agenthub:skill> merged into ReAct queue as skill("${pst.name}").`,
                      );
                    }
                  }
                }
                const legacyWikiRaw = detectWikiRequestBlock(rawFinalContent);
                if (legacyWikiRaw) {
                  const pWiki = parseWikiRequestBlock(legacyWikiRaw);
                  if ('error' in pWiki) {
                    reactObservations.push(`- Legacy <agenthub:wiki> malformed: ${pWiki.detail}`);
                  } else {
                    const dup = actions.some((a) => a.tool === 'wiki' && a.query === pWiki.query);
                    if (dup) {
                      reactObservations.push(
                        `- Legacy <agenthub:wiki> skipped (same query already in the merged action list).`,
                      );
                    } else {
                      actions.push({ tool: 'wiki', query: pWiki.query });
                      reactObservations.push(`- Legacy <agenthub:wiki> merged into ReAct queue.`);
                    }
                  }
                }
              }
            } else {
              const rawSkillBlock = detectSkillInvokeBlock(rawFinalContent);
              if (rawSkillBlock) {
                const injection = handleSkillInvoke({
                  rawBlock: rawSkillBlock,
                  paths: { skillsDir: paths.skillsDir },
                  sessionId,
                  stmts: stmts as Stmts,
                  broadcast,
                  allowedSkills: agent.allowedSkills ?? null,
                });
                if (injection.trim()) {
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${injection}`
                    : injection;
                  reactObservations.push('- Loaded skill context (legacy skill block).');
                }
              }

              const rawWikiBlock = detectWikiRequestBlock(rawFinalContent);
              if (rawWikiBlock) {
                const parsedWiki = parseWikiRequestBlock(rawWikiBlock);
                if ('error' in parsedWiki) {
                  reactObservations.push(`- Legacy wiki block malformed: ${parsedWiki.detail}`);
                } else {
                  actions.push({ tool: 'wiki', query: parsedWiki.query });
                }
              }
            }
          }

          const maxAct = orchestrationBudgets.maxReactActionsPerTurn;
          if (actions.length > maxAct) {
            reactObservations.push(`- Action list exceeded ${maxAct}; truncated to budget.`);
          }
          let boundedActions = actions.slice(0, maxAct);
          const browserAllowed = effectiveBrowserToolsEnabled(agent, project);
          const browserLaunchOpts = resolveBrowserSessionOptions(agent, project);
          if (!browserAllowed) {
            const removed = boundedActions.filter((a) => a.tool === 'browser').length;
            if (removed > 0) {
              boundedActions = boundedActions.filter((a) => a.tool !== 'browser');
              reactObservations.push(
                `- ${removed} browser action(s) skipped: browser tools are disabled for agent "${agent.id}".`,
              );
              const gateMsg =
                '## Browser tools disabled\n\nHost browser tools are turned off for this agent (`browserToolsEnabled: false`). Remove `tool: browser` entries from your `<agenthub:react>` block, or ask an operator to re-enable them under Settings → Agents.';
              assistantContextToAppend = assistantContextToAppend
                ? `${assistantContextToAppend}\n\n${gateMsg}`
                : gateMsg;
            }
            // Preview drive/screenshot ops ride the same Chromium capability —
            // strip them too. `state` / `logs` are plain reads and stay allowed.
            const isPreviewDrive = (a: ReActAction) =>
              a.tool === 'preview' && PREVIEW_DRIVE_OPS.has(a.op ?? '');
            const removedPreviewDrive = boundedActions.filter(isPreviewDrive).length;
            if (removedPreviewDrive > 0) {
              boundedActions = boundedActions.filter((a) => !isPreviewDrive(a));
              reactObservations.push(
                `- ${removedPreviewDrive} preview browser action(s) skipped: browser tools are disabled for agent "${agent.id}" (preview \`state\`/\`logs\` remain available).`,
              );
            }
          }
          for (let actionIdx = 0; actionIdx < boundedActions.length; actionIdx++) {
            const action = boundedActions[actionIdx]!;
            const hostStepStart = Date.now();
            let hostExit = 0;
            let hostDetail: string | undefined;
            let hostActionThrew = false;
            let hostActionErr: unknown;
            try {
              if (action.tool === 'skill') {
                const injection = loadSkillByName({
                  name: action.name!,
                  reason: 'react-loop',
                  paths: { skillsDir: paths.skillsDir },
                  sessionId,
                  stmts: stmts as Stmts,
                  broadcast,
                  allowedSkills: agent.allowedSkills ?? null,
                });
                if (injection.trim()) {
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${injection}`
                    : injection;
                  reactObservations.push(`- skill("${action.name}") loaded.`);
                }
                if (!injection.trim()) {
                  hostExit = 2;
                  hostDetail = 'empty_injection';
                } else if (injection.includes('## Skill Load Error')) {
                  hostExit = 1;
                  hostDetail = action.name;
                } else {
                  hostDetail = action.name || undefined;
                }
                continue;
              }

              if (action.tool === 'web') {
                const webCap = orchestrationBudgets.maxWebSearchCallsPerSession;
                const webUsed = session!.web_search_calls_used || 0;
                if (webUsed >= webCap) {
                  const err = `## Web Search Error\nSession web search budget exhausted (${webUsed}/${webCap}).`;
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${err}`
                    : err;
                  reactObservations.push(
                    `- web("${action.query}") skipped: session web search budget exhausted.`,
                  );
                  hostExit = 2;
                  hostDetail = 'web_budget_exhausted';
                  continue;
                }
                const webRes = await runWebSearchForQuery(action.query!);
                if (webRes.markdown.trim()) {
                  const injection = webRes.markdown.trim();
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${injection}`
                    : injection;
                  reactObservations.push(`- web("${action.query}") returned results.`);
                }
                if (webRes.errorMarkdown?.trim()) {
                  const err = webRes.errorMarkdown.trim();
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${err}`
                    : err;
                  reactObservations.push(
                    `- web("${action.query}") reported an error or misconfiguration.`,
                  );
                }
                if (webRes.consumedCall) {
                  try {
                    const nextWeb = webUsed + 1;
                    stmts.updateSessionWebSearchCallsUsed.run(nextWeb, sessionId);
                    session!.web_search_calls_used = nextWeb;
                  } catch (err: unknown) {
                    const m = err instanceof Error ? err.message : String(err);
                    console.error(`[web-search] failed to persist web_search_calls_used: ${m}`);
                  }
                }
                if (!webRes.markdown.trim() && webRes.errorMarkdown?.trim()) {
                  hostExit = 1;
                } else if (!webRes.markdown.trim() && !webRes.errorMarkdown?.trim()) {
                  hostExit = 2;
                  hostDetail = 'empty_web_result';
                }
                hostDetail = hostDetail || (action.query ?? '').slice(0, 120) || undefined;
                continue;
              }

              if (action.tool === 'wiki') {
                if (!projectId) {
                  reactObservations.push('- wiki action skipped: missing project id.');
                  hostExit = 2;
                  hostDetail = 'missing_project_id';
                  continue;
                }
                const rawWikiBlock =
                  action.query && action.query.startsWith('<agenthub:wiki>')
                    ? action.query
                    : `<agenthub:wiki>${JSON.stringify({ query: action.query || '' })}</agenthub:wiki>`;
                const wikiRequest = await runWikiHybridRagForAssistantRequest(
                  projectId,
                  rawWikiBlock,
                  {
                    wikiHybridRagUsedCount: effectiveWikiHybridRagUsedCount(
                      session!.wiki_hybrid_rag_consumed,
                      session!.wiki_hybrid_rag_budget_version,
                      maxWikiSession,
                    ),
                    maxCallsPerSession: maxWikiSession,
                  },
                );
                if (wikiRequest.promptSuffix.trim()) {
                  const injection = wikiRequest.promptSuffix.trim();
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${injection}`
                    : injection;
                  reactObservations.push(`- wiki("${action.query || ''}") returned context.`);
                }
                if (wikiRequest.errorSuffix.trim()) {
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${wikiRequest.errorSuffix.trim()}`
                    : wikiRequest.errorSuffix.trim();
                  reactObservations.push(`- wiki("${action.query || ''}") returned error.`);
                }
                if (wikiRequest.shouldIncrementWikiHybridRagUsage) {
                  try {
                    const next = nextWikiHybridRagRowAfterIncrement(
                      session!.wiki_hybrid_rag_consumed,
                      session!.wiki_hybrid_rag_budget_version,
                      maxWikiSession,
                    );
                    stmts.updateSessionWikiHybridRagBudget.run(
                      next.consumed,
                      next.budgetVersion,
                      sessionId,
                    );
                    session!.wiki_hybrid_rag_consumed = next.consumed;
                    session!.wiki_hybrid_rag_budget_version = next.budgetVersion;
                  } catch (err: unknown) {
                    const m = err instanceof Error ? err.message : String(err);
                    console.error(`[wiki-rag] failed to persist assistant usage count: ${m}`);
                  }
                }
                if (wikiRequest.logWarning) {
                  console.warn(
                    `[wiki-rag] assistant retrieval failed for session ${sessionId}: ${wikiRequest.logWarning}`,
                  );
                }
                if (!wikiRequest.promptSuffix.trim() && wikiRequest.errorSuffix.trim()) {
                  hostExit = 1;
                } else if (!wikiRequest.promptSuffix.trim() && !wikiRequest.errorSuffix.trim()) {
                  hostExit = 2;
                  hostDetail = 'empty_wiki_result';
                }
                hostDetail = hostDetail || (action.query ?? '').slice(0, 120) || undefined;
                continue;
              }

              if (action.tool === 'browser') {
                const actionId = uuidv4();
                const browserInput = {
                  op: action.op ?? '',
                  url: action.url,
                  target: action.target,
                  text: action.text,
                  instruction: action.instruction,
                  schema: action.schema,
                  direction: action.direction,
                  condition: action.condition,
                };
                const startLabel = browserToolStartLabel(browserInput);
                const startedAtMs = Date.now();
                emitBrowserActivityEvent(
                  buildBrowserActivityStartedEvent({
                    actionId,
                    op: browserInput.op || 'unknown',
                    label: startLabel,
                    startedAtMs,
                  }),
                );
                const browserOpStartMs = Date.now();
                let b: Awaited<ReturnType<typeof runBrowserReActStep>>;
                try {
                  b = await runBrowserReActStep(
                    sessionId,
                    {
                      op: browserInput.op,
                      url: browserInput.url,
                      target: browserInput.target,
                      text: browserInput.text,
                      instruction: browserInput.instruction,
                      schema: browserInput.schema,
                      direction: browserInput.direction,
                      condition: browserInput.condition,
                    },
                    browserLaunchOpts,
                  );
                } catch (err: unknown) {
                  emitBrowserActivityEvent(
                    buildBrowserActivityEndedThrowEvent({
                      actionId,
                      op: browserInput.op || 'unknown',
                      label: startLabel,
                      startedAtMs,
                      durationMs: Date.now() - browserOpStartMs,
                      err,
                    }),
                  );
                  throw err;
                }

                emitBrowserActivityEvent(
                  buildBrowserActivityEndedEvent({
                    actionId,
                    op: browserInput.op || 'unknown',
                    label: startLabel,
                    startedAtMs,
                    durationMs: Date.now() - browserOpStartMs,
                    b,
                  }),
                );
                const shot = buildBrowserActivityScreenshotBroadcast({
                  sessionId,
                  messageId: assistantMsgId,
                  actionId,
                  screenshotWsUrl: b.ui?.screenshotWsUrl,
                });
                if (shot) broadcast(shot);
                if (b.markdown.trim()) {
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${b.markdown.trim()}`
                    : b.markdown.trim();
                  reactObservations.push(
                    `- browser(${action.op}) host step finished (exit ${b.hostExit}).`,
                  );
                }
                hostExit = b.hostExit;
                hostDetail = b.hostDetail || action.op;
                continue;
              }

              if (action.tool === 'preview') {
                const actionId = uuidv4();
                const opName = action.op ?? '';
                const startLabel = `Preview: ${opName || 'action'}…`;
                const startedAtMs = Date.now();
                emitBrowserActivityEvent(
                  buildBrowserActivityStartedEvent({
                    actionId,
                    op: `preview:${opName || 'unknown'}`,
                    label: startLabel,
                    startedAtMs,
                  }),
                );
                const previewOpStartMs = Date.now();
                let p: Awaited<ReturnType<typeof runPreviewReActStep>>;
                try {
                  p = await runPreviewReActStep(
                    sessionId,
                    {
                      op: opName,
                      route: action.route,
                      tail: action.tail,
                      target: action.target,
                      text: action.text,
                      instruction: action.instruction,
                      schema: action.schema,
                      direction: action.direction,
                      condition: action.condition,
                    },
                    {
                      runtime: getPreviewComposeRuntime ? getPreviewComposeRuntime() : null,
                      launchOpts: browserLaunchOpts,
                    },
                  );
                } catch (err: unknown) {
                  emitBrowserActivityEvent(
                    buildBrowserActivityEndedThrowEvent({
                      actionId,
                      op: `preview:${opName || 'unknown'}`,
                      label: startLabel,
                      startedAtMs,
                      durationMs: Date.now() - previewOpStartMs,
                      err,
                    }),
                  );
                  throw err;
                }
                emitBrowserActivityEvent(
                  buildBrowserActivityEndedEvent({
                    actionId,
                    op: `preview:${opName || 'unknown'}`,
                    label: startLabel,
                    startedAtMs,
                    durationMs: Date.now() - previewOpStartMs,
                    b: p,
                  }),
                );
                const previewShot = buildBrowserActivityScreenshotBroadcast({
                  sessionId,
                  messageId: assistantMsgId,
                  actionId,
                  screenshotWsUrl: p.ui?.screenshotWsUrl,
                });
                if (previewShot) broadcast(previewShot);
                if (p.markdown.trim()) {
                  assistantContextToAppend = assistantContextToAppend
                    ? `${assistantContextToAppend}\n\n${p.markdown.trim()}`
                    : p.markdown.trim();
                  reactObservations.push(
                    `- preview(${opName}) host step finished (exit ${p.hostExit}).`,
                  );
                }
                hostExit = p.hostExit;
                hostDetail = p.hostDetail || opName;
                continue;
              }
            } catch (err: unknown) {
              hostActionThrew = true;
              hostActionErr = err;
            } finally {
              const merged = mergeHostActionExitForEmit({
                thrown: hostActionThrew,
                err: hostActionErr,
                branchExit: hostExit,
                branchDetail: hostDetail,
              });
              emitReactLoopStep(broadcast, {
                sessionId,
                messageId: assistantMsgId,
                stepId: `${assistantMsgId}:host:${actionIdx}:${action.tool}`,
                phase: 'host_action',
                tool: action.tool,
                exitCode: merged.exitCode,
                durationMs: Date.now() - hostStepStart,
                continuationDepth,
                chainElapsedMs: Date.now() - chainStartedAtMs,
                detail: merged.detail,
              });
            }
            if (hostActionThrew) {
              throw hostActionErr;
            }
          }

          if (reactObservations.length > 0) {
            const observationBlock = `## ReAct Observation\n${reactObservations.join('\n')}`;
            assistantContextToAppend = assistantContextToAppend
              ? `${assistantContextToAppend}\n\n${observationBlock}`
              : observationBlock;
          }

          if (assistantContextToAppend.trim()) {
            const latest = stmts.getSession.get(sessionId) as SessionRow | undefined;
            const existing = latest?.pending_skill_context?.trim() || '';
            const merged = mergePendingContextWithCap(existing, assistantContextToAppend);
            stmts.updateSessionPendingSkillContext.run(merged || null, sessionId);
            continuationContextAdded = !!merged;
          }
        } catch (err) {
          console.error('[assistant-context] Unexpected error:', (err as Error).message);
        }

        finalContent = stripAssistantControlBlocks(finalContent);
        if (!finalContent.trim()) {
          finalContent = continuationContextAdded
            ? 'Loaded requested context for continuation.'
            : '(empty response)';
        }

        const hasDelegateBlock = /<delegate>\s*[\s\S]*?\s*<\/delegate>/.test(rawFinalContent);
        const controlFlowPresent =
          !!closeTask ||
          !!closeCardDetection.present ||
          !!handoffDetection?.present ||
          !!handoffDetection?.task ||
          !!delegateTasks ||
          hasDelegateBlock;
        budgetResult = evaluateReactContinuationBudgets({
          reactLoopEnabled,
          continuationContextAdded,
          controlFlowPresent,
          continuationDepth,
          chainStartedAtMs,
          nowMs: Date.now(),
          budgets: orchestrationBudgets,
        });
        shouldAutoContinue = budgetResult.ok;

        if (
          continuationDepth > 0 ||
          isAutoContinuation ||
          continuationContextAdded ||
          reactObservations.length > 0
        ) {
          emitReactLoopStep(broadcast, {
            sessionId,
            messageId: assistantMsgId,
            stepId: `${assistantMsgId}:chain_gate`,
            phase: 'chain_gate',
            tool: 'chain',
            exitCode: budgetResult.ok ? 0 : 2,
            durationMs: 0,
            continuationDepth,
            chainElapsedMs: Date.now() - chainStartedAtMs,
            detail: budgetResult.ok
              ? 'continuation_allowed'
              : budgetResult.reasons.length
                ? budgetResult.reasons.join('; ')
                : 'blocked_or_ineligible',
          });
        }

        try {
          S.addMessage.run(
            assistantMsgId,
            sessionId,
            'assistant',
            finalContent,
            engine,
            model,
            null,
            null,
            null,
            null,
            null,
          );
          S.touchSession.run(sessionId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[stream] Dropping assistant message for ${sessionId}: ${message}`);
          if (delegationWorkPromise) {
            handleDelegationCancel(sessionId);
            delegationWorkPromise = null;
          }
          drainQueue(sessionId);
          return;
        }

        if (engine === 'claude-code' && isNewEngineSession) {
          try {
            S.updateSessionEngineSessionId.run(sessionId, sessionId);
          } catch {}
        }

        // Auto-rename now happens synchronously when the first user message
        // lands (see the early branch after `isFirstMessage` is computed in
        // `handleChat`). Nothing to do here at stream-end.
        const sess = S.getSession.get(sessionId) as SessionRow | undefined;

        // Enrich the broadcast with agent + session names so push-notification
        // consumers (mobile) don't need a second round-trip to look them up.
        // `sess` was just re-read; fall back to the original session row if
        // it disappeared between the addMessage and this getSession.
        const latestSess = sess;
        broadcast({
          type: 'done',
          messageId: assistantMsgId,
          sessionId,
          agentId: agent.id,
          agentName: agent.name,
          sessionName: latestSess?.name,
          // Session owner so clients can scope foreground banners to the
          // account that owns the session (push is filtered server-side in
          // push.ts; this covers the WS → local-notification path).
          ownerUserId: getSessionOwner(sessionId),
          message: {
            id: assistantMsgId,
            session_id: sessionId,
            role: 'assistant',
            content: finalContent,
            engine,
            model,
            created_at: new Date().toISOString(),
          },
        });

        // Finalize fix-dispatch + rebase conflict waits resolve on turn-end.
        try {
          notifyFinalizeSessionTurnEnd(sessionId);
        } catch (err) {
          console.warn(
            `[chat] finalize turn-end notify threw for ${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // §13 active-time budget — Finalize Code Changes.
        //
        // If this session has an in-flight `finalize_runs` row, bill the
        // turn's wall-clock duration to that run's
        // `active_seconds_consumed`. Active = "the seconds Agent Hub spent
        // actually processing the run"; the originating session's turn
        // duration counts toward that (the fix-dispatch loop runs through
        // this same session, so a long turn IS active Hub processing).
        //
        // No-op when the session has no active Finalize run; never
        // throws — `billSessionTurnDurationIfTaggedToFinalize` swallows
        // all errors so a stray finalize accounting glitch can never
        // break chat.
        try {
          const turnDurationMs = Date.now() - cliTurnStartMs;
          billSessionTurnDurationIfTaggedToFinalize(
            { stmts: S, broadcast },
            sessionId,
            turnDurationMs,
          );
        } catch (err) {
          console.warn(
            `[chat] finalize active-seconds hook threw for ${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Sidebar "waiting on user input" signal. The assistant just landed
        // its turn; if the final content carries an unanswered `agenthub:ask`
        // picker (and no follow-up turn is queued), broadcast so sidebars can
        // light the green dot. The detector also handles the inverse — if
        // the previous waiting state has been cleared (e.g. a tool-only turn
        // that doesn't repeat the ask), it broadcasts `waiting: false` so
        // clients drop the indicator.
        broadcastAwaitingInputForSession(sessionId, stmts, broadcast);
        // Turn-end signal boundary: the active task is gone, so the resolved
        // state drops back to whatever the live signals say (waiting / merged /
        // settled pushed). Persist + push `session_state` so the icon updates.
        recomputeSessionState(stmts, sessionId, { agentId, broadcast });

        const wouldBaseContinue =
          reactLoopEnabled && continuationContextAdded && !controlFlowPresent;
        if (wouldBaseContinue && !budgetResult.ok && budgetResult.reasons.length > 0) {
          const sysId = uuidv4();
          const body = `**ReAct chain halted**\n\nContext was loaded for a follow-up model turn, but orchestration budgets blocked auto-continuation:\n- ${budgetResult.reasons.join('\n- ')}`;
          try {
            stmts.addMessage.run(
              sysId,
              sessionId,
              'system',
              body,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
            );
            stmts.touchSession.run(sessionId);
            const inserted = stmts.getMessageById.get(sysId) as MessageRow | undefined;
            if (inserted) {
              broadcast({ type: 'message', sessionId, message: inserted });
            }
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[react-budget] failed to persist system notice: ${m}`);
          }
        }

        try {
          const bgTask = S.getBackgroundTaskBySession.get(sessionId) as
            | BackgroundTaskRow
            | undefined;
          if (bgTask && bgTask.status === 'running') {
            S.updateBackgroundTaskStatus.run('done', bgTask.id);
            broadcast({
              type: 'task_complete',
              taskId: bgTask.id,
              sessionId,
              agentId,
              status: 'done',
              preview: finalContent.substring(0, 200),
            });
          }
        } catch {}

        try {
          const np = (S as Stmts).getNoteProcessingBySession?.get(sessionId) as
            | NoteProcessingRow
            | undefined;
          if (np && (np.status === 'pending' || np.status === 'running')) {
            S.updateNoteProcessing.run('success', finalContent.substring(0, 1000), np.id);
          }
        } catch {}

        if (project.ahw && !isAutoContinuation) {
          const briefEntry = `**Chat** — User: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}\nAssistant: ${finalContent.substring(0, 200)}${finalContent.length > 200 ? '...' : ''}`;
          appendDailyNote(project.ahw, briefEntry);

          if (finalContent.length > 300) {
            const exchangeTranscript = buildTranscript(
              [
                { role: 'user' as const, content },
                { role: 'assistant' as const, content: finalContent },
              ] as unknown as MessageRow[],
              { agentName: agent.name },
            );
            summarizeTranscript(
              exchangeTranscript,
              {
                engine: engine || 'claude-code',
                model: model,
                cwd: project.cwd,
              },
              config,
              {
                ownerId,
                agentId: agent.id,
                project,
              },
            )
              .then((summary: string) => {
                if (summary && summary.trim()) {
                  appendDailyNote(project.ahw, `**Session Summary** (${agent.name}):\n${summary}`);

                  reconcileMemoryAfterSession(project.ahw, summary, {
                    cfg: config,
                    spawnEnv: buildSpawnEnv(config),
                    cwd: project.cwd,
                  }).catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error('[Memory Reconciliation] Post-session failed:', message);
                  });
                }
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                console.error('[Auto-summarize] Failed:', message);
              });
          }
        }

        // Auto-close the linked kanban card when the agent reports the work
        // is a duplicate or already done via an `<agenthub:close-card>` block.
        // Malformed blocks (missing/invalid fields) are rejected via a system
        // message; the linked card is not moved.
        if (closeCardDetection.present && !closeTask && closeCardDetection.reason) {
          persistCloseCardGateSystemMessage(
            sessionId,
            `**Card close gate rejected:** ${describeCloseCardReason(closeCardDetection.reason)}.\n\nThe linked kanban card was **not** moved to Done.`,
            {
              kind: 'close_card_gate',
              outcome: 'gate_rejected',
              reason: closeCardDetection.reason,
            },
          );
        }

        if (closeTask) {
          try {
            const projectId =
              (project as Project & { id?: string }).id ||
              (enrichedAgent as EnrichedAgent | null | undefined)?.projectId ||
              '';
            handleCardAutoClose(sessionId, closeTask, {
              stmts: stmts as Stmts,
              broadcast,
              projectId,
              author: agent.id,
            });
          } catch (err) {
            console.error('[CardAutoClose] Unexpected error:', (err as Error).message);
          }
        }

        // ── `<agenthub:preview>` dispatch ───────────────────────────────
        // Malformed blocks: surface a system message so the agent learns
        // why the request was dropped — same shape as the close-card gate.
        const previewSyncDeps = {
          broadcast,
          getPreviewComposeRuntime,
          getPreviewRuntime,
          stmts,
          project,
          worktreePath: effectiveCwd,
        };
        const previewAlreadyRunning = sessionHasActiveUserPreview(sessionId, previewSyncDeps);

        if (
          previewDetection.present &&
          !previewDetection.task &&
          previewDetection.reason &&
          !previewAlreadyRunning
        ) {
          try {
            broadcast({
              type: 'agenthub_preview',
              kind: 'preview_failed',
              sessionId,
              previewId: '',
              error: `**Preview block rejected:** ${describePreviewReason(previewDetection.reason)}.`,
              logTail: [],
            });
          } catch (err) {
            console.error('[Preview] Failed to broadcast malformed-block notice:', err);
          }
        }
        const sessionAfterTurn = stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (sessionAfterTurn?.code_changed_at) {
          void syncPreviewAfterWorktreeTurnIfDirty(sessionId, effectiveCwd, previewSyncDeps);
        }

        if (previewDetection.task && !previewAlreadyRunning) {
          // Preview boot is user-initiated only (POST …/preview/start). Agent
          // `<agenthub:preview>` blocks are ignored so sessions never spin
          // docker/npm stacks on their own. Do not broadcast preview_failed when
          // the user already has a running preview — that would clobber Ready UI.
          try {
            broadcast({
              type: 'agenthub_preview',
              kind: 'preview_failed',
              sessionId,
              previewId: '',
              error:
                '**Preview not started:** only the human can boot a preview via **Start preview** in the chat toolbar. Do not emit `<agenthub:preview>` — the host ignores agent-initiated preview requests.',
              logTail: [],
            });
          } catch (err) {
            console.error('[Preview] Failed to broadcast agent-preview rejection:', err);
          }
        }

        const runWorktreeAutoCommitAndDrainTail = async (
          allowFinalizeAutoStart: boolean,
        ): Promise<void> => {
          const worktreeClaude = engine === 'claude-code' && effectiveCwd !== project.cwd;
          if (worktreeClaude) {
            await new Promise<void>((resolve) => setTimeout(resolve, 1200));
          }
          await autoCommitAndPR(sessionId, agentId, project, agent, effectiveCwd, finalContent, {
            allowFinalizeAutoStart,
          }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[auto-commit] Unexpected error:', message);
          });
          if (autonomousProjects.size > 0) {
            setTimeout(() => tryAutonomousDispatch(), 2000);
          }
          drainQueue(sessionId);
        };

        if (shouldAutoContinue) {
          await runWorktreeAutoCommitAndDrainTail(false);
          setImmediate(() => {
            handleChat(null, {
              type: 'chat',
              agentId,
              sessionId,
              content: buildAutoContinuationPrompt(effectiveBrowserToolsEnabled(agent, project)),
              _autoContinuation: true,
              _continuationDepth: continuationDepth + 1,
              _chainStartedAtMs: chainStartedAtMs,
              _spawnCwd: effectiveCwd,
            } as InternalChatMessage).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('[auto-continuation] Failed:', message);
              drainQueue(sessionId);
            });
          });
          return;
        }

        // Handoff takes precedence over delegate — if the agent emitted a
        // <handoff> block, ownership transfers to the target agent and we do
        // not run the delegate/synthesize flow for this turn. Per design,
        // <handoff> is terminal: any prose after the closing tag is dropped.
        if (enrichedAgent) {
          // No fallback to detectHandoffBlock — handoff dispatch is globally off.
          // When handoffDetection is null the entire block below is skipped.
          const detection = handoffDetection;
          if (detection !== null && detection.task) {
            if (delegationWorkPromise) {
              handleDelegationCancel(sessionId);
              delegationWorkPromise = null;
            }
            if (handoffHasTrailingContent(rawFinalContent)) {
              console.warn(
                `[Handoff] Trailing content after </handoff> in session ${sessionId} — dropped (handoff is terminal).`,
              );
            }
            handleHandoff(sessionId, assistantMsgId, detection.task, enrichedAgent, project).catch(
              (err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                console.error('[Handoff] Failed:', message);
                broadcast({ type: 'handoff_error', sessionId, error: message });
              },
            );
            drainQueue(sessionId);
            return;
          }
          if (detection !== null && detection.present && detection.reason) {
            if (delegationWorkPromise) {
              handleDelegationCancel(sessionId);
              delegationWorkPromise = null;
            }
            // The agent emitted a <handoff> tag but the payload was malformed
            // (bad JSON, missing fields, etc.). Previously this path silently
            // dropped the handoff with no UI feedback. Now: record a failed
            // row + broadcast handoff_error so the widget renders the failure
            // state instead of leaving the user staring at a dead-air turn.
            const projectId =
              (project as Project & { id?: string }).id ||
              (enrichedAgent as EnrichedAgent & { projectId?: string }).projectId ||
              '';
            recordMalformedHandoff({
              stmts,
              broadcast,
              sessionId,
              fromAgentId: enrichedAgent.id,
              fromAgentName: enrichedAgent.name,
              projectId,
              detection,
            });
            console.warn(
              `[Handoff] Malformed <handoff> block in session ${sessionId}: ${detection.reason}`,
            );
            drainQueue(sessionId);
            return;
          }
        }

        // Operator-controlled gate (`delegationEnabled === false`): the lead is
        // configured for inline-only completion. Surface a clear in-chat nudge
        // and a `delegation_disabled` WS event for the message-anchored
        // DelegateCard so the user knows exactly why nothing dispatched. This
        // case takes priority over the malformed-gate branch below — when
        // delegation is disabled we don't care whether the block parsed, the
        // outcome is the same: nothing spawns.
        const leadHasSubAgents =
          agent.role === 'lead' && !!agent.subAgents && agent.subAgents.length > 0;
        if (leadHasSubAgents && hasDelegateBlock && (delegationDisabled || delegationGloballyOff)) {
          const sysId = uuidv4();
          const body = delegationGloballyOff
            ? '**Sub-agent delegation has been removed.** The `<delegate>` block was ignored — the delegation/handoff system is no longer active on this platform. Use direct chat or multi-agent sessions to coordinate with other agents.'
            : '**Delegation disabled for this lead.** The `<delegate>` block was ignored — this lead agent is configured to complete work inline. Re-enable delegation in agent settings to use sub-agents, or finish the task yourself.';
          try {
            stmts.addMessage.run(
              sysId,
              sessionId,
              'system',
              body,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
            );
            stmts.touchSession.run(sessionId);
            const insertedMessage = (stmts.getMessageById.get(sysId) as MessageRow | undefined) ?? {
              id: sysId,
              session_id: sessionId,
              role: 'system' as const,
              content: body,
              engine: null,
              model: null,
              attachments: null,
              metadata: null,
              created_at: new Date().toISOString(),
            };
            broadcast({ type: 'message_added', sessionId, message: insertedMessage });
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[delegation] failed to persist disabled-gate notice: ${m}`);
            const fallback: MessageRow = {
              id: sysId,
              session_id: sessionId,
              role: 'system',
              content: body,
              engine: null,
              model: null,
              attachments: null,
              metadata: null,
              created_at: new Date().toISOString(),
            };
            broadcast({ type: 'message_added', sessionId, message: fallback });
          }
          // Anchored banner on the DelegateCard. Same shape as
          // `delegation_error` so the client's existing dispatchError
          // correlation logic works without a parallel state machine.
          broadcast({
            type: 'delegation_disabled',
            sessionId,
            parentMessageId: assistantMsgId,
            reason: 'Delegation disabled for this lead',
          });
        }

        if (
          leadHasSubAgents &&
          hasDelegateBlock &&
          !delegateTasks &&
          !delegationDisabled &&
          !delegationGloballyOff
        ) {
          const sysId = uuidv4();
          const body =
            '**Delegation gate rejected.** `<delegate>` payload must be a JSON array of task objects (or a single task object — it will be coerced to a one-element array). Every task must include `agentId`, `task`, `owner`, `scope`, `expectedArtifact`, `deadline`, and `returnFormat`. No delegation was started.';
          try {
            stmts.addMessage.run(
              sysId,
              sessionId,
              'system',
              body,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
            );
            stmts.touchSession.run(sessionId);
            const insertedMessage = (stmts.getMessageById.get(sysId) as MessageRow | undefined) ?? {
              id: sysId,
              session_id: sessionId,
              role: 'system' as const,
              content: body,
              engine: null,
              model: null,
              attachments: null,
              metadata: null,
              created_at: new Date().toISOString(),
            };
            broadcast({ type: 'message_added', sessionId, message: insertedMessage });
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[delegation] failed to persist malformed delegate notice: ${m}`);
            const fallback: MessageRow = {
              id: sysId,
              session_id: sessionId,
              role: 'system',
              content: body,
              engine: null,
              model: null,
              attachments: null,
              metadata: null,
              created_at: new Date().toISOString(),
            };
            broadcast({ type: 'message_added', sessionId, message: fallback });
          }
        }

        if (agent.role === 'lead' && agent.subAgents && agent.subAgents.length > 0) {
          const parsedDelegateTasks = delegateTasks;
          const closePlan = planDelegationRoundOnProcClose({
            delegateTasks: parsedDelegateTasks,
            hadEarlyDelegationPromise: delegationWorkPromise != null,
          });
          if (closePlan.mode === 'delegate') {
            if (closePlan.startIfNeeded) {
              startDelegationOnce(parsedDelegateTasks!);
            }

            if (delegationWorkPromise) {
              void delegationWorkPromise
                .then((results) => {
                  if (results.length > 0) {
                    return synthesizeResults(
                      sessionId,
                      agentId,
                      enrichedAgent!,
                      project,
                      results,
                      content,
                      effectiveCwd,
                    );
                  }
                })
                .catch((err: unknown) => {
                  const message = err instanceof Error ? err.message : String(err);
                  console.error('[Delegation] Failed:', message);
                  broadcast({
                    type: 'delegation_error',
                    sessionId,
                    parentMessageId: assistantMsgId,
                    error: message,
                  });
                })
                .finally(() => {
                  clearDelegationSafetyTimer();
                  activeDelegationSessions.delete(sessionId);
                  clearDelegationUiMeta(sessionId);
                  broadcastActiveTasksSnapshot(stmts, broadcast);
                  drainQueue(sessionId);
                });
            } else {
              drainQueue(sessionId);
            }
            return;
          }
        }

        // Errored-but-assembled turn: auto-commit so work-in-progress is
        // preserved on the session branch, but NEVER allow the commit to
        // auto-start Finalize (the `last_turn_error` flag also guards the
        // automation-runner side). Transient errors get a bounded
        // auto-continuation: the engine session resumes with a recovery
        // prompt so the agent verifies and finishes the interrupted work.
        if (turnEndError) {
          const transientRetries = msg._transientErrorRetry ?? 0;
          const retryPlan = planTransientErrorRetry(transientRetries, turnEndError.errorText);
          await runWorktreeAutoCommitAndDrainTail(false);
          if (retryPlan.retry) {
            const attempt = transientRetries + 1;
            console.warn(
              `[chat] Scheduling turn-error continuation for session ${sessionId} ` +
                `(attempt ${attempt}) in ${retryPlan.delayMs}ms`,
            );
            persistCloseCardGateSystemMessage(
              sessionId,
              buildTransientRetryNotice(turnEndError.errorText, attempt, retryPlan.delayMs),
              {
                kind: 'turn_error_retry',
                attempt,
                errorText: turnEndError.errorText.slice(0, 500),
              },
            );
            setTimeout(() => {
              void handleChat(null, {
                type: 'chat',
                agentId,
                sessionId,
                content: buildTurnErrorContinuationPrompt(turnEndError.errorText),
                _autoContinuation: true,
                _continuationDepth: continuationDepth + 1,
                _chainStartedAtMs: chainStartedAtMs,
                _spawnCwd: effectiveCwd,
                _transientErrorRetry: attempt,
              } as InternalChatMessage).catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                console.error('[turn-error-retry] Continuation dispatch failed:', message);
                drainQueue(sessionId);
              });
            }, retryPlan.delayMs);
          } else {
            persistCloseCardGateSystemMessage(
              sessionId,
              buildTurnErrorHaltNotice(turnEndError.errorText, transientRetries),
              { kind: 'turn_error_halt', retries: transientRetries },
            );
          }
          return;
        }

        // Isolated (git worktree) + Claude: give the filesystem a moment to settle
        // after the CLI exits before `git status` / `gh`. The old flow ran auto-commit
        // from the HTTP stop hook immediately; if git still looked clean, the hook
        // path marked the session "handled" and proc skipped — no `changes_ready`
        // / Create PR banner even with Isolated ON.
        await runWorktreeAutoCommitAndDrainTail(true);
      });

      proc.on('error', (err: Error) => {
        spawnErrored = true;
        activeProcesses.delete(sessionId);
        // Also clean up the per-spawn system-prompt temp file when
        // spawn itself fails (e.g. ENOENT before exec). The close
        // handler will still fire, but it runs after this and we want
        // the rm to happen even if a later handler short-circuits.
        if (systemPromptFileCleanup) {
          systemPromptFileCleanup();
          systemPromptFileCleanup = null;
        }
        try {
          S.deleteActiveTask.run(sessionId);
        } catch {}
        const engineLabel =
          engine === 'cursor-agent'
            ? 'cursor agent'
            : engine === 'gemini-cli'
              ? 'gemini'
              : engine === 'codex-cli'
                ? 'codex'
                : 'claude';
        // Point the user at the correct config key. ENOENT here almost always
        // means the configured bin path is wrong (wiki: "Spawn PATH Propagation").
        const configKey =
          engine === 'cursor-agent'
            ? 'cursorBin'
            : engine === 'gemini-cli'
              ? 'geminiBin'
              : engine === 'codex-cli'
                ? 'codexBin'
                : 'claudeBin';
        const errnoCode = (err as NodeJS.ErrnoException).code;
        // Node reports ENOENT against the command when *either* the binary or
        // the cwd is missing. Re-check the cwd here so the user gets an
        // actionable message instead of being misdirected to the bin path.
        const cwdMissing = errnoCode === 'ENOENT' && !existsSync(effectiveCwd);
        const hint = cwdMissing
          ? ` — working directory does not exist: ${effectiveCwd}. Update the project's "cwd" in Settings or create the directory.`
          : errnoCode === 'ENOENT'
            ? ` — binary not found at ${bin}. Update ${configKey} in Settings or ~/.agent-hub/data/config.json.`
            : errnoCode === 'EACCES'
              ? ` — ${bin} is not executable. Update ${configKey} or chmod +x it.`
              : '';
        const errText = `Failed to spawn ${engineLabel}: ${err.message}${hint}`;
        saveErrorMessage(sessionId, assistantMsgId, engine, model, errText);
        broadcast({
          type: 'error',
          messageId: assistantMsgId,
          sessionId,
          error: errText,
        });
        try {
          notifyFinalizeSessionSpawnFailed(sessionId);
        } catch (notifyErr) {
          console.warn(
            `[chat] finalize spawn-failed notify threw for ${sessionId}: ${
              notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
            }`,
          );
        }
        drainQueue(sessionId);
      });
    } finally {
      if (persistHook && !persistReported) {
        persistReported = true;
        persistHook(false);
      }
    }
  }

  return {
    handleChat,
    saveErrorMessage,
    createCursorChat,
    initMultiAgent: () =>
      initSessionMultiAgent({
        stmts: stmts!,
        broadcast,
        getEnrichedAgent,
        buildEnrichedPrompt: (agent) =>
          buildEnrichedPrompt(
            findAgent(agent.id)!.project as ProjectWithCommands,
            agent as AgentWithModel,
            {
              useWorktree: false,
              isFirstMessage: false,
              // Advisor reviews/advises; the executor ships. No branch/ship guidance.
              omitDevLifecycle: true,
              _getEnrichedAgent: getEnrichedAgent,
            },
          ),
        getClaudeBin,
        getCursorBin,
        getGeminiBin,
        getCodexBin,
        getConfig: () => config,
        getMaxQueueSize: () => MAX_QUEUE_SIZE,
        runExecutorTurn: (ws, internalMsg) => handleChat(ws, internalMsg),
      }),
  };
}
