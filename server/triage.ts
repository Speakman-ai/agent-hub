import { v4 as uuidv4 } from 'uuid';
import type { Stmts, BroadcastFn, KanbanCardRow, Project, Agent } from './types.js';

// ─── Triage routing — `<agenthub:triage>` block protocol ─────────────────────
//
// Autonomous mode runs every eligible card through the project's intake agent
// (or the lead, if no intake exists) BEFORE a specialist picks it up. The
// intake agent reads the card, optionally rewrites the description and
// acceptance criteria, picks a `suggested_assignee` from the project's
// specialist roster, and emits a structured block at the end of its turn:
//
//   <agenthub:triage>
//   {
//     "assignee": "hub-frontend",
//     "refinedDescription": "...",
//     "acceptanceCriteria": ["AC1", "AC2"],
//     "labels": ["frontend", "ui"]
//   }
//   </agenthub:triage>
//
// The server parses this from the final assistant message after the CLI
// process closes (same hook point as `<delegate>`, `<handoff>`, and
// `<agenthub:close-card>`), looks up the card linked to the current session
// via `kanban_cards.session_id`, and applies the result atomically:
//   - description = refinedDescription || existing description (+ AC section)
//   - labels      = union(existing labels, new labels) — dedup, comma-sep
//   - suggested_assignee = assignee  (dispatch hint for runAutonomousLoop)
//   - triaged_at  = NOW (epoch ms) — flips the dispatch gate
//   - triaged_by  = the intake agent's id
//
// The dispatch gate: until `triaged_at` is set, runAutonomousLoop SKIPS the
// card. Once set, the loop honors `suggested_assignee` when picking the
// specialist, and falls back to round-robin only when the suggested agent is
// missing/invalid.
//
// Required fields:
//   - `assignee` (required): non-empty string; validated against the project's
//     specialist agents at apply time (parser is pure and stays roster-blind)
//
// Optional fields:
//   - `refinedDescription` (string)
//   - `acceptanceCriteria` (string[])
//   - `labels` (string[])

export interface TriageTask {
  assignee: string;
  refinedDescription?: string;
  acceptanceCriteria?: string[];
  labels?: string[];
}

export type TriageMalformedReason =
  | 'invalid-json'
  | 'not-object'
  | 'missing-assignee'
  | 'empty-assignee'
  | 'invalid-assignee-type'
  | 'invalid-description-type'
  | 'invalid-acceptance-criteria-type'
  | 'invalid-labels-type';

export interface TriageDetectionResult {
  present: boolean;
  task: TriageTask | null;
  reason: TriageMalformedReason | null;
  rawBody: string | null;
}

export type TriageApplyFailureReason =
  | 'card_lookup_failed'
  | 'no_linked_card'
  | 'unknown_assignee'
  | 'update_failed';

export interface TriageApplyResult {
  cardId: string;
  previousDescription: string | null;
  newDescription: string | null;
  suggestedAssignee: string;
  triagedBy: string;
  triagedAt: number;
  commentId: string;
}

export type TriageApplyOutcome =
  | { ok: true; result: TriageApplyResult }
  | { ok: false; reason: TriageApplyFailureReason; detail?: string };

export interface TriageApplyDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  projectId: string;
  /** The intake/lead agent that emitted the block. Stored as `triaged_by`. */
  triagedByAgentId: string;
  /** The project's full agent roster, used to validate `assignee`. */
  projectAgents: Agent[];
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const TRIAGE_TAG_RE = /<agenthub:triage>\s*([\s\S]*?)\s*<\/agenthub:triage>/i;

/**
 * Extract an `<agenthub:triage>...</agenthub:triage>` block from `text` and
 * return the parsed task. Pure — does NOT validate `assignee` against any
 * agent roster (apply time does that).
 *
 * Only the first block in `text` is considered. Returns `present: false`
 * when no block is found at all.
 */
