/**
 * Normalized draft snapshot for dirty detection (Hub workflow builder).
 * @param {{ name: string, trigger_type: string, default_payload_str: string, steps: object[] }} d
 */
export function workflowDraftSnapshot(d) {
  const steps = (d.steps || []).map((s) => ({
    id: String(s.id || ''),
    agent_id: String(s.agent_id || ''),
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
      title: String(s.title || ''),
      role_prompt: String(s.role_prompt || ''),
      step_order: idx,
      timeout_ms: s.timeout_ms == null ? null : Number(s.timeout_ms),
      on_failure: String(s.on_failure || 'abort'),
    }));
  return {
    name: String(apiWorkflow?.name || '').trim() || 'Untitled workflow',
    trigger_type: String(apiWorkflow?.trigger_type || 'manual'),
    default_payload_str,
    steps,
  };
}

/**
 * @param {{ name: string, trigger_type: string, default_payload_str: string, steps: object[] }} draft
 * @returns {{ name: string, triggerType: string, defaultPayload: unknown, steps: object[] }}
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
  return {
    name: draft.name.trim(),
    triggerType: draft.trigger_type || 'manual',
    defaultPayload,
    steps,
  };
}
