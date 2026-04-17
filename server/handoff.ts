import type { ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type {
  Agent,
  EnrichedAgent,
  Project,
  Stmts,
  BroadcastFn,
  AppConfig,
  ChatMessage,
  HandoffRow,
  MessageRow,
} from './types.js';

// ─── Session handoff — `<handoff>` block protocol ────────────────────────────
//
// Sibling to `<delegate>`:
//   - `<delegate>` spawns one or more sub-agents in parallel as one-shot
//     processes. The lead agent keeps running and synthesizes the results.
//   - `<handoff>` transfers ownership of the session to another agent in the
//     same project. The source agent's turn ends, a *new session* is created
//     for the target agent, and the target's first turn is primed with the
//     source's transcript + a handoff note baked into the enriched system
//     prompt.
//
// Example block an agent would emit at the end of its turn:
//
//   <handoff>
//   {"toAgent": "hub-backend", "note": "I mapped the fix — file is .../github.ts:234. Plan is in card b95240. Please implement + PR."}
//   </handoff>
//
// The block is parsed from the final assistant message after the CLI process
// closes (same hook point as `<delegate>`), so there is no need to interact
// with the live stream parser.
//
// v1 scope:
//   - Single target agent (not an array).
//   - Target must live in the same project as the source agent.
//   - `<handoff>` is terminal in the turn — any text emitted after the closing
//     tag is logged and otherwise ignored.
//   - Transcript truncation uses a fixed tail-of-N-turns strategy. Tune
//     HANDOFF_TRANSCRIPT_MAX_TURNS below.

export const HANDOFF_TRANSCRIPT_MAX_TURNS = 50;

export interface HandoffTask {
  toAgent: string;
  note: string;
}

export interface HandoffResult {
  handoffId: string;
  toSessionId: string;
  toAgentId: string;
  toAgentName: string;
}

interface HandoffTranscriptMessage {
  role: string;
  content: string;
}

export interface BuildHandoffContextArgs {
  fromAgentName: string;
  note: string;
  messages: HandoffTranscriptMessage[];
  maxTurns?: number;
}

export interface HandoffDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  findAgent: (agentId: string) => { project: Project; agent: unknown } | null;
  getActiveProcesses: () => Map<string, ChildProcess | { kill: () => void }>;
  getClaudeBin: () => string;
  getDefaultModel: () => string;
  getConfig: () => AppConfig;
  /**
   * Accessor for the chat handler. A getter is used because `handleChat` is
   * assigned after `createChatHandler()` runs, and `initHandoff()` may be
   * called before that point. Returning `undefined` from the getter leaves
   * the target session primed but un-spawned (used in tests).
   */
  getHandleChat: () => ((ws: unknown, msg: ChatMessage) => Promise<void>) | undefined;
}

// Module-level state (populated by initHandoff). The handler in
// `handleHandoff` reads from this; the pure functions below do not.
let deps: HandoffDeps | null = null;

export const activeHandoffSessions = new Set<string>();

export function initHandoff(d: HandoffDeps): void {
  deps = d;
}

/**
 * Test-seam: expose the current deps so tests can swap in mocks. Production
 * code should never call this — use `initHandoff(...)`.
 */
export function _peekDepsForInternalUse(): HandoffDeps | null {
  return deps;
}

