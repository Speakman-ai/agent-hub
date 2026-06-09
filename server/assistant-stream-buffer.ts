export type AssistantStreamBuffers = { finalText: string; partialFallback: string };

/**
 * Combined buffer for assistant stream accumulation: finalized assistant text
 * plus any in-flight partial buffer (see `createStreamParser` / `event.partial`).
 */
export function accumulateAssistantStream(finalText: string, partialFallback: string): string {
  return (finalText || '') + (partialFallback || '');
}

/**
 * Applies one `assistant_text` chunk the same way as `chat.ts` `handleEvent`
 * mutates `finalText` / `partialFallback`.
 */
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

/**
 * Single source of truth for `handleEvent` `assistant_text`: fold buffers, then
 * derive the accumulated visible string. `chat.ts` and `design-chat.ts` must
 * use this so tests can lock the wiring.
 */
export function applyAssistantTextChunk(
  state: AssistantStreamBuffers,
  chunk: string,
  partial: boolean,
  opts?: { replace?: boolean },
): { next: AssistantStreamBuffers; accumulated: string } {
  const next = opts?.replace
    ? { finalText: chunk, partialFallback: '' }
    : foldAssistantTextChunk(state, chunk, partial);
  const accumulated = accumulateAssistantStream(next.finalText, next.partialFallback);
  return { next, accumulated };
}
