/**
 * runner-teardown.ts — recognise a Finalize runner that was torn down mid
 * `docker exec`, as distinct from a genuine test/build failure.
 *
 * When a runner container's job context is cancelled while a step's
 * `docker exec` is in flight — an OOM kill on a memory-capped job, an EC2
 * Spot reclaim, a lost runner, or a whole-run abort that catches one
 * still-running job — the docker CLI prints Go's `context.Canceled` sentinel
 * ("context canceled") to stderr and the exec exits non-zero. The step
 * runner's close handler only sees `exitCode !== 0`, so without help it
 * classifies this as a CI-class `step_failed`: it does NOT auto-retry and it
 * DOES dispatch a wasted fix round to the agent with every test green.
 *
 * This module exposes TWO predicates over the same signature, deliberately at
 * different strictnesses because the two consumers have different blast radii:
 *
 *   - Layer A — {@link isRunnerTeardownExit} (STRICT). Drives reclassification
 *     to `infra_error` in the step runner, which changes behavior: it skips the
 *     fix round and triggers the orchestrator's one-auto-retry on a fresh
 *     runner. Because a false positive would auto-retry a genuine red, this is
 *     conservative — the Go sentinel must be the TERMINAL output AND there must
 *     be no test-failure summary anywhere we captured.
 *   - Layer B — {@link looksLikeRunnerTeardownForHint} (BROAD). Drives only an
 *     advisory hint in the fix-dispatch body ("if you can't find a real
 *     failure, ignore it"). It is intentionally looser than Layer A — the
 *     sentinel may appear as a full line ANYWHERE, not only the terminal
 *     window — precisely so it catches teardowns whose sentinel Layer A's
 *     terminal-window gate rejects (e.g. a runner-agent that appends several
 *     epilogue lines after docker's). Since the hint is conditional and never
 *     suppresses CI, a looser match is safe.
 *
 * BOTH predicates share the same hard guardrail: a test/build that genuinely
 * failed carries its `N failed` / `FAIL` / ✗ / `error TS` summary, so it is
 * never treated as a teardown by either layer.
 */

/** Strip SGR color codes (ESC[…m) so the matchers see plain text. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\[[0-9;]*m/g, '');
}

/**
 * Go's `context.Canceled.Error()` string, emitted verbatim by the docker CLI
 * (and our runner-agent) when a job/exec context is cancelled. Anchored to the
 * whole trimmed line so a test that merely mentions the phrase in prose, or a
 * stack frame that contains it, does not trip the detector.
 */
export const RUNNER_TEARDOWN_SENTINEL_RE = /^context canceled$/;

/**
 * A test/build runner's own failure SUMMARY. Intentionally STRICTER than the
 * step runner's `FAILURE_SIGNAL_RE`: that regex also fires on benign
 * `console.error("…Error…")` lines that PASSING error-handling tests
 * legitimately emit (e.g. vitest's "Failed to load skills: Error: 500"), which
 * would make "no failure signal" useless as a teardown discriminator. We key
 * only off markers a runner prints when a test/build actually FAILED.
 */
export const TEST_FAILURE_SUMMARY_RE = new RegExp(
  [
    '\\b\\d+ failed\\b', // vitest / jest summary: "3 failed"
    '\\b\\d+ failing\\b', // mocha summary: "1 failing"
    '\\bFAIL\\b', // vitest / jest per-file: "FAIL src/x.test.ts"
    '\\bFAILED\\b', // pytest / generic upper-case
    '[\\u2717\\u2718\\u2716\\u2715]', // ✗ ✘ ✖ ✕ failed-test bullets
    '^\\d+\\) ', // mocha numbered failure block
    'error TS\\d', // tsc type error
  ].join('|'),
);

/** How many terminal non-empty lines may carry the sentinel. */
const TERMINAL_WINDOW = 3;

export interface RunnerTeardownInput {
  /** Trailing-N-line snapshot of the step's mixed stdout+stderr. */
  outputTail?: string[];
  /** Signal-aware failure excerpt (may contain benign Error lines). */
  failureExcerpt?: string[];
}

