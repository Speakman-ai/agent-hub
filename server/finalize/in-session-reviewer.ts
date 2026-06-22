/**
 * in-session-reviewer.ts — Finalize Code Changes, in-session reviewer driver.
 *
 * Replaces the out-of-band reviewer that produced a JSON envelope with a
 * driver that:
 *
 *   1. Attaches the project's `role: 'reviewer'` agent to the originating
 *      session via `session_agents` so the reviewer surfaces in the
 *      sidebar and the chat UI knows who is talking.
 *   2. Spawns the reviewer's CLI engine over a **scoped local-diff
 *      prompt** ({@link buildLocalDiffReviewerPrompt}) — NOT the full
 *      session transcript. Session attachment is for output routing, not
 *      input bloat.
 *   3. Persists the reviewer's assistant message into the session timeline
 *      so a human can read + reply to it (the §10 "session is the canonical
 *      log" contract).
 *   4. Parses the trailing `<agenthub:review-verdict>` structured block off
 *      the reviewer's reply and returns `{ verdict, threads }` to the
 *      orchestrator, which still owns the existing transactional
 *      thread-and-verdict persistence (the side-panel store is unchanged).
 *
 * The reviewer's system prompt forbids file edits + GitHub API calls — the
 * advisor-system-prompt convention used by `runAdvisorTurn` plus an extra
 * Finalize-specific reinforcement that no PR exists yet.
 *
 * Cancellation: the driver honors an upstream `AbortSignal` so a Finalize
 * cancel mid-review kills the reviewer CLI cleanly. The orchestrator's
 * push-gate flow is unchanged.
 */

