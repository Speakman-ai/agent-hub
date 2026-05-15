/**
 * JSON preferences on `orgs.db.users.preferences_json` (Phase 4 follow-on).
 *
 * Today only `engineDefaultModels` is used — per-account default CLI model ids by
 * engine, honored after explicit session choices and before shared agent.config
 * `model` rows. See `server/effective-model.ts`.
 */
import { getOrgsDb } from './orgs.js';

export interface UserPreferencesStored {
  engineDefaultModels?: Record<string, string>;
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

function parsePrefsJson(raw: string | null): UserPreferencesStored {
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const em = normalizeEngineModels((o as Record<string, unknown>).engineDefaultModels);
    return em ? { engineDefaultModels: em } : {};
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
 * Persist `preferences_json`. Pass `null` / omit / empty prefs to clear the column.
 */
export function replaceUserPreferencesJson(userId: string, prefs: UserPreferencesStored): void {
  const json =
    prefs.engineDefaultModels && Object.keys(prefs.engineDefaultModels).length > 0
      ? JSON.stringify({ engineDefaultModels: prefs.engineDefaultModels })
      : null;
  getOrgsDb().prepare('UPDATE users SET preferences_json = ? WHERE id = ?').run(json, userId);
}
