/**
 * Parser for agent-coordination blocks emitted in assistant messages.
 *
 * The server recognises two protocol blocks in the *final* assistant text:
 *
 *   <handoff>{"toAgent": "...", "note": "..."}</handoff>
 *     — transfers ownership of the session to another agent (terminal).
 *
 *   <delegate>[{"agentId": "...", "task": "..."}, ...]</delegate>
 *     — spawns one or more parallel sub-agent sessions (lead keeps running).
 *     Body may be a JSON **array** or a single **object** (treated as a
 *     one-element array); both match `server/delegation.ts`.
 *
 * The canonical delegate field is `agentId` (matches the prompt wired in
 * `server/chat.ts`). The top-level JSON body may be an **array** or a single
 * **object** (coerced to a one-element list on the server in
 * `server/delegation.ts#detectDelegateBlock`). Each row must include the full
 * contract: `agentId` (or legacy `toAgent` for the same field), `task`,
 * `owner`, `scope`, `expectedArtifact`, `deadline`, and `returnFormat`.
 *
 * This module gives the renderer:
 *   - parseHandoffBlock(text)      → { toAgent, note } | null
 *   - parseDelegateBlock(text)     → Array<{ agentId, task }> | null
 *   - detectHandoffBlock(text)     → { present, task, reason, rawBody }
 *   - detectDelegateBlock(text)    → { present, tasks, reason, rawBody }
 *   - extractCoordinationBlocks(text)
 *       → { stripped, handoff, delegate, handoffMalformed, delegateMalformed }
 *     so the rendered text can be the conversational prose alone, with the
 *     coordination intent shown as a dedicated card. Malformed blocks are
 *     also stripped from the prose and surfaced as failed-state cards so
 *     raw JSON never leaks into the chat.
 *
 * The parsers are intentionally tolerant of whitespace and of occasional
 * stream-fragment edge cases. They return `null` (not throw) on malformed
 * input so a partially-streamed block never crashes the chat.
 */

/** Terminal coordination blocks only (mirrors server: blocks are suffix of the turn). */
const HANDOFF_TAIL_RE = /<handoff>\s*([\s\S]*?)\s*<\/handoff>\s*$/;
const DELEGATE_TAIL_RE = /<delegate>\s*([\s\S]*?)\s*<\/delegate>\s*$/;

/**
 * Detect a `<handoff>` block in `text` and return a tagged result:
 *   { present, task, reason, rawBody }
 * where `task` is non-null only when the block parsed cleanly, and `reason`
 * explains *why* a present block failed. Mirrors
 * `server/handoff.ts#detectHandoffBlock` so the web UI can distinguish
 * "no block" from "malformed block" and still render a failed-state
 * HandoffCard instead of silently dropping the handoff.
 *
 * Only a **suffix** `<handoff>...</handoff>` is recognised so examples inside
 * fenced markdown cannot be stripped (which would break code fences and diffs).
 *
 * Reason codes:
 *   'invalid-json' — body is not valid JSON
 *   'not-object'   — body parsed but is not a JSON object
 *   'array-payload'— body is an array (handoff is single-target)
 *   'missing-toagent' / 'missing-note' — field not present
 *   'empty-toagent'  / 'empty-note'     — field present but blank
 */