/** Strip ANSI + trim, dropping blank lines. */
function cleanNonEmpty(lines: string[] | undefined): string[] {
  return (lines ?? []).map((l) => stripAnsi(l).trim()).filter((l) => l.length > 0);
}

/**
 * The shared hard guardrail for BOTH layers: a real test-failure summary
 * anywhere we captured (excerpt or tail) means this is a genuine red, never a
 * teardown. Scanning the excerpt matters because that is where a `FAIL` line is
 * most likely retained even when the tail has scrolled past it.
 */
function hasTestFailureSummary(input: RunnerTeardownInput): boolean {
  const haystack = [...(input.failureExcerpt ?? []), ...(input.outputTail ?? [])].map((l) =>
    stripAnsi(l).trim(),
  );
  return haystack.some((l) => TEST_FAILURE_SUMMARY_RE.test(l));
}

/**
 * Layer A (STRICT). True when a non-zero step exit looks like a runner teardown
 * rather than a genuine failure: the Go `context canceled` sentinel is the
 * TERMINAL output AND no test-failure summary appears anywhere we captured.
 * Drives reclassification to `infra_error`, so it is conservative — a false
 * positive would auto-retry a genuine red.
 *
 * Caller contract: only invoke on an already-non-zero exit. The timeout and
 * spawn-error paths are classified earlier and never reach here, so this
 * function does not re-check the exit code.
 */
export function isRunnerTeardownExit(input: RunnerTeardownInput): boolean {
  const nonEmptyTail = cleanNonEmpty(input.outputTail);
  if (nonEmptyTail.length === 0) return false;

  // The sentinel must be among the last few non-empty lines — a teardown
  // appends it after whatever the runner last streamed. (The runner-agent can
  // add a status line or two after docker's, so we scan a small terminal
  // window rather than only the very last line.)
  const terminal = nonEmptyTail.slice(-TERMINAL_WINDOW);
  if (!terminal.some((l) => RUNNER_TEARDOWN_SENTINEL_RE.test(l))) return false;

  return !hasTestFailureSummary(input);
}

/**
 * Layer B (BROAD). True when the captured output merely LOOKS like a runner
 * teardown: the `context canceled` sentinel appears as a full line ANYWHERE in
 * the tail (not just the terminal window) AND no test-failure summary appears.
 *
 * Intentionally looser than {@link isRunnerTeardownExit} so it covers the
 * exact case the strict detector misses — a teardown whose sentinel is not in
 * the terminal window because the runner-agent appended several epilogue lines
 * after docker's. This only gates an advisory, conditional hint in the
 * fix-dispatch body (never CI pass/fail), so the looser match is safe; the
 * shared failure-summary guardrail still keeps it off genuine reds.
 */
export function looksLikeRunnerTeardownForHint(input: RunnerTeardownInput): boolean {
  const lines = cleanNonEmpty(input.outputTail);
  if (lines.length === 0) return false;
  if (!lines.some((l) => RUNNER_TEARDOWN_SENTINEL_RE.test(l))) return false;
  return !hasTestFailureSummary(input);
}

/**
 * Hint prepended to a §7 fix-dispatch body when the failed step looks like a
 * runner teardown (Layer B). Layer A reclassifies clean teardowns as
 * `infra_error` before they ever reach dispatch; this is the safety net for
 * any signature Layer A's tight detector doesn't catch — it still costs the
 * round, but tells the agent not to chase a phantom failure.
 */
export const RUNNER_TEARDOWN_DISPATCH_HINT =
  'NOTE: this step ended with the Go "context canceled" sentinel and no test-failure ' +
  'summary, which means the CI runner was torn down mid-run (an OOM on a memory-capped ' +
  'runner, an EC2 Spot reclaim, or a lost runner) — NOT a test that failed. If you cannot ' +
  'find a real assertion or build failure in the output below, do NOT attempt a code fix: ' +
  'there is nothing to change. The pipeline re-runs automatically when your turn ends, which ' +
  'clears a one-off teardown. Only dig deeper if this recurs at the same step across re-runs.';
