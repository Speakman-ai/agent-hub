/**
 * ReAct / host orchestration budget fields (mirror server/orchestration-budgets.ts).
 * Empty string or undefined for a field means "do not send" (keep existing server value).
 */

export const ORCHESTRATION_FIELD_META = [
  { key: 'maxContinuationDepth', label: 'Max continuation depth', hint: 'Default 4' },
  { key: 'maxReactWallClockMs', label: 'Max chain wall clock (ms)', hint: '0 = unlimited' },
  { key: 'maxReactModelTurns', label: 'Max model turns / chain', hint: '0 = depth only' },
  { key: 'maxReactActionsPerTurn', label: 'Max ReAct actions / turn', hint: 'Default 6, max 12' },
  { key: 'maxWikiRagCallsPerSession', label: 'Wiki hybrid calls / session', hint: 'Default 10' },
  { key: 'maxWebSearchCallsPerSession', label: 'Web search calls / session', hint: 'Default 8' },
];

const KEYS = ORCHESTRATION_FIELD_META.map((m) => m.key);

function parseOptInt(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === '') return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {Record<string, string|number|undefined>} fields — keyed by server field names
 * @returns {Record<string, number>|null}
 */
export function buildOrchestrationBudgetsPayload(fields) {
  if (!fields || typeof fields !== 'object') return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of KEYS) {
    const v = parseOptInt(fields[k]);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * @param {Record<string, unknown>|undefined|null} saved — from project.orchestrationBudgets
 */
export function orchestrationFieldsFromProject(saved) {
  const o = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const f = {};
  for (const k of KEYS) {
    f[k] = o[k] != null && o[k] !== '' ? String(o[k]) : '';
  }
  return f;
}

/**
 * @param {string|null|undefined} json — epic.orchestration_budgets_json
 */
export function orchestrationFieldsFromEpicJson(json) {
  if (!json || !String(json).trim()) return orchestrationFieldsFromProject(null);
  try {
    const o = JSON.parse(String(json));
    return orchestrationFieldsFromProject(o);
  } catch {
    return orchestrationFieldsFromProject(null);
  }
}
