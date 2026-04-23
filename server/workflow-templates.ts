/**
 * Template substitution for Hub workflow steps: {{trigger.payload...}} and
 * {{steps.<stepId>.output}}. Pure helpers — used by the sequential runner
 * and unit-tested without DB or spawn.
 */

export type WorkflowTemplateContext = {
  /** Merged default_payload + run_payload (object). */
  triggerPayload: unknown;
  /** Prior step id → assistant text output. */
  stepOutputs: ReadonlyMap<string, string>;
};

const PLACEHOLDER = /\{\{([\s\S]*?)\}\}/g;

function getPath(obj: unknown, path: string[]): string {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined || cur === null) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  try {
    return JSON.stringify(cur);
  } catch {
    return String(cur);
  }
}

/**
 * Replace all `{{ ... }}` placeholders. Supported forms:
 * - `{{trigger.payload}}` — full merged payload as JSON
 * - `{{trigger.payload.a.b}}` — JSON path (dot segments) on the payload object
 * - `{{steps.<step-uuid>.output}}` — prior step assistant output (empty if missing).
 *   `<id>` is one URL-safe segment (UUID-style ids work; dots inside the id are not supported by the matcher).
 */
export function substituteWorkflowTemplate(text: string, ctx: WorkflowTemplateContext): string {
  return text.replace(PLACEHOLDER, (full, inner: string) => {
    const key = String(inner).trim();
    if (!key) return full;

    if (key === 'trigger.payload') {
      try {
        return JSON.stringify(ctx.triggerPayload === undefined ? null : ctx.triggerPayload);
      } catch {
        return '';
      }
    }
    if (key.startsWith('trigger.payload.')) {
      const sub = key.slice('trigger.payload.'.length);
      const segs = sub.split('.').filter((s) => s.length);
      if (!segs.length) return full;
      return getPath(ctx.triggerPayload !== undefined ? ctx.triggerPayload : null, segs);
    }
    // {{steps.<id>.output}}
    const m = /^steps\.([^.\s}]+)\.output$/.exec(key);
    if (m) {
      const stepId = m[1];
      return ctx.stepOutputs.get(stepId) ?? '';
    }
    // Unknown key — leave unchanged so authors see the typo
    return full;
  });
}

/**
 * Shallow-top merge: run payload values override default_payload keys.
 */
export function mergeWorkflowTriggerPayload(
  defaultJson: string,
  runJson: string | null | undefined,
): unknown {
  let def: unknown = {};
  let run: unknown = {};
  try {
    def = defaultJson && defaultJson.trim() ? JSON.parse(defaultJson) : {};
  } catch {
    def = {};
  }
  if (runJson == null || runJson === '') {
    if (def && typeof def === 'object' && !Array.isArray(def)) return { ...(def as object) };
    return def;
  }
  try {
    run = JSON.parse(runJson);
  } catch {
    run = {};
  }
  if (def && typeof def === 'object' && !Array.isArray(def) && def !== null) {
    if (run && typeof run === 'object' && !Array.isArray(run) && run !== null) {
      return { ...def, ...run };
    }
    return { ...def };
  }
  return run;
}
