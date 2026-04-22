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
  KanbanCardRow,
  KanbanEpicRow,
  MessageRow,
  SessionRow,
} from './types.js';
import { buildPrTitle } from './auto-git.js';

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
//   - Transcript truncation uses a layered cap strategy driven by three
//     constants (tail-of-N-turns, then per-message middle-truncation, then
//     total-body head-drop). Tune these below.

// Max number of tail turns to include in the transcript. Lower values cut
// per-turn cost dramatically on handoff-chained sessions; 10 was chosen after
// an April 2026 cost audit showed handoff prepend was responsible for
// ~$0.50-1.00 of the post-revamp per-turn cost delta.
export const HANDOFF_TRANSCRIPT_MAX_TURNS = 10;

// Per-message character cap. Oversize messages are middle-truncated so both
// the opening framing and the closing conclusions survive — assistant outputs
// typically carry signal at both ends but filler in the middle.
export const HANDOFF_TRANSCRIPT_MAX_CHARS_PER_MESSAGE = 2000;

// Total body character budget. After per-message truncation, if the joined
// transcript still exceeds this, whole turns are dropped from the head
// (oldest first) until the body fits, and the "last X of Y turns" label is
// updated to reflect the reduced count.
export const HANDOFF_TRANSCRIPT_MAX_TOTAL_CHARS = 20000;

export interface HandoffTask {
  toAgent: string;
  note: string;
}