export function detectTriageBlock(text: string): TriageDetectionResult {
  if (typeof text !== 'string') {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const match = text.match(TRIAGE_TAG_RE);
  if (!match) return { present: false, task: null, reason: null, rawBody: null };

  const rawBody = match[1] ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { present: true, task: null, reason: 'invalid-json', rawBody };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, task: null, reason: 'not-object', rawBody };
  }

  const obj = parsed as Record<string, unknown>;

  if (!('assignee' in obj)) {
    return { present: true, task: null, reason: 'missing-assignee', rawBody };
  }
  if (typeof obj.assignee !== 'string') {
    return { present: true, task: null, reason: 'invalid-assignee-type', rawBody };
  }
  const assignee = obj.assignee.trim();
  if (!assignee) {
    return { present: true, task: null, reason: 'empty-assignee', rawBody };
  }

  let refinedDescription: string | undefined;
  if ('refinedDescription' in obj && obj.refinedDescription !== null) {
    if (typeof obj.refinedDescription !== 'string') {
      return { present: true, task: null, reason: 'invalid-description-type', rawBody };
    }
    const trimmed = obj.refinedDescription.trim();
    if (trimmed) refinedDescription = trimmed;
  }

  let acceptanceCriteria: string[] | undefined;
  if ('acceptanceCriteria' in obj && obj.acceptanceCriteria !== null) {
    if (!Array.isArray(obj.acceptanceCriteria)) {
      return { present: true, task: null, reason: 'invalid-acceptance-criteria-type', rawBody };
    }
    const cleaned: string[] = [];
    for (const ac of obj.acceptanceCriteria) {
      if (typeof ac !== 'string') {
        return { present: true, task: null, reason: 'invalid-acceptance-criteria-type', rawBody };
      }
      const t = ac.trim();
      if (t) cleaned.push(t);
    }
    if (cleaned.length > 0) acceptanceCriteria = cleaned;
  }

  let labels: string[] | undefined;
  if ('labels' in obj && obj.labels !== null) {
    if (!Array.isArray(obj.labels)) {
      return { present: true, task: null, reason: 'invalid-labels-type', rawBody };
    }
    const cleaned: string[] = [];
    for (const l of obj.labels) {
      if (typeof l !== 'string') {
        return { present: true, task: null, reason: 'invalid-labels-type', rawBody };
      }
      const t = l.trim();
      if (t) cleaned.push(t);
    }
    if (cleaned.length > 0) labels = cleaned;
  }

  const task: TriageTask = { assignee };
  if (refinedDescription) task.refinedDescription = refinedDescription;
  if (acceptanceCriteria) task.acceptanceCriteria = acceptanceCriteria;
  if (labels) task.labels = labels;
  return { present: true, task, reason: null, rawBody };
}

/** Convenience for callers that don't care about the malformed-reason. */
export function parseTriageBlock(text: string): TriageTask | null {
  return detectTriageBlock(text).task;
}

export function describeTriageMalformedReason(reason: TriageMalformedReason): string {
  switch (reason) {
    case 'invalid-json':
      return 'Triage block contains invalid JSON';
    case 'not-object':
      return 'Triage block payload is not a JSON object';
    case 'missing-assignee':
      return 'Triage block is missing the "assignee" field';
    case 'empty-assignee':
      return 'Triage block has an empty "assignee" value';
    case 'invalid-assignee-type':
      return 'Triage block "assignee" must be a string';
    case 'invalid-description-type':
      return 'Triage block "refinedDescription" must be a string';
    case 'invalid-acceptance-criteria-type':
      return 'Triage block "acceptanceCriteria" must be an array of strings';
    case 'invalid-labels-type':
      return 'Triage block "labels" must be an array of strings';
    default:
      return 'Triage block could not be parsed';
  }
}

// ─── Description merge ───────────────────────────────────────────────────────

/**
 * Build the new card description from the triage payload.
 *
 * Pure for testability. Behavior:
 *   - If `refinedDescription` is provided, it replaces the body.
 *   - Otherwise the original description (or empty string) is preserved.
 *   - When `acceptanceCriteria` is provided, an "## Acceptance Criteria"
 *     section is appended (the section is replaced if one already exists,
 *     so re-triage is idempotent rather than additive).
 */
