/**
 * Formatting utilities for conference room exports (mobile).
 *
 * Mirrors `client/src/utils/export.js` `formatRoomExport` so the mobile and
 * web clients emit identical transcript text. Kept as a pure function to make
 * it easy to unit-test without pulling in any React Native / Expo modules.
 */
/**
 * Format a conference room conversation as copyable markdown text.
 * @param {Object} opts
 * @param {Object} [opts.room] - Room object with `name` and `agents`
 * @param {Array}  [opts.messages] - Array of `{role, agent_name, content, created_at}`
 * @param {Date}   [opts.now] - Optional clock override (for deterministic tests)
 * @returns {string} Formatted conversation text
 */
export function formatRoomExport({ room, messages, now }: any = {}) {
    const lines = [];
    lines.push(`# ${room?.name || 'Conference Room'} — Room Export`);
    if (room?.agents?.length) {
        lines.push(`Agents: ${room.agents.map((a: any) => a.name).join(', ')}`);
    }
    const stamp = (now instanceof Date ? now : new Date()).toLocaleString();
    lines.push(`Exported: ${stamp}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const msg of messages || []) {
        const label = msg.role === 'user' ? 'User' : msg.agent_name || 'Agent';
        lines.push(`**${label}:**`);
        lines.push(msg.content || '');
        lines.push('');
    }
    return lines.join('\n');
}
/**
 * Build the one-line status text shown above the composer when a room has
 * messages queued behind an in-flight round.
 * Returns `null` when no indicator should be shown.
 */
export function queueIndicatorText({ roomProcessing, roomQueueLength }: any = {}) {
    if (!roomProcessing)
        return null;
    const n = Number(roomQueueLength) || 0;
    if (n <= 0)
        return null;
    return `${n} message${n === 1 ? '' : 's'} queued — will be sent after agents finish`;
}