export function detectHandoffBlock(text: any) {
  if (typeof text !== 'string' || !text.includes('<handoff>')) {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const trimmed = text.trimEnd();
  const match = trimmed.match(HANDOFF_TAIL_RE);
  if (!match) {
    return { present: false, task: null, reason: null, rawBody: null };
  }
  const rawBody = match[1] ?? '';
  let parsed: any;
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
  if (typeof parsed.toAgent !== 'string') {
    return { present: true, task: null, reason: 'missing-toagent', rawBody };
  }
  if (typeof parsed.note !== 'string') {
    return { present: true, task: null, reason: 'missing-note', rawBody };
  }
  const toAgent = parsed.toAgent.trim();
  const note = parsed.note.trim();
  if (!toAgent) return { present: true, task: null, reason: 'empty-toagent', rawBody };
  if (!note) return { present: true, task: null, reason: 'empty-note', rawBody };
  return { present: true, task: { toAgent, note }, reason: null, rawBody };
}

const HANDOFF_REASON_MESSAGES = {
  'invalid-json': 'Handoff block contains invalid JSON',
  'not-object': 'Handoff block payload is not a JSON object',
  'array-payload': 'Handoff block payload is an array (handoff is single-target)',
  'missing-toagent': 'Handoff block is missing the "toAgent" field',
  'missing-note': 'Handoff block is missing the "note" field',
  'empty-toagent': 'Handoff block has an empty "toAgent" field',
  'empty-note': 'Handoff block has an empty "note" field',
} as Record<string, any>;

/**
 * Human-readable label for a detection reason — mirrors the server's
 * `describeHandoffReason` so both paths surface the same error text.
 */
export function describeHandoffReason(reason: any) {
  return HANDOFF_REASON_MESSAGES[reason] || 'Handoff block could not be parsed';
}

/**
 * Parse a `<handoff>` block out of `text`. Returns the parsed task or null
 * if the block is missing, malformed, or missing required fields. Matches
 * the validation in `server/handoff.ts#parseHandoffBlock`.
 */
export function parseHandoffBlock(text: any) {
  return detectHandoffBlock(text).task;
}

/**
 * Detect a `<delegate>` block in `text` and return a tagged result:
 *   { present, tasks, reason, rawBody }
 * where `tasks` is a non-empty array only when the block parsed cleanly,
 * and `reason` explains *why* a present block failed. Mirrors
 * `detectHandoffBlock` so the UI can distinguish "no block" from
 * "malformed block" and render a failed-state `DelegateCard` instead of
 * silently dropping the delegation — the previous behaviour was the root
 * cause of the "delegate sometimes doesn't show up" bug when WebSocket
 * events for successful dispatches were delayed or dropped.
 *
 * Only a **suffix** `<delegate>...</delegate>` is recognised (same rationale as
 * handoff): examples inside fenced markdown must not be stripped.
 *
 * Reason codes:
 *   'invalid-json'       — body is not valid JSON
 *   'not-object'         — body parsed but is neither object nor array
 *   'empty-array'        — body is `[]`
 *   'no-valid-entries'   — every entry is missing required contract fields
 *   'missing-contract-fields' — at least one entry is valid, but another is missing required fields
 *
 * When the reason is `no-valid-entries` or `missing-contract-fields`, the
 * result also carries a `rows` array with one entry per raw row:
 *   { agentId: string | null, missing: string[] }
 * so the UI can tell the user (and the model) exactly which fields to add
 * — this is what turns the generic "Failed —" card into an actionable
 * diagnostic and is the mitigation for the recurring bug where models
 * emit `{agentId, task}` and omit the rest of the contract.
 */
export const DELEGATE_REQUIRED_FIELDS = [
  'agentId',
  'task',
  'owner',
  'scope',
  'expectedArtifact',
  'deadline',
  'returnFormat',
];

function summarizeDelegateRow(entry: any) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { agentId: null, missing: ['entry-not-object'] };
  }
  const rawAgentId =
    typeof entry.agentId === 'string'
      ? entry.agentId
      : typeof entry.toAgent === 'string'
        ? entry.toAgent
        : '';
  const agentId = rawAgentId.trim();
  const fieldValue = (key: any) => (typeof entry[key] === 'string' ? entry[key].trim() : '');
  const missing: any[] = [];
  if (!agentId) missing.push('agentId');
  for (const key of ['task', 'owner', 'scope', 'expectedArtifact', 'deadline', 'returnFormat']) {
    if (!fieldValue(key)) missing.push(key);
  }
  return { agentId: agentId || null, missing };
}

