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
 *   - `todoAutoCompleteOnPromote` — when true, promoting a personal todo to a
 *                                   project card also marks that todo done.
 *   - `sidebarCollapsedProjects`  — project ids the caller has collapsed in the
 *                                   sidebar project list. Purely a UI
 *                                   preference, but per-account rather than
 *                                   per-device so the sidebar looks the same on
 *                                   web, mobile, and Electron.
 *   - `hubDailySummary`           — last Hub Daily Summary for this user,
 *                                   keyed by local YYYY-MM-DD. Stale dates are
 *                                   treated as empty so the report clears
 *                                   every day.
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
import {
  normalizeDailySummarySchedule,
  type HubDailySummarySchedule,
} from './daily-summary-schedule.js';

export interface AgentEngineOverride {
  engine: string;
  model?: string;
}

export interface HubDailySummaryStored {
  /** Caller's local calendar day (YYYY-MM-DD) the report belongs to. */
  date: string;
  timeZone: string;
  markdown: string;
  engine: string;
  model: string;
  generatedAt: string;
}

export interface UserPreferencesStored {
  agentEngineOverrides?: Record<string, AgentEngineOverride>;
  /** Per-agent per-user model pick (`{ [agentId]: modelId }`). */
  agentModelOverrides?: Record<string, string>;
  todoAutoCompleteOnPromote?: boolean;
  /** Project ids collapsed in the sidebar, de-duplicated and order-preserved. */
  sidebarCollapsedProjects?: string[];
  /**
   * Last Hub Daily Summary generated for this user. Stale when `date` is not
   * the caller's local today — GET/POST treat that as empty (clears each day).
   */
  hubDailySummary?: HubDailySummaryStored;
  /**
   * Auto-refresh schedule for the Hub Daily Summary: 1+ local times of day at
   * which the Hub regenerates the report for this user. Absent when unscheduled.
   */
  hubDailySummarySchedule?: HubDailySummarySchedule;
}

/**
 * Hard cap on how many collapsed project ids we persist. Guards the JSON blob
 * against an unbounded client PUT; well above any realistic project count.
 */
export const MAX_SIDEBAR_COLLAPSED_PROJECTS = 500;

/**
 * Normalize a collapsed-projects list: strings only, trimmed, empties dropped,
 * de-duplicated (first occurrence wins), capped. Returns `undefined` when
 * nothing survives so the key is omitted from the stored JSON.
 */
export function normalizeSidebarCollapsedProjects(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_SIDEBAR_COLLAPSED_PROJECTS) break;
  }
  return out.length ? out : undefined;
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

const HUB_DAILY_SUMMARY_MAX_MARKDOWN = 100_000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeHubDailySummary(raw: unknown): HubDailySummaryStored | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const date = typeof obj.date === 'string' ? obj.date.trim() : '';
  const markdown = typeof obj.markdown === 'string' ? obj.markdown : '';
  if (!DATE_ONLY_RE.test(date) || !markdown.trim()) return undefined;
  const timeZone = typeof obj.timeZone === 'string' ? obj.timeZone.trim() : '';
  const engine = typeof obj.engine === 'string' ? obj.engine.trim() : '';
  const model = typeof obj.model === 'string' ? obj.model.trim() : '';
  const generatedAt = typeof obj.generatedAt === 'string' ? obj.generatedAt.trim() : '';
  if (!generatedAt) return undefined;
  return {
    date,
    timeZone: timeZone || 'UTC',
    markdown: markdown.slice(0, HUB_DAILY_SUMMARY_MAX_MARKDOWN),
    engine,
    model,
    generatedAt,
  };
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
    if (typeof obj.todoAutoCompleteOnPromote === 'boolean') {
      result.todoAutoCompleteOnPromote = obj.todoAutoCompleteOnPromote;
    }
    const collapsed = normalizeSidebarCollapsedProjects(obj.sidebarCollapsedProjects);
    if (collapsed) result.sidebarCollapsedProjects = collapsed;
    const summary = normalizeHubDailySummary(obj.hubDailySummary);
    if (summary) result.hubDailySummary = summary;
    const schedule = normalizeDailySummarySchedule(obj.hubDailySummarySchedule);
    if (schedule) result.hubDailySummarySchedule = schedule;
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
 * **This is a full replacement, field by field.** `stored` is built from an
 * empty object and written with a single whole-column `UPDATE` — it never
 * reads the existing row. So a field the caller omits (or passes as
 * `undefined` / an empty collection) is *absent from the write*, not
 * inherited from what was there before. That is precisely what makes
 * clearing work: expanding the last collapsed project passes
 * `sidebarCollapsedProjects: undefined` and the key disappears from the
 * persisted JSON.
 *
 * Do not "optimize" this into a merge over the current row. Every clear in
 * the system would silently become a no-op, and the damage would only
 * surface on a later GET still serving the stale value. Pinned by the
 * raw-column tests at the end of `user-preferences-store.test.ts`.
 *
 * Callers that only want to update a single sub-map should use
 * `mergeUserPreferencesJson` instead so they don't wipe the untouched maps.
 */
