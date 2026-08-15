export interface BenignStreamEventLike {
  type?: string;
  text?: string;
}

export const BENIGN_UNKNOWN_STREAM_TEXT: RegExp[] = [
  /^unhandled claude event: (control_request|control_response|sdk_control_request|sdk_control_response|tool_progress)$/,
  /^unhandled cursor event: interaction_query$/,
  /^unhandled gemini event: init$/,
  // Grok's unhandled fallback dumps JSON.stringify(raw).slice(0, 200), so the
  // persisted text is `unhandled grok event: {"type":"plan",...}` rather than
  // just the type name. Anchor the type key so `plan_approval` / `planning`
  // still surface as real parser gaps.
  /^unhandled grok event: \{"type":"plan"([,}]|$)/,
];

export function isBenignUnknownStreamEvent(
  event: BenignStreamEventLike | null | undefined,
): boolean {
  if (!event || event.type !== 'unknown') return false;
  const text = typeof event.text === 'string' ? event.text : '';
  if (!text) return false;
  return BENIGN_UNKNOWN_STREAM_TEXT.some((re) => re.test(text));
}

export function shouldSuppressStreamEvent(
  event: BenignStreamEventLike | null | undefined,
): boolean {
  if (!event) return true;
  return isBenignUnknownStreamEvent(event);
}
