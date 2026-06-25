/**
 * Generation bookkeeping for "latest result wins" async loads that can overlap
 * (an initial/foreground load, a manual refresh, and a silent background poll).
 *
 * The naive approach — stamp a sequence at request *start* and ignore any
 * completion whose stamp isn't the latest — is wrong when a newer request can
 * fail without producing replacement data: a silent poll that bumps the
 * sequence and then fails would invalidate an older foreground request that
 * later succeeds, leaving the UI with no data and no error.
 *
 * So invalidation is keyed on *commit order*, not *start order*. A result is
 * committed unless a strictly newer request has **already committed** a
 * replacement. A request that never commits (e.g. a suppressed silent failure)
 * leaves the high-water mark untouched, so an older in-flight foreground result
 * is still allowed to land.
 *
 * Pure on purpose: no React/DOM, so it unit-tests with no environment. Callers
 * hold the state in a ref and combine `canCommit()` with their own mounted ref.
 */
export interface RequestGenerationState {
  /** Monotonic id handed to each request at start. */
  startSeq: number;
  /** Highest id that has actually committed a result (the high-water mark). */
  commitSeq: number;
  /** Id of the foreground request that currently owns the loading spinner. */
  loadingSeq: number;
}

export function createRequestGenerationState(): RequestGenerationState {
  return { startSeq: 0, commitSeq: 0, loadingSeq: 0 };
}

export interface RequestHandle {
  /** This request's unique, monotonically increasing id. */
  reqId: number;
  /**
   * True if no strictly newer request has already committed a result — i.e.
   * this request is still allowed to write its outcome.
   */
  canCommit: () => boolean;
  /**
   * Record this request as the latest committed result (advances the
   * high-water mark). Call only when actually writing data/error to state.
   */
  commit: () => void;
  /**
   * True if this is the foreground request that currently owns the spinner
   * (no newer foreground request has started). Always false for silent
   * requests, which never take spinner ownership.
   */
  ownsLoading: () => boolean;
}

/**
 * Begin a request against `state`. Non-silent (foreground) requests take
 * ownership of the loading spinner; silent (background) requests do not.
 */
export function beginRequest(
  state: RequestGenerationState,
  opts: { silent?: boolean } = {},
): RequestHandle {
  const reqId = ++state.startSeq;
  if (!opts.silent) state.loadingSeq = reqId;
  return {
    reqId,
    canCommit: () => reqId > state.commitSeq,
    commit: () => {
      if (reqId > state.commitSeq) state.commitSeq = reqId;
    },
    ownsLoading: () => state.loadingSeq === reqId,
  };
}
