export type AssistantStreamBuffers = { finalText: string; partialFallback: string };

/**
 * Return the visible assistant text represented by the finalized text and any
 * in-flight partial buffer (see `createStreamParser` / `event.partial`).
 */
export function accumulateAssistantStream(finalText: string, partialFallback: string): string {
  return (finalText || '') + (partialFallback || '');
}

/** Apply one `assistant_text` chunk to the finalized and partial buffers. */
export function foldAssistantTextChunk(
  state: AssistantStreamBuffers,
  chunk: string,
  partial: boolean,
): AssistantStreamBuffers {
  if (partial) {
    return { finalText: state.finalText, partialFallback: state.partialFallback + chunk };
  }
  return { finalText: state.finalText + chunk, partialFallback: state.partialFallback };
}

/** Fold one `assistant_text` chunk and return the resulting visible text. */
export function applyAssistantTextChunk(
  state: AssistantStreamBuffers,
  chunk: string,
  partial: boolean,
  opts?: { replace?: boolean },
): { next: AssistantStreamBuffers; accumulatedText: string } {
  const next = opts?.replace
    ? { finalText: chunk, partialFallback: '' }
    : foldAssistantTextChunk(state, chunk, partial);
  return {
    next,
    accumulatedText: accumulateAssistantStream(next.finalText, next.partialFallback),
  };
}