export function buildTriagedDescription(args: {
  existing: string | null;
  refinedDescription?: string;
  acceptanceCriteria?: string[];
}): string | null {
  const { refinedDescription, acceptanceCriteria } = args;
  let body = refinedDescription ?? args.existing ?? '';

  // Strip any prior "## Acceptance Criteria" section so we replace, not append.
  body = body.replace(/\n*##\s+Acceptance Criteria[\s\S]*$/i, '').trimEnd();

  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    const acBlock = [
      '## Acceptance Criteria',
      ...acceptanceCriteria.map((ac) => `- [ ] ${ac}`),
    ].join('\n');
    body = body ? `${body}\n\n${acBlock}` : acBlock;
  }

  if (!body.trim()) return null;
  return body;
}

/**
 * Merge label sets. Existing labels are stored as a comma-separated string;
 * new labels arrive as an array. Returns a comma-separated string with
 * duplicates removed (case-insensitive), or null when both are empty.
 */
export function mergeLabels(
  existing: string | null | undefined,
  added: string[] | undefined,
): string | null {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  if (typeof existing === 'string' && existing.trim()) {
    for (const part of existing.split(',')) push(part);
  }
  if (added) {
    for (const part of added) push(part);
  }
  return out.length > 0 ? out.join(',') : null;
}

// ─── Roster helpers ──────────────────────────────────────────────────────────

/**
 * Pick the agent that should perform triage for this project. Prefers a
 * dedicated `intake` agent; falls back to the project lead. Returns null
 * when neither exists.
 *
 * Out-of-band roles (docs, reviewer) are never returned even as fallbacks —
 * the autonomous dispatcher already excludes them from work assignment.
 */
export function pickTriageAgent(project: Project): Agent | null {
  const agents = project.agents || [];
  const intake = agents.find((a) => a.role === 'intake');
  if (intake) return intake;
  const lead = agents.find((a) => a.role === 'lead');
  if (lead) return lead;
  return null;
}

/**
 * Resolve the intake-suggested assignee against the project's specialist
 * roster. Returns the matching agent, or null when:
 *   - the id doesn't match any project agent
 *   - the matched agent has an out-of-band role (docs, intake, reviewer)
 *     — those are never valid dispatch targets
 *   - the matched agent is the project lead AND there are sub-agents
 *     available (lead is a fallback, not a routing target by default)
 *
 * Roster-only validation lives here; the parser stays pure.
 */
export function resolveTriageAssignee(project: Project, assigneeId: string): Agent | null {
  const agents = project.agents || [];
  const target = agents.find((a) => a.id === assigneeId);
  if (!target) return null;
  if (target.role === 'docs' || target.role === 'intake' || target.role === 'reviewer') {
    return null;
  }
  return target;
}

// ─── Apply handler ───────────────────────────────────────────────────────────

/**
 * Apply a parsed triage payload to the card linked to `sessionId`. Atomic —
 * the description/labels/suggested_assignee/triaged_at update runs as a
 * single prepared statement (`setCardTriage`).
 *
 * Best-effort: all exceptions are caught and reported via the outcome
 * shape; the function never throws. The comment-insert is also best-effort
 * (a failed comment does NOT roll back the triage stamping).
 */
export function applyTriageResult(
  sessionId: string,
  task: TriageTask,
  deps: TriageApplyDeps,
): TriageApplyOutcome {
  const { stmts, broadcast, projectId, triagedByAgentId, projectAgents } = deps;

  let card: KanbanCardRow | undefined;
  try {
    card = stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
  } catch (err) {
    return {
      ok: false,
      reason: 'card_lookup_failed',
      detail: (err as Error).message,
    };
  }
  if (!card) return { ok: false, reason: 'no_linked_card' };

  const fakeProject: Project = {
    agents: projectAgents,
  } as Project;
  const resolved = resolveTriageAssignee(fakeProject, task.assignee);
  if (!resolved) {
    return { ok: false, reason: 'unknown_assignee', detail: task.assignee };
  }

  const newDescription = buildTriagedDescription({
    existing: card.description,
    refinedDescription: task.refinedDescription,
    acceptanceCriteria: task.acceptanceCriteria,
  });
  const newLabels = mergeLabels(card.labels, task.labels);

  try {
    stmts.setCardTriage.run(newDescription, newLabels, resolved.id, triagedByAgentId, card.id);
  } catch (err) {
    return { ok: false, reason: 'update_failed', detail: (err as Error).message };
  }

  // Pull the updated row back so we can stamp the same triaged_at value
  // we'll return — saves one strftime round-trip and keeps the result
  // consistent with what's persisted.
  let triagedAt = Date.now();
  try {
    const updated = stmts.getKanbanCard.get(card.id) as KanbanCardRow | undefined;
    if (updated && typeof updated.triaged_at === 'number') {
      triagedAt = updated.triaged_at;
    }
  } catch {
    /* keep the wall-clock fallback */
  }

  const commentId = uuidv4();
  const commentBody = buildTriageCommentBody({
    task,
    assigneeName: resolved.name,
    assigneeId: resolved.id,
    triagedByAgentId,
    sessionId,
  });
  try {
    stmts.createKanbanCardComment.run(commentId, card.id, triagedByAgentId, commentBody);
  } catch (err) {
    console.error('[Triage] Comment insert failed:', (err as Error).message);
    // Triage stamping already succeeded — keep ok:true.
  }

  try {
    broadcast({ type: 'kanban_update', projectId });
  } catch {
    /* broadcast failures should never surface */
  }

  return {
    ok: true,
    result: {
      cardId: card.id,
      previousDescription: card.description,
      newDescription,
      suggestedAssignee: resolved.id,
      triagedBy: triagedByAgentId,
      triagedAt,
      commentId,
    },
  };
}