export function replaceUserPreferencesJson(userId: string, prefs: UserPreferencesStored): void {
  const stored: Record<string, unknown> = {};
  if (prefs.agentEngineOverrides && Object.keys(prefs.agentEngineOverrides).length > 0) {
    stored.agentEngineOverrides = prefs.agentEngineOverrides;
  }
  if (prefs.agentModelOverrides && Object.keys(prefs.agentModelOverrides).length > 0) {
    stored.agentModelOverrides = prefs.agentModelOverrides;
  }
  if (typeof prefs.todoAutoCompleteOnPromote === 'boolean') {
    stored.todoAutoCompleteOnPromote = prefs.todoAutoCompleteOnPromote;
  }
  if (prefs.sidebarCollapsedProjects && prefs.sidebarCollapsedProjects.length > 0) {
    stored.sidebarCollapsedProjects = prefs.sidebarCollapsedProjects;
  }
  if (prefs.hubDailySummary) {
    stored.hubDailySummary = prefs.hubDailySummary;
  }
  if (prefs.hubDailySummarySchedule) {
    stored.hubDailySummarySchedule = prefs.hubDailySummarySchedule;
  }
  const json = Object.keys(stored).length > 0 ? JSON.stringify(stored) : null;
  getOrgsDb().prepare('UPDATE users SET preferences_json = ? WHERE id = ?').run(json, userId);
}

/**
 * Read-modify-write `preferences_json` **atomically**.
 *
 * `mutate` receives the currently stored preferences and returns the full
 * replacement. The read and the write run inside a single IMMEDIATE
 * transaction, so the row is write-locked before the read: two concurrent
 * mutations serialize instead of both reading the same base and the later
 * write silently discarding the earlier one.
 *
 * Within one process better-sqlite3's synchronous API already prevents
 * interleaving (there is no `await` between read and write), but that is an
 * accident of the driver, not a guarantee of the endpoint contract — and it
 * says nothing about a second Hub process or an external writer sharing
 * `orgs.db`. Any route advertising "merges server-side" must go through here.
 *
 * A throwing `mutate` aborts the transaction, leaving the row untouched — use
 * that to reject a mutation (e.g. an over-cap list) without a partial write.
 */
export function mutateUserPreferencesJson(
  userId: string,
  mutate: (current: UserPreferencesStored) => UserPreferencesStored,
): UserPreferencesStored {
  const run = getOrgsDb().transaction((id: string) => {
    const next = mutate(getUserPreferencesRow(id));
    replaceUserPreferencesJson(id, next);
    return next;
  });
  // `.immediate()` takes the write lock up front (BEGIN IMMEDIATE) rather than
  // upgrading a read lock mid-transaction, which under WAL would surface as a
  // SQLITE_BUSY snapshot conflict on the write instead of just waiting.
  return run.immediate(userId) as UserPreferencesStored;
}

/**
 * Replace only the sub-maps that `partial` mentions, preserving the rest
 * of the user's preferences. A key set to `undefined` leaves that sub-map
 * untouched; a key set to an empty object clears it. Use this from the
 * per-feature PUT routes so two unrelated preferences don't stomp each
 * other.
 *
 * Atomic — see {@link mutateUserPreferencesJson}. Note this only protects the
 * sub-maps `partial` does NOT mention; a caller that computes a new value from
 * a value it read earlier still has its own read-modify-write to close, and
 * should call `mutateUserPreferencesJson` directly instead.
 */
export function mergeUserPreferencesJson(
  userId: string,
  partial: UserPreferencesStored,
): UserPreferencesStored {
  return mutateUserPreferencesJson(userId, (current) => mergePreferences(current, partial));
}

/** Pure sub-map merge shared by {@link mergeUserPreferencesJson}. */
function mergePreferences(
  current: UserPreferencesStored,
  partial: UserPreferencesStored,
): UserPreferencesStored {
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
  if (partial.todoAutoCompleteOnPromote !== undefined) {
    next.todoAutoCompleteOnPromote = partial.todoAutoCompleteOnPromote;
  }
  if (partial.sidebarCollapsedProjects !== undefined) {
    next.sidebarCollapsedProjects = partial.sidebarCollapsedProjects.length
      ? partial.sidebarCollapsedProjects
      : undefined;
  }
  if ('hubDailySummary' in partial) {
    next.hubDailySummary = normalizeHubDailySummary(partial.hubDailySummary);
  }
  if ('hubDailySummarySchedule' in partial) {
    next.hubDailySummarySchedule = normalizeDailySummarySchedule(partial.hubDailySummarySchedule);
  }
  return next;
}

/**
 * Every user with a persisted Hub Daily Summary schedule. Scans only rows whose
 * JSON blob mentions the key so the once-a-minute ticker doesn't parse every
 * user row on every tick.
 */
export function listUsersWithDailySummarySchedule(): Array<{
  userId: string;
  schedule: HubDailySummarySchedule;
}> {
  const rows = getOrgsDb()
    .prepare(
      "SELECT id, preferences_json FROM users WHERE preferences_json LIKE '%hubDailySummarySchedule%'",
    )
    .all() as Array<{ id: string; preferences_json: string | null }>;
  const out: Array<{ userId: string; schedule: HubDailySummarySchedule }> = [];
  for (const row of rows) {
    const prefs = parsePrefsJson(row.preferences_json ?? null);
    if (prefs.hubDailySummarySchedule) {
      out.push({ userId: row.id, schedule: prefs.hubDailySummarySchedule });
    }
  }
  return out;
}
