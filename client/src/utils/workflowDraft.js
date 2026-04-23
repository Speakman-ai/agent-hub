/**
 * Normalized draft snapshot for dirty detection (Hub workflow builder).
 * @param {{ name: string, trigger_type: string, default_payload_str: string, steps: object[], cron_mode: string, cron_expr: string, webhook_enabled: boolean, kanban_trigger_column_id: string }} d
 */
export const WORKFLOW_CRON_PRESET_LABELS = {
  off: 'Off (manual runs only)',
  every_15_min: 'Every 15 minutes (UTC)',
  every_hour: 'Every hour (UTC)',
  daily_midnight_utc: 'Daily at 00:00 UTC',
  weekdays_9am_utc: 'Weekdays at 09:00 UTC',
  custom: 'Custom expression…',
};

/** Option order in the Triggers &gt; Schedule dropdown. */
export const WORKFLOW_CRON_MODES_ORDER = [
  'off',
  'every_15_min',
  'every_hour',
  'daily_midnight_utc',
  'weekdays_9am_utc',
  'custom',
];

/** Preset id → node-cron expression (must match server `CRON_PRESETS`). */
const PRESET_TO_EXPR = {
  every_15_min: '*/15 * * * *',
  every_hour: '0 * * * *',
  daily_midnight_utc: '0 0 * * *',
  weekdays_9am_utc: '0 9 * * 1-5',
};

function inferCronFromApi(row) {
  const ex =
    row?.cron_expr != null && String(row.cron_expr).trim() ? String(row.cron_expr).trim() : '';
  if (!ex) {
    return { cron_mode: 'off', cron_expr: '' };
  }
  for (const [k, v] of Object.entries(PRESET_TO_EXPR)) {
    if (v === ex) {
      return { cron_mode: k, cron_expr: ex };
    }
  }
  return { cron_mode: 'custom', cron_expr: ex };
}

export function workflowDraftSnapshot(d) {
  const steps = (d.steps || []).map((s) => ({
    id: String(s.id || ''),
    agent_id: String(s.agent_id || ''),
    step_project_id: String(s.step_project_id || ''),
    title: String(s.title || ''),
    role_prompt: String(s.role_prompt || ''),
    step_order: Number(s.step_order) || 0,
    timeout_ms: s.timeout_ms == null ? null : Number(s.timeout_ms),
    on_failure: String(s.on_failure || 'abort'),
  }));
  steps.sort((a, b) => a.step_order - b.step_order);
  return JSON.stringify({
    name: String(d.name || '').trim(),
    trigger_type: String(d.trigger_type || 'manual'),
    default_payload_str: String(d.default_payload_str ?? '{}'),
    steps,
    cron_mode: String(d.cron_mode || 'off'),
    cron_expr: String(d.cron_expr || ''),
    webhook_enabled: Boolean(d.webhook_enabled),
    kanban_trigger_column_id: String(d.kanban_trigger_column_id || ''),
  });
}

/**
 * @param {object} apiWorkflow — GET /workflows/:id response
 */
export function workflowFromApi(apiWorkflow) {
  const dp = apiWorkflow?.default_payload;
  let default_payload_str = '{}';
  if (typeof dp === 'string') {
    default_payload_str = dp;
  } else if (dp != null && typeof dp === 'object') {
    try {
      default_payload_str = JSON.stringify(dp, null, 2);
    } catch {
      default_payload_str = '{}';
    }
  }
  const rawSteps = Array.isArray(apiWorkflow?.steps) ? apiWorkflow.steps : [];
  const steps = [...rawSteps]
    .sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))
    .map((s, idx) => ({
      id: String(s.id || ''),
      agent_id: String(s.agent_id || ''),
      step_project_id:
        s.step_project_id != null && String(s.step_project_id).trim()
          ? String(s.step_project_id).trim()
          : '',
      title: String(s.title || ''),
      role_prompt: String(s.role_prompt || ''),
      step_order: idx,
      timeout_ms: s.timeout_ms == null ? null : Number(s.timeout_ms),
      on_failure: String(s.on_failure || 'abort'),
    }));
  const { cron_mode, cron_expr } = inferCronFromApi(apiWorkflow);
  const trigCol = apiWorkflow?.trigger_column_id;
  return {
    name: String(apiWorkflow?.name || '').trim() || 'Untitled workflow',
    trigger_type: String(apiWorkflow?.trigger_type || 'manual'),
    default_payload_str,
    steps,
    cron_mode,
    cron_expr,
    webhook_enabled: Boolean(apiWorkflow?.webhook_path_token && apiWorkflow?.webhook_secret_set),
    kanban_trigger_column_id: trigCol ? String(trigCol) : '',
  };
}

/**
 * @param {{ name: string, trigger_type: string, default_payload_str: string, steps: object[], cron_mode: string, cron_expr: string, webhook_enabled: boolean, kanban_trigger_column_id: string }} draft
 * @returns {object} API body for PUT/POST
 */
export function draftToPutBody(draft) {
  let defaultPayload;
  try {
    defaultPayload = JSON.parse(draft.default_payload_str || '{}');
  } catch {
    defaultPayload = {};
  }
  const steps = (draft.steps || []).map((s, i) => ({
    id: s.id || undefined,
    agentId: s.agent_id,
    stepProjectId: (() => {
      const raw = s.step_project_id;
      if (raw == null || raw === '') return null;
      const t = String(raw).trim();
      return t.length ? t : null;
    })(),
    title: s.title,
    rolePrompt: s.role_prompt,
    stepOrder: i,
    timeoutMs: (() => {
      if (s.timeout_ms == null) return null;
      const n = Number(s.timeout_ms);
      return Number.isFinite(n) ? Math.floor(n) : null;
    })(),
    onFailure: s.on_failure || 'abort',
  }));

  const mode = String(draft.cron_mode || 'off');
  let cronExpr;
  let cronPreset;
  if (mode === 'off') {
    cronExpr = null;
  } else if (mode === 'custom') {
    const t = String(draft.cron_expr || '').trim();
    cronExpr = t.length ? t : null;
  } else {
    cronPreset = mode;
  }

  const colRaw = draft.kanban_trigger_column_id;
  const trimmed = typeof colRaw === 'string' && String(colRaw).trim() ? String(colRaw).trim() : '';

  return {
    name: draft.name.trim(),
    triggerType: draft.trigger_type || 'manual',
    defaultPayload,
    steps,
    cronExpr,
    cronPreset,
    webhookEnabled: Boolean(draft.webhook_enabled),
    triggerColumnId: trimmed.length ? trimmed : null,
  };
}
