/**
 * JSON preferences on `orgs.db.users.preferences_json`.
 *
 * Two shapes today:
 *   - `agentEngineOverrides` — per-account per-agent engine (+ optional model)
 *                              override. Lets two users open the same agent
 *                              under different engines (User A → codex-cli,
 *                              User B → claude-code) without touching the
 *                              shared `agents` row. Consulted by session-spawn
 *                              sites before falling back to `agent.engine`.
 *   - `agentModelOverrides`  — per-account per-agent **model** override. This
 *                              is the per-user "default model" picked from the
 *                              agent / reviewer model dropdown: it changes only
 *                              the model the caller's own sessions spawn with,
 *                              never the shared `agents` row or any other user.
 *                              The engine stays whatever the shared row (or an
 *                              `agentEngineOverrides` entry) resolves to; the
 *                              model is validated against that engine at spawn
 *                              time, so a stale pick simply falls back to the
 *                              per-engine default.
 *
 * The map is stored on the `preferences_json` column so we don't have to
 * migrate the table every time a new preference is added. The column is
 * normalized on read (unknown keys / non-string values are dropped) so the
 * write path can stay forgiving without leaking malformed state downstream.
 *
 * Legacy note: an `engineDefaultModels` sub-map used to live here too. The
 * per-user "default models" UI was removed once `agentEngineOverrides`
 * covered the same use case; any persisted `engineDefaultModels` key is
 * ignored on read and dropped on the next write.
 */
import { getOrgsDb } from './orgs.js';

export interface AgentEngineOverride {
  engine: string;
  model?: string;
}

export interface UserPreferencesStored {
  agentEngineOverrides?: Record<string, AgentEngineOverride>;
  /** Per-agent per-user model pick (`{ [agentId]: modelId }`). */
  agentModelOverrides?: Record<string, string>;
}

function normalizeAgentEngineOverrides(
  raw: unknown,
): Record<string, AgentEngineOverride> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, AgentEngineOverride> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const agentId = typeof k === 'string' ? k.trim() : '';
    if (!agentId) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const obj = v as Record<string, unknown>;
    const engine = typeof obj.engine === 'string' ? obj.engine.trim() : '';
    if (!engine) continue;
    const model = typeof obj.model === 'string' ? obj.model.trim() : '';
    out[agentId] = model ? { engine, model } : { engine };
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeAgentModelOverrides(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const agentId = typeof k === 'string' ? k.trim() : '';
    if (!agentId) continue;
    const model = typeof v === 'string' ? v.trim() : '';
    if (!model) continue;
    out[agentId] = model;
  }
  return Object.keys(out).length ? out : undefined;
}

function parsePrefsJson(raw: string | null): UserPreferencesStored {
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const obj = o as Record<string, unknown>;
    const ao = normalizeAgentEngineOverrides(obj.agentEngineOverrides);
    const mo = normalizeAgentModelOverrides(obj.agentModelOverrides);
    const result: UserPreferencesStored = {};
    if (ao) result.agentEngineOverrides = ao;
    if (mo) result.agentModelOverrides = mo;
    return result;
  } catch {
    return {};
  }
}

/** Parsed preferences for `userId`, or `{}` if the user row is missing. */
export function getUserPreferencesRow(userId: string): UserPreferencesStored {
  const row = getOrgsDb().prepare('SELECT preferences_json FROM users WHERE id = ?').get(userId) as
    | { preferences_json: string | null }
    | undefined;
  if (!row) return {};
  return parsePrefsJson(row.preferences_json ?? null);
}

/**
 * Persist `preferences_json`. Pass `{}` to clear the column entirely. Any
 * sub-map left empty / undefined is omitted from the stored JSON so we
 * don't grow dead keys over time.
 *
 * **This is a full replacement.** Callers that only want to update a
 * single sub-map should use `mergeUserPreferencesJson` instead so they
 * don't wipe the untouched maps.
 */
export function replaceUserPreferencesJson(userId: string, prefs: UserPreferencesStored): void {
  const stored: Record<string, unknown> = {};
  if (prefs.agentEngineOverrides && Object.keys(prefs.agentEngineOverrides).length > 0) {
    stored.agentEngineOverrides = prefs.agentEngineOverrides;
  }
  if (prefs.agentModelOverrides && Object.keys(prefs.agentModelOverrides).length > 0) {
    stored.agentModelOverrides = prefs.agentModelOverrides;
  }
  const json = Object.keys(stored).length > 0 ? JSON.stringify(stored) : null;
  getOrgsDb().prepare('UPDATE users SET preferences_json = ? WHERE id = ?').run(json, userId);
}

/**
 * Replace only the sub-maps that `partial` mentions, preserving the rest
 * of the user's preferences. A key set to `undefined` leaves that sub-map
 * untouched; a key set to an empty object clears it. Use this from the
 * per-feature PUT routes so two unrelated preferences don't stomp each
 * other.
 */
export function mergeUserPreferencesJson(
  userId: string,
  partial: UserPreferencesStored,
): UserPreferencesStored {
  const current = getUserPreferencesRow(userId);
  const next: UserPreferencesStored = { ...current };
  if (partial.agentEngineOverrides !== undefined) {
    next.agentEngineOverrides = Object.keys(partial.agentEngineOverrides).length
      ? partial.agentEngineOverrides
      : undefined;
  }
  if (partial.agentModelOverrides !== undefined) {
    next.agentModelOverrides = Object.keys(partial.agentModelOverrides).length
      ? partial.agentModelOverrides
      : undefined;
  }
  replaceUserPreferencesJson(userId, next);
  return next;
}