export function detectDelegateBlock(text: any) {
  if (typeof text !== 'string' || !text.includes('<delegate>')) {
    return { present: false, tasks: null, reason: null, rawBody: null };
  }
  const trimmed = text.trimEnd();
  const match = trimmed.match(DELEGATE_TAIL_RE);
  if (!match) {
    return { present: false, tasks: null, reason: null, rawBody: null };
  }
  const rawBody = match[1] ?? '';
  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { present: true, tasks: null, reason: 'invalid-json', rawBody };
  }
  if (parsed == null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
    return { present: true, tasks: null, reason: 'not-object', rawBody };
  }
  // Accept `{ tasks: [...] }` wrapper shape (mirrors server/delegation.ts).
  // Models regularly emit this REST-flavoured form; previously it wrapped
  // the whole object as `[wrapper]` and failed with `no-valid-entries`.
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.tasks)
      ? parsed.tasks
      : [parsed];
  if (list.length === 0) {
    return { present: true, tasks: null, reason: 'empty-array', rawBody };
  }
  const tasks: any[] = [];
  const rows: any[] = [];
  let invalidRows = 0;
  for (const entry of list) {
    const summary = summarizeDelegateRow(entry);
    rows.push(summary);
    if (summary.missing.length > 0) {
      invalidRows += 1;
      continue;
    }
    // summary.missing.length === 0 ⇒ every field trimmed to non-empty string.
    const rawAgentId =
      typeof entry.agentId === 'string'
        ? entry.agentId
        : typeof entry.toAgent === 'string'
          ? entry.toAgent
          : '';
    tasks.push({
      agentId: rawAgentId.trim(),
      task: entry.task.trim(),
      owner: entry.owner.trim(),
      scope: entry.scope.trim(),
      expectedArtifact: entry.expectedArtifact.trim(),
      deadline: entry.deadline.trim(),
      returnFormat: entry.returnFormat.trim(),
    });
  }
  if (tasks.length === 0) {
    return { present: true, tasks: null, reason: 'no-valid-entries', rawBody, rows };
  }
  if (invalidRows > 0) {
    return { present: true, tasks: null, reason: 'missing-contract-fields', rawBody, rows };
  }
  return { present: true, tasks, reason: null, rawBody };
}

const DELEGATE_REASON_MESSAGES = {
  'invalid-json': 'Delegate block contains invalid JSON',
  'not-object': 'Delegate block payload is not a JSON object or array',
  'empty-array': 'Delegate block payload is an empty array',
  'no-valid-entries':
    'Delegate block has no entries with the required contract fields (agentId, task, owner, scope, expectedArtifact, deadline, returnFormat)',
  'missing-contract-fields':
    'Delegate block includes entries missing required contract fields; every entry must include agentId, task, owner, scope, expectedArtifact, deadline, and returnFormat',
} as Record<string, any>;

/**
 * Human-readable label for a delegate detection reason code.
 */
export function describeDelegateReason(reason: any) {
  return DELEGATE_REASON_MESSAGES[reason] || 'Delegate block could not be parsed';
}

/**
 * Parse a `<delegate>` block. Returns an array of delegate contract objects or
 * null on missing / malformed input. Same rules as
 * `server/delegation.ts#parseDelegateBlock`.
 */
export function parseDelegateBlock(text: any) {
  return detectDelegateBlock(text).tasks;
}

/**
 * Strip both kinds of coordination blocks (and any incidental whitespace they
 * leave behind) from `text`. Returns the cleaned prose plus the parsed blocks
 * so a renderer can show the prose as markdown and the blocks as cards.
 *
 * Leaves the input untouched (and `handoff`/`delegate` null) when no blocks
 * are present.
 */
export function extractCoordinationBlocks(text: any) {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      stripped: text ?? '',
      handoff: null,
      delegate: null,
      handoffMalformed: null,
      delegateMalformed: null,
    };
  }

  let handoff = null;
  let delegate = null;
  let handoffMalformed = null;
  let delegateMalformed = null;
  let working = text;

  // Peel trailing blocks one at a time (delegate may follow handoff, or the
  // reverse). Suffix-only detection avoids stripping examples inside ``` fences.
  for (let i = 0; i < 8; i++) {
    const trimmed = working.trimEnd();
    const delegateDetection = detectDelegateBlock(trimmed);
    if (delegateDetection.present) {
      const m = trimmed.match(DELEGATE_TAIL_RE);
      if (!m) break;
      if (delegateDetection.tasks) delegate = delegateDetection.tasks;
      else
        delegateMalformed = {
          reason: delegateDetection.reason,
          rawBody: delegateDetection.rawBody ?? '',
          rows: Array.isArray(delegateDetection.rows) ? delegateDetection.rows : null,
        };
      working = trimmed.slice(0, m.index).trimEnd();
      continue;
    }

    const handoffDetection = detectHandoffBlock(trimmed);
    if (handoffDetection.present) {
      const m = trimmed.match(HANDOFF_TAIL_RE);
      if (!m) break;
      if (handoffDetection.task) handoff = handoffDetection.task;
      else
        handoffMalformed = {
          reason: handoffDetection.reason,
          rawBody: handoffDetection.rawBody ?? '',
        };
      working = trimmed.slice(0, m.index).trimEnd();
      continue;
    }

    break;
  }

  let stripped = working;
  // Collapse runs of 3+ blank lines that the strip can leave behind.
  stripped = stripped.replace(/\n{3,}/g, '\n\n').trim();

  return { stripped, handoff, delegate, handoffMalformed, delegateMalformed };
}