// ─── Fuzzy target resolution ─────────────────────────────────────────────
//
// Agents authoring <handoff> blocks often transcribe an id from their AGENTS.md
// context file rather than from the canonical `Hub Backend (`hub-backend`)`
// delegation list. That means we frequently see requests like
// `toAgent: "agent-hub-backend"` when the real id is `hub-backend`, which
// would previously fail with "Unknown target agent" and silently strand the
// session. Be tolerant: try exact id → prefix-stripped id → name match →
// suffix match, but only within the source project so we never resolve
// across project boundaries.
//
// Exported for tests.
export function resolveTargetAgentId(
  requested: string,
  projectAgents: readonly Agent[],
): string | null {
  if (!requested || !Array.isArray(projectAgents) || projectAgents.length === 0) {
    return null;
  }
  const want = requested.trim();
  if (!want) return null;

  // 1. Exact id match.
  const exact = projectAgents.find((a) => a.id === want);
  if (exact) return exact.id;

  const wantLower = want.toLowerCase();

  // 2. Case-insensitive id match.
  const ci = projectAgents.find((a) => a.id.toLowerCase() === wantLower);
  if (ci) return ci.id;

  // 3. Case-insensitive name match (e.g. "Hub Backend", "hub backend").
  const byName = projectAgents.find((a) => (a.name || '').toLowerCase() === wantLower);
  if (byName) return byName.id;

  // 4. Name-with-spaces → id-with-dashes (e.g. "hub-backend" ↔ "Hub Backend").
  const wantAsName = wantLower.replace(/[-_]+/g, ' ').trim();
  const byNormalizedName = projectAgents.find(
    (a) => (a.name || '').toLowerCase().replace(/\s+/g, ' ').trim() === wantAsName,
  );
  if (byNormalizedName) return byNormalizedName.id;

  // 5. Progressively drop leading hyphen-delimited tokens from the
  // requested id, looking for an exact or suffix match. This handles the
  // common AGENTS.md style where prose prefixes the project slug:
  // "agent-hub-backend" → try "agent-hub-backend", then "hub-backend",
  // then "backend". Also try after stripping a leading "agent-".
  const tokens = wantLower.split('-');
  const candidates = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const c = tokens.slice(i).join('-');
    if (c) candidates.add(c);
  }
  if (wantLower.startsWith('agent-')) {
    const stripped = wantLower.replace(/^agent-/, '');
    const strippedTokens = stripped.split('-');
    for (let i = 0; i < strippedTokens.length; i += 1) {
      const c = strippedTokens.slice(i).join('-');
      if (c) candidates.add(c);
    }
  }
  candidates.delete(wantLower); // already tried above

  for (const candidate of candidates) {
    const exactMatch = projectAgents.find((a) => a.id.toLowerCase() === candidate);
    if (exactMatch) return exactMatch.id;
  }
  for (const candidate of candidates) {
    const suffixMatches = projectAgents.filter(
      (a) => a.id.toLowerCase() === candidate || a.id.toLowerCase().endsWith(`-${candidate}`),
    );
    if (suffixMatches.length === 1) return suffixMatches[0].id;
  }

  // 6. Suffix match on the original input — last ditch. Only accept a
  // unique match to avoid grabbing the wrong agent when several share the
  // suffix (e.g. "-dev").
  const suffixMatches = projectAgents.filter((a) => {
    const id = a.id.toLowerCase();
    return id === wantLower || id.endsWith(`-${wantLower}`);
  });
  if (suffixMatches.length === 1) return suffixMatches[0].id;

  return null;
}

// ─── Parser ──────────────────────────────────────────────────────────────

/**
 * Extract a `<handoff>...</handoff>` block from `text` and return the parsed
 * task. Returns `null` if no block is found, the JSON is malformed, or the
 * required fields (`toAgent`, `note`) are missing or empty.
 *
 * Only the first block in `text` is considered — handoff is singular by
 * design (unlike `<delegate>` which can be an array).
 *
 * Exported for tests.
 */
export function parseHandoffBlock(text: string): HandoffTask | null {
  const match = text.match(/<handoff>\s*([\s\S]*?)\s*<\/handoff>/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const toAgent = typeof obj.toAgent === 'string' ? obj.toAgent.trim() : '';
    const note = typeof obj.note === 'string' ? obj.note.trim() : '';
    if (!toAgent || !note) return null;
    return { toAgent, note };
  } catch {
    console.error('[Handoff] Failed to parse handoff block JSON');
    return null;
  }
}

/**
 * True when `text` contains trailing content after the closing `</handoff>`
 * tag that is not just whitespace. Used to log a warning when an agent emits
 * closing remarks after a handoff — those remarks are dropped because
 * handoff is terminal in the turn.
 *
 * Exported for tests.
 */
export function handoffHasTrailingContent(text: string): boolean {
  const match = text.match(/<\/handoff>([\s\S]*)$/);
  if (!match) return false;
  return match[1].trim().length > 0;
}

// ─── Prompt builder ──────────────────────────────────────────────────────

/**
 * Render the HANDOFF FROM section that gets appended to the target agent's
 * enriched system prompt on its very first turn. Pure function — no DB
 * access, no side effects, easy to unit-test.
 *
 * Transcript is truncated to the last `maxTurns` messages (default
 * HANDOFF_TRANSCRIPT_MAX_TURNS). Tail preserves the most recent and typically
 * most relevant context.
 */
