/**
 * Stream-json events that are intentionally ignored in headless Agent Hub runs.
 * When the parser does not recognize a frame it emits `{ type: 'unknown', text }`;
 * SessionTail used to render those as noisy "unhandled event:" rows.
 *
 * Parser-level suppression (stream-parser.ts) prevents new rows for current types.
 * These regexes only match **legacy** `session_events` rows persisted before that
 * fix — they must stay specific so genuinely new `unknown` types remain visible.
 */

/** @type {RegExp[]} */
export const BENIGN_UNKNOWN_STREAM_TEXT = [
  /^unhandled claude event: (control_request|control_response|sdk_control_request|sdk_control_response)$/,
  // Legacy rows only — current Cursor parser returns [] for interaction_query.
  /^unhandled cursor event: interaction_query$/,
  // Legacy rows only — current Gemini parser maps `init` → `system`.
  /^unhandled gemini event: init$/,
];

/**
 * @param {{ type?: string, text?: string } | null | undefined} event
 * @returns {boolean}
 */
export function isBenignUnknownStreamEvent(event) {
  if (!event || event.type !== 'unknown') return false;
  const text = typeof event.text === 'string' ? event.text : '';
  if (!text) return false;
  return BENIGN_UNKNOWN_STREAM_TEXT.some((re) => re.test(text));
}

/**
 * @param {{ type?: string, text?: string } | null | undefined} event
 * @returns {boolean}
 */
export function shouldSuppressStreamEvent(event) {
  if (!event) return false;
  return isBenignUnknownStreamEvent(event);
}