import type { ChildProcess } from 'child_process';
import { spawn, execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { resolveSessionCliSpawnEnv } from '../per-user-cli-spawn.js';
import { resolveEffectiveEngineAndModel } from '../effective-model.js';
import { mergeSkillCredentialSpawnEnv } from '../skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';
import { mergeProjectAwsSpawnEnv } from '../project-aws-spawn.js';
import { createStreamParser } from '../stream-parser.js';
import {
  buildSessionMultiSpawnArgs,
  normalizeSessionMultiEngine,
} from '../session-multi-engine.js';
import {
  buildLocalDiffReviewerPrompt,
  type ReviewerCancelSignal,
  type ReviewerRunResult,
  type RunReviewerOnLocalDiff,
  type ReviewerLocalDiffInputs,
} from './reviewer-dispatch.js';
import { detectReviewVerdictBlock, stripReviewVerdictBlock } from './review-verdict-block.js';
import { listSessionAgents } from '../session-agents.js';
import type {
  AgentLookup,
  AppConfig,
  BroadcastFn,
  EnrichedAgent,
  KanbanCardRow,
  Project,
  SessionRow,
  Stmts,
} from '../types.js';

/** Wall-clock cap on a single reviewer turn (ms). */
export const REVIEWER_TURN_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;

export interface InSessionReviewerDeps {
  stmts: Pick<
    Stmts,
    | 'addSessionAgent'
    | 'removeSessionAgent'
    | 'getSessionAgents'
    | 'addMessage'
    | 'touchSession'
    | 'getSession'
  >;
  broadcast: BroadcastFn;
  /** Same shape RouteDeps exposes; we use it to resolve the reviewer EnrichedAgent. */
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  /** Same shape RouteDeps exposes; used to look up the project root for an agent. */
  findAgent?: (agentId: string) => AgentLookup | null;
  /** Build the system prompt for an enriched agent (workspace + context). */
  buildEnrichedPrompt: (agent: EnrichedAgent) => string;
  getClaudeBin: () => string;
  getCursorBin: () => string;
  getGeminiBin: () => string;
  getCodexBin: () => string;
  getConfig: () => AppConfig;
  /** Track active CLIs so handleMultiAgentCancel can SIGTERM them. */
  activeProcesses?: Map<string, ChildProcess>;
  /** Override for tests; production uses the live spawn pipeline. */
  spawn?: typeof spawn;
  /** Per-call wall-clock cap; defaults to {@link REVIEWER_TURN_TIMEOUT_MS_DEFAULT}. */
  timeoutMs?: number;
  /** Deterministic id minter (defaults to uuid v4). */
  newId?: () => string;
  /** Deterministic clock injection (defaults to Date.now). */
  now?: () => number;
  /** Log sink (defaults to console.warn). */
  log?: (msg: string) => void;
}

/**
 * Build a {@link RunReviewerOnLocalDiff} driver bound to the live
 * Express server's dependency bag. The returned function attaches the
 * project's reviewer agent to the orchestrator's session at first call
 * and drives one turn against the scoped local-diff prompt.
 */
export function createInSessionReviewer(deps: InSessionReviewerDeps): RunReviewerOnLocalDiff {
  return async function runInSessionReviewer(args) {
    return runReviewerTurn(deps, args);
  };
}

/**
 * Drive one reviewer turn end-to-end. Exported for direct testing.
 *
 * `sessionId` is read from the run row by the orchestrator wiring layer
 * and threaded in via `args.sessionId` (added to the
 * `RunReviewerOnLocalDiff` contract). When absent we fall back to the
 * card's `session_id` and surface a clear error if neither exists — the
 * orchestrator has refused much earlier on a missing session, so this
 * defensive branch is for direct callers.
 */
export async function runReviewerTurn(
  deps: InSessionReviewerDeps,
  args: {
    runId: string;
    worktreePath: string;
    card: KanbanCardRow;
    project: Project;
    inputs: ReviewerLocalDiffInputs;
    sessionId?: string | null;
    /** Optional cancel signal; production threads orchestrator's signal through. */
    signal?: ReviewerCancelSignal;
  },
): Promise<ReviewerRunResult> {
  const { runId, worktreePath, card, project, inputs } = args;
  const log = deps.log ?? ((m) => console.warn(m));
  const newId = deps.newId ?? (() => uuidv4());
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? REVIEWER_TURN_TIMEOUT_MS_DEFAULT;
  const spawnFn = deps.spawn ?? spawn;
  const config = deps.getConfig();

  const sessionId = args.sessionId ?? card.session_id ?? null;
  if (!sessionId) {
    throw new Error(
      `[in-session-reviewer] run=${runId}: no sessionId resolved — card.session_id missing and orchestrator did not thread one through`,
    );
  }

  // Resolve the project's reviewer-role agent. The roster (project.agents)
  // is the single source of truth; we do not look up by name.
  const reviewerAgentId = pickReviewerAgentId(project);
  if (!reviewerAgentId) {
    throw new Error(
      `[in-session-reviewer] project=${project.id} has no role:'reviewer' agent — cannot run in-session review`,
    );
  }
  const reviewer = deps.getEnrichedAgent(reviewerAgentId);
  if (!reviewer) {
    throw new Error(
      `[in-session-reviewer] reviewer agent id=${reviewerAgentId} not found in registry`,
    );
  }

  // Look up the session row so we can read worktree paths and owner ids.
  const session = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) {
    throw new Error(`[in-session-reviewer] session=${sessionId} not found`);
  }

  // Capture the narrowed (non-null) values so the closures below — which
  // TypeScript widens back to the original `| null` / `| undefined` types
  // across the function boundary — see the proven-present shapes.
  const reviewerAgent: EnrichedAgent = reviewer;
  const sessionRow: SessionRow = session;

  // Broadcast the current session roster so web/mobile sidebars update
  // live as the reviewer joins and (in the `finally` below) leaves. The
  // payload is a partial session row — the clients merge it field-by-field
  // and read `agents` to refresh the multi-agent roster panel.
  const broadcastRoster = (): void => {
    try {
      const agents = listSessionAgents(deps.stmts, sessionRow, deps.getEnrichedAgent);
      deps.broadcast({
        type: 'session-updated',
        session: {
          id: sessionId,
          agents,
          advisor_count: Math.max(0, agents.length - 1),
        },
      });
    } catch (err) {
      log(
        `[in-session-reviewer] broadcastRoster(${sessionId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Attach reviewer to session (idempotent via INSERT OR IGNORE in
  // `addSessionAgent`). A second Finalize iteration on the same session
  // therefore re-uses the existing attachment row.
  try {
    deps.stmts.addSessionAgent.run(sessionId, reviewerAgent.id, sessionId);
    broadcastRoster();
  } catch (err) {
    log(
      `[in-session-reviewer] addSessionAgent(${sessionId},${reviewerAgent.id}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // The reviewer is "in" the session now. Whatever happens next — a clean
  // verdict, a parse failure, a timeout, or a Finalize cancel that kills
  // the CLI mid-turn — the reviewer must eject itself so it does not
  // linger in the roster. The `finally` removes the attachment row and
  // re-broadcasts the roster. The persisted review message stays in the
  // timeline (only the `session_agents` row is removed).
  try {
    return await runReviewerTurnInner(sessionId, reviewerAgent, sessionRow);
  } finally {
    try {
      deps.stmts.removeSessionAgent.run(sessionId, reviewerAgent.id);
      broadcastRoster();
    } catch (err) {
      log(
        `[in-session-reviewer] removeSessionAgent(${sessionId},${reviewerAgent.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ─── Reviewer turn body ────────────────────────────────────────────
  // Hoisted into a closure so the attach/eject lifecycle above can wrap
  // it in a single try/finally without re-indenting the whole body. The
  // `sessionId` / `reviewer` / `session` params shadow the outer consts
  // with their proven non-null types.
  async function runReviewerTurnInner(
    sessionId: string,
    reviewer: EnrichedAgent,
    session: SessionRow,
  ): Promise<ReviewerRunResult> {
    // Build the SCOPED prompt — the local-diff inputs, not the transcript.
    // The user-prompt size is bounded by the diff body; we do not feed
    // prior review messages back in (per design risk: avoid context
    // snowball across iterations).
    const userPrompt = buildLocalDiffReviewerPrompt({ inputs, card, project });

    const enrichedSystem = deps.buildEnrichedPrompt(reviewer);
    const systemPrompt = composeReviewerSystemPrompt(enrichedSystem, project, card);

    // No org-owner fallback — only the session's own owner.
    const roomOwnerId = session.owner_user_id || null;
    const resolvedEngineModel = resolveEffectiveEngineAndModel(config, {
      agentEngine: reviewer.engine,
      agentModel: reviewer.model as string | undefined,
      ownerUserId: roomOwnerId,
      // Honor the reviewer-page per-user engine/model dropdowns for the session owner.
      agentId: reviewer.id,
    });
    const engine = normalizeSessionMultiEngine(resolvedEngineModel.engine);
    const model = resolvedEngineModel.model;

    // Use session worktree by default; fall back to the runId-attached
    // worktree path (passed in by the orchestrator) when the session row
    // does not yet carry one.
    const cwd = session.worktree_path || worktreePath || reviewer.cwd || process.env.HOME || '/';

    // Spawn env: orchestrator env + agent's project secrets / aws / skill
    // credentials so the reviewer CLI carries through the project's
    // configured auth surface without leaking the executor's identity.
    const spawnEnv: NodeJS.ProcessEnv = {
      ...resolveSessionCliSpawnEnv({
        cfg: config,
        ownerId: roomOwnerId,
        credsOwnerId: roomOwnerId,
        sessionId,
        engine,
      }),
    };
    const reviewerProject = deps.findAgent?.(reviewer.id)?.project ?? project;
    if (reviewerProject && roomOwnerId) {
      mergeSkillCredentialSpawnEnv(spawnEnv, {
        ownerId: roomOwnerId,
        agentId: reviewer.id,
        project: reviewerProject,
      });
      mergeProjectSecretsSpawnEnv(spawnEnv, {
        projectId: reviewerProject.id,
        sessionId,
      });
      mergeProjectAwsSpawnEnv(spawnEnv, reviewerProject);
    }

    // Pre-spawn cancel check — beats the persist-message write so a
    // cancellation race with attach + spawn does not leave a partial chat
    // message in the timeline.
    if (args.signal?.aborted) {
      throw new Error('cancelled');
    }

    const assistantMsgId = newId();
    deps.broadcast({
      type: 'thinking',
      sessionId,
      agentId: reviewer.id,
      agentName: reviewer.name,
      agentColor: reviewer.color,
      messageId: assistantMsgId,
    });

    const rawText = await runOneTurn({
      engine,
      model,
      systemPrompt,
      userPrompt,
      bins: {
        claude: deps.getClaudeBin(),
        cursor: deps.getCursorBin(),
        gemini: deps.getGeminiBin(),
        codex: deps.getCodexBin(),
      },
      cwd,
      spawnEnv,
      logTag: `finalize ${runId} reviewer ${reviewer.id}`,
      codexDangerBypass: !!config.codexDangerBypass,
      codexProfile: config.codexProfile,
      timeoutMs,
      signal: args.signal,
      sessionId,
      activeProcesses: deps.activeProcesses,
      spawnFn,
      broadcast: deps.broadcast,
      reviewerName: reviewer.name,
      reviewerColor: reviewer.color,
      reviewerId: reviewer.id,
      assistantMsgId,
    });

    // Parse the tail before persisting so JSON-only reviewer replies do
    // not leak the machine payload into chat. Missing or malformed tails
    // still persist the original text below, then throw after broadcast.
    const parsed = detectReviewVerdictBlock(rawText);
    const visibleText = buildVisibleReviewerText(rawText, parsed.task);

    // Persist the assistant message into the session timeline. Use the
    // SAME id we used for the streaming events so subscribers can join
    // partial-text events to the final row without re-keying.
    try {
      deps.stmts.addMessage.run(
        assistantMsgId,
        sessionId,
        'assistant',
        visibleText,
        engine,
        model,
        null,
        null,
        reviewer.id,
        reviewer.name,
        reviewer.color ?? null,
      );
      deps.stmts.touchSession.run(sessionId);
    } catch (err) {
      log(
        `[in-session-reviewer] persist message failed for run=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    deps.broadcast({
      type: 'message',
      message: {
        id: assistantMsgId,
        session_id: sessionId,
        role: 'assistant',
        agent_id: reviewer.id,
        agent_name: reviewer.name,
        agent_color: reviewer.color,
        content: visibleText,
        engine,
        model,
        created_at: new Date(now()).toISOString(),
      },
    });
    deps.broadcast({
      type: 'done',
      sessionId,
      agentId: reviewer.id,
      agentName: reviewer.name,
    });

    // Missing or malformed tail produces a deliberate throw — the
    // reviewer-dispatch helper turns this into a `review_failed` outcome
    // so the orchestrator does not silently treat a blank reviewer
    // message as "approved".
    if (!parsed.present) {
      throw new Error(
        `reviewer turn ended without a parseable review verdict (run=${runId}) — expected a <agenthub:review-verdict> block or trailing {"verdict":...} JSON`,
      );
    }
    if (!parsed.task) {
      throw new Error(
        `reviewer tail block was malformed (run=${runId}, reason=${parsed.reason ?? 'unknown'})`,
      );
    }

    return {
      verdict: parsed.task.verdict,
      threads: parsed.task.threads,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Pick the project's reviewer-role agent id. Returns the first agent
 * with `role: 'reviewer'`; the autonomy + spawn-cleanup paths already
 * assume single-reviewer-per-project so we match that convention.
 *
 * Exported for tests.
 */
export function pickReviewerAgentId(project: Project): string | null {
  const list = Array.isArray(project.agents) ? project.agents : [];
  for (const a of list) {
    if (a && a.role === 'reviewer' && typeof a.id === 'string' && a.id) {
      return a.id;
    }
  }
  return null;
}

function buildVisibleReviewerText(
  rawText: string,
  parsedTask: ReturnType<typeof detectReviewVerdictBlock>['task'],
): string {
  const stripped = stripReviewVerdictBlock(rawText).trim();
  if (stripped) return stripped;
  if (parsedTask) {
    const findingWord = parsedTask.threads.length === 1 ? 'finding' : 'findings';
    return `Review verdict: ${parsedTask.verdict} (${parsedTask.threads.length} ${findingWord}).`;
  }
  return rawText;
}

/**
 * Compose the reviewer's system prompt: the enriched workspace prompt
 * plus a Finalize-specific reinforcement that this is a read-only turn
 * AND no GitHub PR exists yet.
 *
 * Pure (no I/O), exported for tests.
 */
export function composeReviewerSystemPrompt(
  enrichedPrompt: string,
  project: Project,
  card: KanbanCardRow,
): string {
  const cardLabel = card.title ? `"${card.title}"` : `\`${card.id}\``;
  const projectLabel = project.name ?? project.id ?? 'this project';
  return `${enrichedPrompt}

## Finalize Code Changes — In-session Reviewer (read-only)

You are reviewing the **local diff** of a feature branch in **${projectLabel}** for card ${cardLabel}.

**Constraints:**
- Do NOT edit files, run mutating shell commands, commit, or push.
- Do NOT call \`gh\`, the GitHub API, or any HTTP endpoint to fetch PR data — **no PR exists yet**. The diff in the user prompt is the complete input.
- Write your review as a normal chat message — prose first, then a SINGLE structured tail block.

**Output contract — end your turn with this block (and nothing after it):**

\`\`\`
<agenthub:review-verdict>
{
  "verdict": "approved" | "changes_requested",
  "threads": [
    {"file_path": "server/foo.ts", "line_start": 42, "line_end": 45, "body": "**[6/10]** ..."}
  ]
}
</agenthub:review-verdict>
\`\`\`

\`threads\` may be empty when there is genuinely nothing worth flagging. Always include the block; the orchestrator parses it off the tail and persists verdict + threads to the side-panel and the push gate.`;
}

interface OneTurnArgs {
  engine: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  bins: {
    claude: string;
    cursor: string;
    gemini: string;
    codex: string;
  };
  cwd: string;
  spawnEnv: NodeJS.ProcessEnv;
  logTag: string;
  codexDangerBypass: boolean;
  codexProfile: string | null | undefined;
  timeoutMs: number;
  signal?: ReviewerCancelSignal;
  sessionId: string;
  activeProcesses?: Map<string, ChildProcess>;
  spawnFn: typeof spawn;
  broadcast: BroadcastFn;
  reviewerName: string;
  reviewerColor: string | null | undefined;
  reviewerId: string;
  assistantMsgId: string;
}

/**
 * Drive one CLI turn end-to-end and return the assembled assistant text.
 * Throws on cancellation, timeout, or stream-level errors. Cursor's
 * `create-chat` pre-spawn is handled lazily — production never exercises
 * it because the reviewer agent is configured to use claude-code in the
 * default project layout; tests can override the spawn factory entirely.
 */
async function runOneTurn(args: OneTurnArgs): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const planAndSpawn = async (): Promise<void> => {
      let cursorChatId: string | null = null;
      if (args.engine === 'cursor-agent') {
        try {
          cursorChatId = await createCursorChat(args.bins.cursor, args.cwd, args.spawnEnv);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }

      let plan;
      try {
        plan = buildSessionMultiSpawnArgs({
          engine: args.engine,
          model: args.model,
          systemPrompt: args.systemPrompt,
          userPrompt: args.userPrompt,
          cursorChatId,
          bins: args.bins,
          logTag: args.logTag,
          codexDangerBypass: args.codexDangerBypass,
          codexProfile: args.codexProfile,
          advisory: true,
          sessionId: args.sessionId,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const parser = createStreamParser(args.engine);
      let finalText = '';
      let partialFallback = '';
      let errorOutput = '';
      let streamErrorMessage = '';
      let spawnErrored = false;
      let cancelled = false;

      const stdinSetting: 'ignore' | 'pipe' = plan.stdinPrompt !== null ? 'pipe' : 'ignore';
      const proc = args.spawnFn(plan.bin, plan.args, {
        cwd: args.cwd,
        env: args.spawnEnv,
        stdio: [stdinSetting, 'pipe', 'pipe'],
        detached: true,
      }) as ChildProcess;

      if (args.activeProcesses) {
        // Key by sessionId so handleMultiAgentCancel can SIGTERM us.
        args.activeProcesses.set(args.sessionId, proc);
      }
      trackChild(proc);

      if (plan.stdinPrompt !== null && proc.stdin) {
        try {
          proc.stdin.end(plan.stdinPrompt, 'utf8');
        } catch {
          /* ignore */
        }
      }

      const timer = setTimeout(() => {
        killProcessGroup(proc, 'SIGTERM');
        reject(new Error(`reviewer turn timed out after ${args.timeoutMs}ms`));
      }, args.timeoutMs);

      const onAbort = (): void => {
        cancelled = true;
        try {
          killProcessGroup(proc, 'SIGTERM');
        } catch {
          /* ignore */
        }
      };
      let unsubscribeAbort: (() => void) | null = null;
      if (args.signal) {
        if (args.signal.aborted) {
          onAbort();
        } else {
          unsubscribeAbort = args.signal.onAbort(onAbort);
        }
      }

      proc.stdout!.on('data', (chunk: Buffer) => {
        for (const ev of parser.feed(chunk)) {
          if (ev.type === 'assistant_text') {
            const text = typeof ev.text === 'string' ? ev.text : JSON.stringify(ev.text ?? '');
            if (ev.replacesAssistantBuffer) {
              finalText = text;
              partialFallback = '';
            } else if (ev.partial) {
              partialFallback += text;
            } else {
              finalText += text;
            }
            args.broadcast({
              type: 'stream',
              sessionId: args.sessionId,
              agentId: args.reviewerId,
              agentName: args.reviewerName,
              agentColor: args.reviewerColor,
              messageId: args.assistantMsgId,
              content: finalText || partialFallback,
            });
          }
          if (ev.type === 'result' && ev.isError && ev.text) {
            if (!streamErrorMessage) streamErrorMessage = ev.text;
          }
        }
      });
      proc.stderr!.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (plan.systemPromptFileCleanup) {
          plan.systemPromptFileCleanup();
        }
        if (unsubscribeAbort) {
          try {
            unsubscribeAbort();
          } catch {
            /* best-effort */
          }
        }
        if (args.activeProcesses) args.activeProcesses.delete(args.sessionId);
        if (cancelled) {
          reject(new Error('cancelled'));
          return;
        }
        if (spawnErrored) return;
        for (const ev of parser.flush()) {
          if (ev.type === 'assistant_text') {
            const text = typeof ev.text === 'string' ? ev.text : JSON.stringify(ev.text ?? '');
            if (ev.replacesAssistantBuffer) {
              finalText = text;
              partialFallback = '';
            } else if (ev.partial) {
              partialFallback += text;
            } else {
              finalText += text;
            }
          }
        }
        const assembled = (finalText || partialFallback).trim();
        if (code !== 0 && !assembled) {
          reject(
            new Error(
              streamErrorMessage || errorOutput.trim() || `reviewer exited with code ${code}`,
            ),
          );
        } else {
          resolve(assembled);
        }
      });
      proc.on('error', (err: Error) => {
        spawnErrored = true;
        clearTimeout(timer);
        if (plan.systemPromptFileCleanup) {
          plan.systemPromptFileCleanup();
        }
        if (args.activeProcesses) args.activeProcesses.delete(args.sessionId);
        reject(err);
      });
    };

    planAndSpawn().catch((err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function createCursorChat(cursorBin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cursorBin, ['create-chat'], { cwd, env }, (err, stdout, stderr) => {
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
