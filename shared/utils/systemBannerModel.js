/**
 * Human-readable model line for Codex/CLI "system" banner rows in SessionTail.
 * Codex `thread.started` JSONL often omits `model` (openai/codex#14736), so we
 * fall back to the Agent Hub session's engine/model instead of "unknown model".
 */

const ENGINE_DISPLAY = {
  'claude-code': 'Claude Code',
  'cursor-agent': 'Cursor Agent',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
};

/** Keep in sync with client TopBar.jsx MODEL_LABELS / mobile engineOptions. */
const MODEL_KNOWN_LABELS = {
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet',
  'composer-2': 'Composer 2',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.2': 'GPT-5.2',
};

function trimmed(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

/**
 * @param {string | null | undefined} modelId
 * @returns {string} display title; empty if modelId is missing
 */
export function modelPrimaryLabel(modelId) {
  const id = trimmed(modelId);
  if (!id) return '';
  if (MODEL_KNOWN_LABELS[id]) return MODEL_KNOWN_LABELS[id];
  return id
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @param {object} p
 * @param {string | null | undefined} p.streamModel — model from engine JSONL (`system` event)
 * @param {string | null | undefined} p.sessionModel — `messages.model` / session row
 * @param {string | null | undefined} p.sessionEngine — e.g. `codex-cli`
 * @returns {string} single-line label for the monospace session context banner
 */
export function formatSystemBannerModelLine({ streamModel, sessionModel, sessionEngine }) {
  const fromStream = modelPrimaryLabel(streamModel);
  if (fromStream) return fromStream;
  const fromSession = modelPrimaryLabel(sessionModel);
  if (fromSession) return fromSession;
  const engName = sessionEngine && ENGINE_DISPLAY[sessionEngine];
  if (engName) return `${engName} · session default`;
  return 'Model not reported · use the engine & model picker';
}
