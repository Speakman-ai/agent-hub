/**
 * Outer PAV orchestration helpers for the persisted task-plan sidebar.
 */

/**
 * @param {Record<string, unknown>|null|undefined} session
 * @returns {string} Pretty-printed JSON for the textarea, or '' when absent.
 */
export function orchestrationMetaTextFromSession(session) {
  const om = session?.orchestrationMeta;
  const raw = session?.orchestration_meta;
  if (om && typeof om === 'object' && !Array.isArray(om)) {
    try {
      return JSON.stringify(om, null, 2);
    } catch {
      return '';
    }
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return '';
}

/**
 * Validates orchestration meta from the textarea before PUT.
 * Empty / whitespace-only string → `{ ok: true, meta: null }`.
 *
 * @param {string} text
 * @returns {{ ok: true, meta: Record<string, unknown>|null } | { ok: false, reason: 'invalid_json'|'not_plain_object' }}
 */
export function parseOrchestrationMetaForSave(text) {
  const mt = typeof text === 'string' ? text.trim() : '';
  if (!mt) return { ok: true, meta: null };
  try {
    const metaPayload = JSON.parse(mt);
    if (typeof metaPayload !== 'object' || metaPayload === null || Array.isArray(metaPayload)) {
      return { ok: false, reason: 'not_plain_object' };
    }
    return { ok: true, meta: metaPayload };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
