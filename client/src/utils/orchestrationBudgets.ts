/**
 * ReAct / host orchestration budget fields (mirror server/orchestration-budgets.ts).
 * Empty string or undefined for a field means "do not send" (keep existing server value).
 * Placeholders show DEFAULT_ORCHESTRATION_BUDGETS so empty inputs still reveal the live cap.
 */

export const DEFAULT_ORCHESTRATION_BUDGETS = {
  maxContinuationDepth: 0,
  maxReactWallClockMs: 0,
  maxReactModelTurns: 0,
  maxReactActionsPerTurn: 8,
  maxWikiRagCallsPerSession: 16,
  maxWebSearchCallsPerSession: 16,
} as const;

export const ORCHESTRATION_FIELD_META = [
  {
    key: 'maxContinuationDepth',
    label: 'Max continuation depth',
    hint: '0 = unlimited',
    placeholder: `${DEFAULT_ORCHESTRATION_BUDGETS.maxContinuationDepth} unlimited`,
  },
  {
    key: 'maxReactWallClockMs',
    label: 'Max chain wall clock (ms)',
    hint: '0 = unlimited',
    placeholder: `${DEFAULT_ORCHESTRATION_BUDGETS.maxReactWallClockMs} unlimited`,
  },
  {
    key: 'maxReactModelTurns',
    label: 'Max model turns / chain',
    hint: '0 = unlimited',
    placeholder: `${DEFAULT_ORCHESTRATION_BUDGETS.maxReactModelTurns} unlimited`,
  },
  {
    key: 'maxReactActionsPerTurn',
    label: 'Max ReAct actions / turn',
    hint: 'Default 8, max 12',
    placeholder: `${DEFAULT_ORCHESTRATION_BUDGETS.maxReactActionsPerTurn} default`,
  },
  {
    key: 'maxWikiRagCallsPerSession',
    label: 'Wiki hybrid calls / session',
    hint: 'Default 16',
    placeholder: `${DEFAULT_ORCHESTRATION_BUDGETS.maxWikiRagCallsPerSession} default`,
  },
  {
    key: 'maxWebSearchCallsPerSession',
    label: 'Web search calls / session',
    hint: 'Default 16',
    placeholder: `${DEFAULT_ORCHESTRATION_BUDGETS.maxWebSearchCallsPerSession} default`,
  },
];

const KEYS = ORCHESTRATION_FIELD_META.map((m: any) => m.key);

function parseOptInt(raw: any) {
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
export function buildOrchestrationBudgetsPayload(fields: any) {
  if (!fields || typeof fields !== 'object') return null;
  /** @type {Record<string, number>} */
  const out: Record<string, any> = {};
  for (const k of KEYS) {
    const v = parseOptInt(fields[k]);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * @param {Record<string, unknown>|undefined|null} saved — from project.orchestrationBudgets
 */
export function orchestrationFieldsFromProject(saved: any) {
  const o = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const f: Record<string, any> = {};
  for (const k of KEYS) {
    f[k] = o[k] != null && o[k] !== '' ? String(o[k]) : '';
  }
  return f;
}

/**
 * @param {string|null|undefined} json — epic.orchestration_budgets_json
 */
export function orchestrationFieldsFromEpicJson(json: any) {
  if (!json || !String(json).trim()) return orchestrationFieldsFromProject(null);
  try {
    const o = JSON.parse(String(json));
    return orchestrationFieldsFromProject(o);
  } catch {
    return orchestrationFieldsFromProject(null);
  }
}