/**
 * Render the comment appended to a card after triage. Pure — exported for
 * tests so the audit-trail surface is pinned down.
 */
export function buildTriageCommentBody(args: {
  task: TriageTask;
  assigneeName: string;
  assigneeId: string;
  triagedByAgentId: string;
  sessionId: string;
}): string {
  const { task, assigneeName, assigneeId, triagedByAgentId, sessionId } = args;
  const lines: string[] = [
    `🧭 Triaged by \`${triagedByAgentId}\` — routed to **${assigneeName}** (\`${assigneeId}\`).`,
  ];
  if (task.refinedDescription) {
    lines.push('', 'Description was refined.');
  }
  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    lines.push('', `Acceptance criteria added (${task.acceptanceCriteria.length}).`);
  }
  if (task.labels && task.labels.length > 0) {
    lines.push('', `Labels added: ${task.labels.map((l) => `\`${l}\``).join(', ')}.`);
  }
  lines.push('', `— session \`${sessionId}\``);
  return lines.join('\n');
}

// ─── Triage seed prompt ──────────────────────────────────────────────────────

/**
 * Build the seed message handed to the intake agent at the start of a triage
 * session. Pure — exported for tests so the contract the intake agent
 * follows is locked in.
 */
export function buildTriagePromptContext(args: {
  card: KanbanCardRow;
  specialists: Agent[];
}): string {
  const { card, specialists } = args;
  const lines: string[] = [`# Triage: ${card.title}`];
  if (card.description) lines.push('\n## Existing Description', card.description);
  if (card.priority) lines.push(`\n**Priority:** ${card.priority}`);
  if (card.labels) lines.push(`**Labels:** ${card.labels}`);

  if (specialists.length > 0) {
    lines.push('\n## Available Specialists');
    for (const a of specialists) {
      const role = a.role ? ` (${a.role})` : '';
      lines.push(`- \`${a.id}\`${role} — ${a.name}`);
    }
  }

  lines.push(
    '',
    '---',
    '## Your Job',
    'You are the intake/triage agent. Read the card above and decide:',
    '1. **Which specialist** should own this work? Pick from the roster above.',
    '2. **Is the description clear?** If it is vague, rewrite it so the specialist can start without back-and-forth.',
    '3. **What are the acceptance criteria?** List them as testable checkboxes.',
    '4. **Any labels** worth adding for routing/filtering?',
    '',
    'When done, emit a single `<agenthub:triage>` block at the END of your turn:',
    '',
    '```',
    '<agenthub:triage>',
    '{',
    '  "assignee": "<specialist-id-from-roster>",',
    '  "refinedDescription": "...",',
    '  "acceptanceCriteria": ["AC1", "AC2"],',
    '  "labels": ["label1", "label2"]',
    '}',
    '</agenthub:triage>',
    '',
    '```',
    '',
    'Only `assignee` is required. Omit any optional field you do not want to change.',
    'Do **NOT** write code. Do **NOT** open a PR. Triage only.',
  );
  return lines.join('\n');
}
