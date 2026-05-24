export function findUnansweredAskIds(
  messages: ReadonlyArray<{ role?: string | null; content?: string | null }> | null | undefined,
): string[];
