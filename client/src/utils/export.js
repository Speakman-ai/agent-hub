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
