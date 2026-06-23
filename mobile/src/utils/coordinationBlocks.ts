/**
 * Mobile twin of `client/src/utils/coordinationBlocks.js`.
 *
 * Parses `<handoff>` and `<delegate>` blocks out of an assistant message so
 * the chat can render a compact visual card instead of the raw JSON wall
 * the server stores on the message body.
 *
 * Kept dependency-free and identical in shape to the web util so behaviour
 * stays in sync. See the web file for the long-form rationale.
 */
/** Suffix-only: real protocol blocks are terminal; avoids stripping fenced examples. */
const HANDOFF_TAIL_RE = /<handoff>\s*([\s\S]*?)\s*<\/handoff>\s*$/;
const DELEGATE_TAIL_RE = /<delegate>\s*([\s\S]*?)\s*<\/delegate>\s*$/;
/**
 * Canonical list of required delegate contract fields. Shared so any mobile
 * UI surface that wants to render a diagnostic can cite the same names the
 * parser enforces. Mirrors `DELEGATE_REQUIRED_FIELDS` in the client util.
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
    const rawAgentId = typeof entry.agentId === 'string'
        ? entry.agentId
        : typeof entry.toAgent === 'string'
            ? entry.toAgent
            : '';
    const agentId = rawAgentId.trim();
    const fieldValue = (key: any) => (typeof entry[key] === 'string' ? entry[key].trim() : '');
    const missing = [];
    if (!agentId)
        missing.push('agentId');
    for (const key of ['task', 'owner', 'scope', 'expectedArtifact', 'deadline', 'returnFormat']) {
        if (!fieldValue(key))
            missing.push(key);
    }
    return { agentId: agentId || null, missing };
}
/**
 * Mirror of the client `detectDelegateBlock` so mobile detection stays in
 * parity. Returns the same shape, including per-row `rows` diagnostics on
 * `no-valid-entries` / `missing-contract-fields`. Mobile UI does not yet
 * render a failed-state card; the helper is exported so future surfaces
 * can consume the same diagnostic without a second parser.
 */
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
    let parsed;
    try {
        parsed = JSON.parse(rawBody);
    }
    catch {
        return { present: true, tasks: null, reason: 'invalid-json', rawBody };
    }
    if (parsed == null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
        return { present: true, tasks: null, reason: 'not-object', rawBody };
    }
    // Mirror the web/server shape tolerance: accept `{ tasks: [...] }` too.
    const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.tasks)
            ? parsed.tasks
            : [parsed];
    if (list.length === 0) {
        return { present: true, tasks: null, reason: 'empty-array', rawBody };
    }
    const tasks = [];
    const rows = [];
    let invalidRows = 0;
    for (const entry of list) {
        const summary = summarizeDelegateRow(entry);
        rows.push(summary);
        if (summary.missing.length > 0) {
            invalidRows += 1;
            continue;
        }
        const rawAgentId = typeof entry.agentId === 'string'
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
export function parseHandoffBlock(text: any) {
    if (typeof text !== 'string' || !text.includes('<handoff>'))
        return null;
    const match = text.trimEnd().match(HANDOFF_TAIL_RE);
    if (!match)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(match[1]);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    const toAgent = typeof parsed.toAgent === 'string' ? parsed.toAgent.trim() : '';
    const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';
    if (!toAgent || !note)
        return null;
    return { toAgent, note };
}
export function parseDelegateBlock(text: any) {
    return detectDelegateBlock(text).tasks;
}
export function extractCoordinationBlocks(text: any) {
    if (typeof text !== 'string' || text.length === 0) {
        return { stripped: text ?? '', handoff: null, delegate: null };
    }
    let handoff = null;
    let delegate = null;
    let working = text;
    // Same peel order as web `client/src/utils/coordinationBlocks.js`: try a
    // trailing delegate first, then a trailing handoff, and loop so
    // `…</delegate>\n<handoff>…</handoff>` peels handoff then delegate. Only
    // strips when JSON parses (mobile leaves malformed suffix blocks untouched).
    for (let i = 0; i < 8; i++) {
        const trimmed = working.trimEnd();
        const dm = trimmed.match(DELEGATE_TAIL_RE);
        if (dm) {
            const del = parseDelegateBlock(trimmed);
            if (del) {
                delegate = del;
                working = trimmed.slice(0, dm.index).trimEnd();
                continue;
            }
            break;
        }
        const hm = trimmed.match(HANDOFF_TAIL_RE);
        if (hm) {
            const ho = parseHandoffBlock(trimmed);
            if (ho) {
                handoff = ho;
                working = trimmed.slice(0, hm.index).trimEnd();
                continue;
            }
            break;
        }
        break;
    }
    let stripped = working;
    stripped = stripped.replace(/\n{3,}/g, '\n\n').trim();
    return { stripped, handoff, delegate };
}
/**
 * Correlate a parsed `<handoff>` block back to a DB row from
 * `api.getSessionHandoffs(sessionId)`. The server's fuzzy resolver may
 * rewrite the raw `toAgent` (e.g. "agent-hub-backend" → "hub-backend"), so
 * we accept either the raw block id or the resolved `to_agent_id`,
 * preferring delivered rows and then the most recent match. When there is a
 * single row for the whole source session (common — handoff is terminal) we
 * return it unconditionally so pending/failed status still renders. Mirror
 * of `pickHandoffRow` in `client/src/components/SessionTail.jsx`.
 */
export function pickHandoffRow(block: any, rows: any) {
    if (!Array.isArray(rows) || rows.length === 0)
        return null;
    const wanted = (block?.toAgent || '').trim().toLowerCase();
    const match = (r: any) => {
        const rowAgent = (r?.to_agent_id || '').toLowerCase();
        if (!wanted || !rowAgent)
            return false;
        return (rowAgent === wanted ||
            rowAgent.endsWith(`-${wanted}`) ||
            wanted.endsWith(`-${rowAgent}`) ||
            wanted.includes(rowAgent) ||
            rowAgent.includes(wanted));
    };
    return (rows.find((r: any) => r.status === 'delivered' && match(r)) ||
        rows.find((r: any) => match(r)) ||
        (rows.length === 1 ? rows[0] : null));
}
