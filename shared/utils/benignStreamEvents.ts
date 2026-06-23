export interface BenignStreamEventLike {
  type?: string;
  text?: string;
}

export const BENIGN_UNKNOWN_STREAM_TEXT: RegExp[] = [
  /^unhandled claude event: (control_request|control_response|sdk_control_request|sdk_control_response)$/,
  /^unhandled cursor event: interaction_query$/,
  /^unhandled gemini event: init$/,
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
