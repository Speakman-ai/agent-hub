/**
 * JSON preferences on `orgs.db.users.preferences_json`.
 *
 * Two shapes today:
 *   - `engineDefaultModels`  — per-account default CLI model ids by engine.
 *                              Honored after explicit session choices and
 *                              before shared agent.config `model`. See
 *                              `server/effective-model.ts`.
 *   - `agentEngineOverrides` — per-account per-agent engine (+ optional model)
 *                              override. Lets two users open the same agent
 *                              under different engines (User A → codex-cli,
 *                              User B → claude-code) without touching the
 *                              shared `agents` row. Consulted by session-spawn
 *                              sites before falling back to `agent.engine`.
 *
 * Both maps are stored in the same `preferences_json` column so we don't have
 * to migrate the table every time a new preference is added. The column is
 * normalized on read (unknown keys / non-string values are dropped) so the
 * write path can stay forgiving without leaking malformed state downstream.
 */
import { getOrgsDb } from './orgs.js';

export interface AgentEngineOverride {
  engine: string;
  model?: string;
}

export interface UserPreferencesStored {
  engineDefaultModels?: Record<string, string>;
  agentEngineOverrides?: Record<string, AgentEngineOverride>;
}

function normalizeEngineModels(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof k === 'string' ? k.trim() : '';
    if (!key) continue;
    if (typeof v !== 'string' || !v.trim()) continue;
    out[key] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
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

function parsePrefsJson(raw: string | null): UserPreferencesStored {
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const obj = o as Record<string, unknown>;
    const em = normalizeEngineModels(obj.engineDefaultModels);
    const ao = normalizeAgentEngineOverrides(obj.agentEngineOverrides);
    const result: UserPreferencesStored = {};
    if (em) result.engineDefaultModels = em;
    if (ao) result.agentEngineOverrides = ao;
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
 * single sub-map (`engineDefaultModels` xor `agentEngineOverrides`)
 * should use `mergeUserPreferencesJson` instead so they don't wipe the
 * untouched maps.
 */
export function replaceUserPreferencesJson(userId: string, prefs: UserPreferencesStored): void {
  const stored: Record<string, unknown> = {};
  if (prefs.engineDefaultModels && Object.keys(prefs.engineDefaultModels).length > 0) {
    stored.engineDefaultModels = prefs.engineDefaultModels;
  }
  if (prefs.agentEngineOverrides && Object.keys(prefs.agentEngineOverrides).length > 0) {
    stored.agentEngineOverrides = prefs.agentEngineOverrides;
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
  if (partial.engineDefaultModels !== undefined) {
    next.engineDefaultModels = Object.keys(partial.engineDefaultModels).length
      ? partial.engineDefaultModels
      : undefined;
  }
  if (partial.agentEngineOverrides !== undefined) {
    next.agentEngineOverrides = Object.keys(partial.agentEngineOverrides).length
      ? partial.agentEngineOverrides
      : undefined;
  }
  replaceUserPreferencesJson(userId, next);
  return next;
}
