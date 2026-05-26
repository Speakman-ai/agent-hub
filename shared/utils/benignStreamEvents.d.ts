export const BENIGN_UNKNOWN_STREAM_TEXT: RegExp[];

export function isBenignUnknownStreamEvent(
  event: { type?: string; text?: string } | null | undefined,
): boolean;

export function shouldSuppressStreamEvent(
  event: { type?: string; text?: string } | null | undefined,
): boolean;
