export type AssistantStreamBuffers = { finalText: string; partialFallback: string };

/**
 * Combined buffer passed to delegation kickoff from `chat.ts` `handleEvent` for
 * `assistant_text`. Must stay in sync with stream accumulation: finalized
 * assistant text plus any in-flight partial buffer (see `createStreamParser` /
 * `event.partial`).
 */
export function accumulateAssistantStreamForDelegateKickoff(
  finalText: string,
  partialFallback: string,
): string {
  return (finalText || '') + (partialFallback || '');
}

/**
 * Applies one `assistant_text` chunk the same way as `chat.ts` `handleEvent`
 * mutates `finalText` / `partialFallback`. Exported for tests so kickoff timing
 * matches production without importing the full chat handler.
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
 * derive the string passed to `tryKickoffDelegationFromStream`. `chat.ts` must
 * use this so tests can lock the wiring.
 */
export function applyAssistantTextChunkForDelegationKickoff(
  state: AssistantStreamBuffers,
  chunk: string,
  partial: boolean,
): { next: AssistantStreamBuffers; accumulatedForKickoff: string } {
  const next = foldAssistantTextChunk(state, chunk, partial);
  const accumulatedForKickoff = accumulateAssistantStreamForDelegateKickoff(
    next.finalText,
    next.partialFallback,
  );
  return { next, accumulatedForKickoff };
}

/** Pure plan for proc `close` delegation branch (lead + sub-agents only — caller filters). */
export function planDelegationRoundOnProcClose(args: {
  delegateTasks: { length: number } | null | undefined;
  hadEarlyDelegationPromise: boolean;
}): { mode: 'skip' } | { mode: 'delegate'; startIfNeeded: boolean } {
  const hasDelegate = !!(args.delegateTasks && args.delegateTasks.length > 0);
  if (!hasDelegate && !args.hadEarlyDelegationPromise) return { mode: 'skip' };
  return {
    mode: 'delegate',
    startIfNeeded: hasDelegate && !args.hadEarlyDelegationPromise,
  };
}