export function buildHandoffContextBlock(args: BuildHandoffContextArgs): string {
  const maxTurns = args.maxTurns ?? HANDOFF_TRANSCRIPT_MAX_TURNS;
  const total = args.messages.length;
  const recent = total > maxTurns ? args.messages.slice(-maxTurns) : args.messages;

  const quotedNote = args.note
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  const transcriptBody =
    recent.length === 0
      ? '_(no prior messages)_'
      : recent.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');

  const truncNote =
    total > maxTurns
      ? `### Previous session transcript (last ${recent.length} of ${total} turns)`
      : `### Previous session transcript (${recent.length} turns)`;

  return `## HANDOFF FROM ${args.fromAgentName}

You are continuing work started by ${args.fromAgentName}. They handed the session to you with this note:

${quotedNote}

${truncNote}

${transcriptBody}

### Your task

Pick up where they left off. The transcript above is their context, not yours — don't re-do their work. If you need clarification beyond what's here, ask the user (they know about the handoff).`;
}

// ─── Prompt integration helper ──────────────────────────────────────────

/**
 * Look up an incoming (delivered) handoff for the given target session and
 * render the HANDOFF FROM block if one exists. Returns the empty string when
 * the session has no incoming handoff, so callers can safely concatenate.
 *
 * Pulls the source transcript via `stmts.getMessages`, resolves the source
 * agent's display name via the supplied lookup, and delegates the rendering
 * to `buildHandoffContextBlock`.
 */
export function buildHandoffPromptSection(
  toSessionId: string,
  args: {
    stmts: Stmts;
    getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  },
): string {
  let row: HandoffRow | undefined;
  try {
    row = args.stmts.getHandoffByToSession.get(toSessionId, 'delivered') as HandoffRow | undefined;
  } catch {
    return '';
  }
  if (!row) return '';

  let sourceMessages: Array<{ role: string; content: string }> = [];
  try {
    const rows = args.stmts.getMessages.all(row.from_session_id) as MessageRow[];
    sourceMessages = rows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content ?? '' }));
  } catch {
    sourceMessages = [];
  }

  const fromAgent = args.getEnrichedAgent(row.from_agent_id);
  const fromName = fromAgent?.name ?? row.from_agent_id;

  return buildHandoffContextBlock({
    fromAgentName: fromName,
    note: row.note,
    messages: sourceMessages,
  });
}

// ─── Handler ─────────────────────────────────────────────────────────────

/**
 * Fire a handoff from `srcSessionId` to the target agent in `task`.
 *
 * Side effects (in order):
 *   1. Insert a pending row in `handoffs`.
 *   2. Validate the target agent exists and lives in the same project as the
 *      source. On failure mark the handoff `failed` and return null.
 *   3. Create a new session row for the target.
 *   4. Link the handoff row to the new session via `to_session_id` and flip
 *      the status to `delivered` so the target's enriched-prompt build picks
 *      up the HANDOFF FROM section.
 *   5. Fire-and-forget invoke `handleChat` so the target's first turn runs
 *      with the handoff note as the seeding user message.
 *
 * Returns a `HandoffResult` describing the new session, or null if the
 * handoff could not be delivered. All failures are persisted on the
 * handoffs row and broadcast as `handoff_error` events.
 */