export interface HandoffResult {
  handoffId: string;
  toSessionId: string;
  toAgentId: string;
  toAgentName: string;
  /**
   * When the source session owned a kanban card, its id after the card's
   * `session_id` pointer was re-pointed at the target session. `null` when
   * the source session had no linked card (ad-hoc chat) or forwarding failed.
   */
  forwardedCardId: string | null;
  /**
   * True when the forwarded card belongs to an epic whose `autonomous` flag
   * is set. Surfaced so the UI + downstream dispatch know the target session
   * is continuing autonomous work rather than starting fresh interactive work.
   */
  autonomousForwarded: boolean;
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
  maxCharsPerMessage?: number;
  maxTotalChars?: number;
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
 * Reason codes describing *why* a `<handoff>` block could not be parsed into a
 * usable task. Surfaced on `handoff_error` broadcasts + persisted on failed
 * rows so the UI can explain to the user why the block was dropped.
 */
export type HandoffMalformedReason =
  | 'invalid-json'
  | 'not-object'
  | 'array-payload'
  | 'missing-toagent'
  | 'missing-note'
  | 'empty-toagent'
  | 'empty-note';

export interface HandoffDetectionResult {
  /** True iff the raw text contains a `<handoff>...</handoff>` tag pair. */
  present: boolean;
  /** Parsed task, or null when the block is absent or malformed. */
  task: HandoffTask | null;
  /** When `present && !task`, explains the specific failure mode. */
  reason: HandoffMalformedReason | null;
  /** The untrimmed body between the tags (for error reporting / placeholder notes). */
  rawBody: string | null;
}

/**
 * Detect a `<handoff>` block and parse it. Unlike `parseHandoffBlock`, this
 * returns a tagged result that distinguishes "no block present" from "block
 * present but malformed", so callers can emit a `handoff_error` + render a
 * failed-state widget instead of silently dropping the handoff.
 *
 * Exported for tests and for use by `chat.ts` to surface malformed handoffs.
 */
export function detectHandoffBlock(text: string): HandoffDetectionResult {
  if (typeof text !== 'string') {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const match = text.match(/<handoff>\s*([\s\S]*?)\s*<\/handoff>/);
  if (!match) return { present: false, task: null, reason: null, rawBody: null };

  const rawBody = match[1] ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { present: true, task: null, reason: 'invalid-json', rawBody };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { present: true, task: null, reason: 'not-object', rawBody };
  }
  if (Array.isArray(parsed)) {
    return { present: true, task: null, reason: 'array-payload', rawBody };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.toAgent !== 'string') {
    return { present: true, task: null, reason: 'missing-toagent', rawBody };
  }
  if (typeof obj.note !== 'string') {
    return { present: true, task: null, reason: 'missing-note', rawBody };
  }
  const toAgent = obj.toAgent.trim();
  const note = obj.note.trim();
  if (!toAgent) return { present: true, task: null, reason: 'empty-toagent', rawBody };
  if (!note) return { present: true, task: null, reason: 'empty-note', rawBody };
  return { present: true, task: { toAgent, note }, reason: null, rawBody };
}

/**
 * Human-readable label for a detection reason — surfaced in `handoff_error`
 * broadcasts and persisted on the DB row's `error` column.
 */
export function describeHandoffReason(reason: HandoffMalformedReason): string {
  switch (reason) {
    case 'invalid-json':
      return 'Handoff block contains invalid JSON';
    case 'not-object':
      return 'Handoff block payload is not a JSON object';
    case 'array-payload':
      return 'Handoff block payload is an array (handoff is single-target)';
    case 'missing-toagent':
      return 'Handoff block is missing the "toAgent" field';
    case 'missing-note':
      return 'Handoff block is missing the "note" field';
    case 'empty-toagent':
      return 'Handoff block has an empty "toAgent" field';
    case 'empty-note':
      return 'Handoff block has an empty "note" field';
    default:
      return 'Handoff block could not be parsed';
  }
}

/**
 * Extract a `<handoff>...</handoff>` block from `text` and return the parsed
 * task. Returns `null` if no block is found, the JSON is malformed, or the
 * required fields (`toAgent`, `note`) are missing or empty.
 *
 * Only the first block in `text` is considered — handoff is singular by
 * design (unlike `<delegate>` which can be an array).
 *
 * Exported for tests. For code paths that need to distinguish "no block"
 * from "malformed block", prefer `detectHandoffBlock`.
 */
export function parseHandoffBlock(text: string): HandoffTask | null {
  return detectHandoffBlock(text).task;
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

// ─── Session title derivation ────────────────────────────────────────────

/**
 * Derive a human-readable session title (and therefore PR title, when the
 * handoff-sourced session later opens a PR with no kanban card attached) from
 * the handoff `note`.
 *
 * Rules:
 *   - Use the first non-empty line of `note`. Multi-line notes are common
 *     (our emitters often include rationale after the headline sentence),
 *     but PR titles must be one line.
 *   - Normalize through `buildPrTitle` to collapse whitespace, strip trailing
 *     punctuation, sentence-case, and hard-cap at ~70 chars with ellipsis on
 *     word boundaries.
 *   - When `note` is empty or whitespace-only, fall back to
 *     `Handoff from <fromAgentName>` (with no timestamp — timestamps were the
 *     original bug and are not useful once `handoffs.from_agent_id` preserves
 *     the provenance independently).
 *
 * Exported for tests.
 */
export function deriveHandoffSessionTitle(note: string, fromAgentName: string): string {
  const firstLine =
    typeof note === 'string'
      ? (note.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '').trim()
      : '';
  if (!firstLine) {
    const name = (fromAgentName ?? '').trim() || 'agent';
    return `Handoff from ${name}`;
  }
  return buildPrTitle(firstLine);
}

// ─── Prompt builder ──────────────────────────────────────────────────────

/**
 * Middle-truncate a single message whose content exceeds `maxChars`. Keeps
 * roughly half the budget from the head and half from the tail, with an
 * `_…(truncated N chars)…_` marker between them. Head + tail are biased so
 * that an odd budget goes to the head.
 *
 * Exported for tests.
 */
export function truncateHandoffMessageContent(content: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return content;
  if (typeof content !== 'string' || content.length <= maxChars) return content;
  const headLen = Math.ceil(maxChars / 2);
  const tailLen = Math.floor(maxChars / 2);
  const head = content.slice(0, headLen);
  const tail = content.slice(content.length - tailLen);
  const removed = content.length - (headLen + tailLen);
  return `${head}\n\n_…(truncated ${removed} chars)…_\n\n${tail}`;
}

/**
 * Render the HANDOFF FROM section that gets appended to the target agent's
 * enriched system prompt on its very first turn. Pure function — no DB
 * access, no side effects, easy to unit-test.
 *
 * Truncation is layered so we always bound cost without losing framing:
 *   1. Tail-of-N turns (`maxTurns`, default HANDOFF_TRANSCRIPT_MAX_TURNS).
 *   2. Per-message middle-truncation (`maxCharsPerMessage`, default
 *      HANDOFF_TRANSCRIPT_MAX_CHARS_PER_MESSAGE) — preserves ~half head +
 *      half tail of oversize messages with a `_…(truncated N chars)…_` marker.
 *   3. Total-body budget (`maxTotalChars`, default
 *      HANDOFF_TRANSCRIPT_MAX_TOTAL_CHARS) — drops whole turns from the head
 *      (oldest first) until the joined body fits; the truncation label
 *      reflects the surviving count.
 */
export function buildHandoffContextBlock(args: BuildHandoffContextArgs): string {
  const maxTurns = args.maxTurns ?? HANDOFF_TRANSCRIPT_MAX_TURNS;
  const maxCharsPerMessage = args.maxCharsPerMessage ?? HANDOFF_TRANSCRIPT_MAX_CHARS_PER_MESSAGE;
  const maxTotalChars = args.maxTotalChars ?? HANDOFF_TRANSCRIPT_MAX_TOTAL_CHARS;

  const total = args.messages.length;
  const afterTurnCap = total > maxTurns ? args.messages.slice(-maxTurns) : args.messages.slice();

  // Step 2: per-message middle-truncation.
  const afterPerMessageCap = afterTurnCap.map((m) => ({
    role: m.role,
    content:
      Number.isFinite(maxCharsPerMessage) && maxCharsPerMessage > 0
        ? truncateHandoffMessageContent(m.content ?? '', maxCharsPerMessage)
        : (m.content ?? ''),
  }));

  // Step 3: total-budget head-drop. Join with the same separator used in the
  // final render so the character accounting matches the emitted body.
  const SEP = '\n\n';
  const format = (m: HandoffTranscriptMessage): string => `[${m.role}]: ${m.content}`;
  let kept = afterPerMessageCap.slice();
  if (Number.isFinite(maxTotalChars) && maxTotalChars > 0) {
    const joinLen = (arr: HandoffTranscriptMessage[]): number => {
      if (arr.length === 0) return 0;
      let n = 0;
      for (let i = 0; i < arr.length; i += 1) {
        n += format(arr[i]).length;
      }
      n += SEP.length * (arr.length - 1);
      return n;
    };
    while (kept.length > 0 && joinLen(kept) > maxTotalChars) {
      kept.shift();
    }
  }

  const recent = kept;
  const keptCount = recent.length;
  const truncated = keptCount < total;

  const quotedNote = args.note
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  const transcriptBody = keptCount === 0 ? '_(no prior messages)_' : recent.map(format).join(SEP);

  const truncNote = truncated
    ? `### Previous session transcript (last ${keptCount} of ${total} turns)`
    : `### Previous session transcript (${keptCount} turns)`;

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

// ─── Malformed handoff recorder ──────────────────────────────────────────

export interface RecordMalformedHandoffArgs {
  stmts: Stmts;
  broadcast: BroadcastFn;
  sessionId: string;
  fromAgentId: string;
  fromAgentName?: string;
  projectId: string;
  detection: HandoffDetectionResult;
}

/**
 * Persist a failed `handoffs` row + broadcast a `handoff_error` event for a
 * `<handoff>` block that was present but unparseable. Previously these
 * blocks were silently dropped (no DB row, no broadcast), leaving the UI
 * with no way to surface the failure — this is the root cause of the
 * "handoffs intermittent — widget missing when they fail" bug.
 *
 * Returns the generated handoffId + the user-facing reason for the caller
 * to log. All DB failures are caught and reported to the console so they
 * never block the end-of-turn flow.
 */
export function recordMalformedHandoff(args: RecordMalformedHandoffArgs): {
  handoffId: string;
  reason: string;
} {
  const handoffId = uuidv4();
  const detection = args.detection;
  const rawBody = (detection.rawBody ?? '').trim();
  const placeholderNote =
    rawBody.length > 0
      ? rawBody.slice(0, 500)
      : `(malformed handoff block: ${detection.reason ?? 'unknown'})`;
  const reason = detection.reason
    ? describeHandoffReason(detection.reason)
    : 'Handoff block could not be parsed';

  try {
    args.stmts.createHandoff.run(
      handoffId,
      args.sessionId,
      args.fromAgentId,
      '(unknown)',
      args.projectId,
      placeholderNote,
    );
    args.stmts.markHandoffFailed.run(reason, handoffId);
  } catch (dbErr) {
    console.error('[Handoff] Failed to record malformed handoff row:', (dbErr as Error).message);
  }

  args.broadcast({
    type: 'handoff_error',
    sessionId: args.sessionId,
    handoffId,
    error: reason,
    reason: detection.reason ?? null,
    fromAgentId: args.fromAgentId,
    fromAgentName: args.fromAgentName ?? args.fromAgentId,
  });

  return { handoffId, reason };
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
    // Derive a readable session title from the handoff note so that — when
    // this session later opens a PR without a linked kanban card — the PR
    // title reflects the task instead of a timestamp. Source-agent provenance
    // is preserved on the `handoffs.from_agent_id` row, so we don't need to
    // bake it into the title.
    stmts.createSession.run(
      toSessionId,
      targetAgent.id,
      deriveHandoffSessionTitle(task.note, sourceAgent.name),
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

  {
    const row = stmts.getSession.get(toSessionId) as SessionRow | undefined;
    if (row) {
      broadcast({ type: 'session_created', agentId: targetAgent.id, session: row });
    }
  }

  // Forward board/epic/autonomous context: if the source session owns a kanban
  // card, re-point the card to the new target session and update the assignee
  // to the specialist taking over. Without this the card is orphaned — the
  // sidebar loses its title binding, `<agenthub:close-card>` fails (it looks
  // up the card by the target's session_id), auto-PR creation can't find the
  // card, and the autonomous dispatcher's `activeProcesses.has(card.session_id)`
  // guard sees the dead source session and may re-dispatch the same card to
  // another agent while the handoff target is still working on it.
  //
  // Failures here are logged and swallowed: handoff delivery has already
  // succeeded at this point and the target session is viable even if the
  // card pointer can't be forwarded (e.g. the card stmt is missing in a
  // partially-mocked test environment).
  let forwardedCard: KanbanCardRow | null = null;
  let forwardedEpic: KanbanEpicRow | null = null;
  try {
    const card = stmts.getKanbanCardBySession?.get(srcSessionId) as KanbanCardRow | undefined;
    if (card) {
      stmts.reassignCardToSession.run(toSessionId, targetAgent.name, card.id);
      forwardedCard = { ...card, session_id: toSessionId, assignee: targetAgent.name };
      if (card.epic_id) {
        try {
          forwardedEpic =
            (stmts.getKanbanEpic?.get(card.epic_id) as KanbanEpicRow | undefined) ?? null;
        } catch {
          forwardedEpic = null;
        }
      }
      broadcast({
        type: 'kanban_update',
        projectId,
        reason: 'handoff_forward',
        cardId: card.id,
        fromSessionId: srcSessionId,
        toSessionId,
      });
    }
  } catch (err) {
    console.error(
      '[Handoff] Failed to forward kanban card to target session:',
      (err as Error).message,
    );
  }

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
    cardId: forwardedCard?.id ?? null,
    cardTitle: forwardedCard?.title ?? null,
    epicId: forwardedEpic?.id ?? null,
    epicAutonomous: forwardedEpic?.autonomous === 1,
  });

  // Step 5: trigger first turn. Fire-and-forget — we don't await the chat
  // completion here because the source session is winding down and the
  // target lives as its own independent session from this point forward.
  //
  // When a card was forwarded, prepend a short context block so the target
  // knows which kanban card it now owns (the card's `session_id` now points
  // at this session, so `<agenthub:close-card>` / auto-PR creation will work)
  // and whether this is autonomous-mode work.
  const seedingContent = buildHandoffSeedingContent(task.note, forwardedCard, forwardedEpic);
  if (handleChat) {
    Promise.resolve()
      .then(() =>
        handleChat(null, {
          agentId: targetAgent.id,
          sessionId: toSessionId,
          content: seedingContent,
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
    forwardedCardId: forwardedCard?.id ?? null,
    autonomousForwarded: forwardedEpic?.autonomous === 1,
  };
}

// ─── Seeding content for target's first turn ────────────────────────────

/**
 * Build the seeding user message injected into the target session's first
 * turn. When the handoff forwarded a kanban card (and optionally its epic),
 * prepend a `## Forwarded Context` block so the specialist knows:
 *   - which card they now own (card.session_id was re-pointed to them);
 *   - that `<agenthub:close-card>` will resolve against that card;
 *   - whether the card is part of an autonomous-mode epic (which affects
 *     their PR workflow — autonomous cards push + open a PR, they don't
 *     pause for review).
 *
 * When no card was forwarded this is just `task.note` — identical to the
 * pre-forwarding behavior so ad-hoc handoffs see no change.
 *
 * Exported for tests.
 */
export function buildHandoffSeedingContent(
  note: string,
  card: KanbanCardRow | null,
  epic: KanbanEpicRow | null,
): string {
  if (!card) return note;
  const lines: string[] = ['## Forwarded Context'];
  lines.push(
    `- **Kanban card:** \`${card.id}\` — "${card.title}" (session link was transferred to you; the sidebar stays named after this card)`,
  );
  if (epic) {
    const mode = epic.autonomous === 1 ? 'autonomous' : 'manual';
    lines.push(`- **Epic:** "${epic.name}" (${mode} mode)`);
    if (epic.autonomous === 1) {
      lines.push(
        `- **Autonomous mode is active for this card.** When you finish, commit + push — a PR will be opened automatically. Do NOT pause for human review.`,
      );
    }
  }
  lines.push(
    `- \`<agenthub:close-card>\` and auto-PR linkage now resolve against **this** session.`,
  );
  return `${lines.join('\n')}\n\n---\n\n${note}`;
}

// ─── Internal helpers ────────────────────────────────────────────────────

function defaultModelForEngine(engine: string): string {
  // Mirror server/config.ts defaults without importing it (keeps handoff.ts
  // independently testable). The real config defaults apply when handleChat
  // runs for the target session.
  if (engine === 'cursor-agent') return 'gpt-4';
  if (engine === 'gemini-cli') return 'gemini-2.5-pro';
  if (engine === 'codex-cli') return 'gpt-5.2-codex';
  return 'claude-opus-4-7';
}
