/**
 * Export utilities for formatting and copying session/room conversations.
 */

/**
 * Format a regular chat session as copyable text.
 * @param {Object} opts
 * @param {Object} opts.agent - Agent object with name, engine
 * @param {Array}  opts.messages - Array of {role, content, created_at}
 * @param {string} [opts.sessionEngine] - Engine used for the session
 * @returns {string} Formatted conversation text
 */
export function formatSessionExport({ agent, messages, sessionEngine }) {
  const lines = [];
  lines.push(`# ${agent?.name || 'Chat'} — Session Export`);
  if (agent?.engine || sessionEngine) {
    lines.push(`Engine: ${sessionEngine || agent.engine}`);
  }
  lines.push(`Exported: ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const label = msg.role === 'user' ? 'User' : agent?.name || 'Assistant';
    lines.push(`**${label}:**`);
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a conference room conversation as copyable text.
 * @param {Object} opts
 * @param {Object} opts.room - Room object with name, agents
 * @param {Array}  opts.messages - Array of {role, agent_name, content, created_at}
 * @returns {string} Formatted conversation text
 */
export function formatRoomExport({ room, messages }) {
  const lines = [];
  lines.push(`# ${room?.name || 'Conference Room'} — Room Export`);
  if (room?.agents?.length) {
    lines.push(`Agents: ${room.agents.map((a) => a.name).join(', ')}`);
  }
  lines.push(`Exported: ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const label = msg.role === 'user' ? 'User' : msg.agent_name || 'Agent';
    lines.push(`**${label}:**`);
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a concise, descriptive note title for a saved conversation.
 * Examples:
 *   "Chat with TestBot — 2025-06-15"
 *   "TestBot — summary — 2025-06-15"
 *   "Room \"Design Review\" — raw — 2025-06-15"
 *
 * @param {Object} opts
 * @param {'raw'|'summary'} opts.kind
 * @param {Object} [opts.agent] - For session saves
 * @param {Object} [opts.room] - For room saves
 * @param {Date}   [opts.now] - Injectable for testing
 * @returns {string}
 */
export function buildNoteTitle({ kind, agent, room, now }) {
  const d = now instanceof Date ? now : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const date = `${yyyy}-${mm}-${dd}`;
  const label = kind === 'summary' ? 'summary' : 'raw';
  if (room) {
    const name = room.name || 'Conference Room';
    return `Room "${name}" — ${label} — ${date}`;
  }
  const name = agent?.name || 'Chat';
  return `${name} — ${label} — ${date}`;
}

/**
 * Save a conversation (raw or summary) as an Agent Hub project note.
 *
 * Returns `{ ok: true, note }` on success, `{ ok: false, error }` on failure.
 * Does not throw — callers render feedback based on the returned shape.
 *
 * @param {Object} opts
 * @param {Object} opts.api - api client exposing `createNote(projectId, {title, content})`
 * @param {string} opts.projectId
 * @param {string} opts.title
 * @param {string} opts.content
 */
export async function saveConversationAsNote({ api, projectId, title, content }) {
  if (!projectId) return { ok: false, error: new Error('Missing projectId') };
  if (!title) return { ok: false, error: new Error('Missing title') };
  try {
    const note = await api.createNote(projectId, { title, content: content || '' });
    return { ok: true, note };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Copy text to clipboard with fallback. Returns true on success.
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}