export async function handleHandoff(
  srcSessionId: string,
  parentMessageId: string,
  task: HandoffTask,
  sourceAgent: EnrichedAgent,
  sourceProject: Project,
): Promise<HandoffResult | null> {
  if (!deps) throw new Error('[Handoff] initHandoff() was not called');
  const { stmts, broadcast, getEnrichedAgent, findAgent, getHandleChat } = deps;
  const handleChat = getHandleChat();

  const handoffId = uuidv4();
  const projectId =
    (sourceProject as Project & { id?: string }).id ||
    (sourceAgent as EnrichedAgent & { projectId?: string }).projectId ||
    '';

  // Resolve the requested target id against the source project. This
  // forgives the common AGENTS.md/system-prompt mismatch where the lead
  // author writes e.g. `agent-hub-backend` but the canonical id is
  // `hub-backend` — previously those handoffs would fail silently and
  // strand the session.
  const projectAgents: readonly Agent[] = Array.isArray(
    (sourceProject as Project & { agents?: Agent[] }).agents,
  )
    ? ((sourceProject as Project & { agents?: Agent[] }).agents as readonly Agent[])
    : [];
  const resolvedTargetId = resolveTargetAgentId(task.toAgent, projectAgents) ?? task.toAgent;
  if (resolvedTargetId !== task.toAgent) {
    console.log(
      `[Handoff] Fuzzy-resolved target "${task.toAgent}" → "${resolvedTargetId}" in project ${projectId}`,
    );
  }

  // Step 1: create pending row so failures are still observable. Persist
  // the *resolved* id so downstream UI / prompt builders see the real
  // target.
  try {
    stmts.createHandoff.run(
      handoffId,
      srcSessionId,
      sourceAgent.id,
      resolvedTargetId,
      projectId,
      task.note,
    );
  } catch (err) {
    console.error('[Handoff] DB insert failed:', (err as Error).message);
    broadcast({
      type: 'handoff_error',
      sessionId: srcSessionId,
      error: 'Failed to record handoff',
    });
    return null;
  }

  // Step 2: validate target.
  const targetAgent = getEnrichedAgent(resolvedTargetId);
  if (!targetAgent) {
    const reason =
      resolvedTargetId === task.toAgent
        ? `Unknown target agent: ${task.toAgent}`
        : `Unknown target agent: ${task.toAgent} (resolved to "${resolvedTargetId}" which does not exist)`;
    try {
      stmts.markHandoffFailed.run(reason, handoffId);
    } catch {}
    broadcast({ type: 'handoff_error', sessionId: srcSessionId, handoffId, error: reason });
    return null;
  }

  const targetLookup = findAgent(resolvedTargetId);
  const targetProjectId =
    (targetLookup?.project as (Project & { id?: string }) | undefined)?.id ?? '';
  if (projectId && targetProjectId && projectId !== targetProjectId) {
    const reason = `Target agent ${resolvedTargetId} is not in the same project as ${sourceAgent.id}`;
    try {
      stmts.markHandoffFailed.run(reason, handoffId);
    } catch {}
    broadcast({ type: 'handoff_error', sessionId: srcSessionId, handoffId, error: reason });
    return null;
  }

  // Step 3 + 4: create target session, link handoff, mark delivered.
  const toSessionId = uuidv4();
  try {
    const engine = targetAgent.engine || 'claude-code';
    const model =
      (targetAgent as EnrichedAgent & { model?: string }).model || defaultModelForEngine(engine);
    stmts.createSession.run(
      toSessionId,
      targetAgent.id,
      `Handoff from ${sourceAgent.name} — ${new Date().toLocaleString()}`,
      engine,
      model,
      1, // use_worktree — default to isolated
      0, // ask_mode — default off
    );
    stmts.setHandoffToSession.run(toSessionId, handoffId);
    // Mark delivered BEFORE triggering the first chat turn so that the
    // target's enriched-prompt builder can find the handoff row via
    // `getHandoffByToSession` (which filters on status='delivered').
    stmts.markHandoffDelivered.run(handoffId);
  } catch (err) {
    const reason = `Failed to create target session: ${(err as Error).message}`;
    console.error('[Handoff]', reason);
    try {
      stmts.markHandoffFailed.run(reason, handoffId);
    } catch {}
    broadcast({ type: 'handoff_error', sessionId: srcSessionId, handoffId, error: reason });
    return null;
  }

  activeHandoffSessions.add(toSessionId);

  broadcast({
    type: 'handoff_start',
    sessionId: srcSessionId,
    handoffId,
    parentMessageId,
    fromAgentId: sourceAgent.id,
    fromAgentName: sourceAgent.name,
    toAgentId: targetAgent.id,
    toAgentName: targetAgent.name,
    toSessionId,
  });

  // Step 5: trigger first turn. Fire-and-forget — we don't await the chat
  // completion here because the source session is winding down and the
  // target lives as its own independent session from this point forward.
  if (handleChat) {
    Promise.resolve()
      .then(() =>
        handleChat(null, {
          agentId: targetAgent.id,
          sessionId: toSessionId,
          content: task.note,
        } as ChatMessage),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Handoff] Target chat spawn failed:', message);
      })
      .finally(() => {
        activeHandoffSessions.delete(toSessionId);
      });
  } else {
    // No handleChat dep wired — leave the session primed for manual pickup.
    // This branch exists for tests; in production handleChat is always set.
    activeHandoffSessions.delete(toSessionId);
  }

  return {
    handoffId,
    toSessionId,
    toAgentId: targetAgent.id,
    toAgentName: targetAgent.name,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

function defaultModelForEngine(engine: string): string {
  // Mirror server/config.ts defaults without importing it (keeps handoff.ts
  // independently testable). The real config defaults apply when handleChat
  // runs for the target session.
  if (engine === 'cursor-agent') return 'gpt-4';
  return 'claude-opus-4-7';
}
