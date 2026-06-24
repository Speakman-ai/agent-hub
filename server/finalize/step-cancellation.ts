/**
 * step-cancellation.ts — recognise runner-cancellation collateral in a failed
 * CI step's output so it is not mistaken for a genuine test failure.
 *
 * ## The problem
 *
 * A finalize CI step that shells out to a Go binary (docker, docker compose,
 * buildx, kubectl, gh …) prints the canonical Go context error —
 * `context canceled` (or, on a deadline, `context deadline exceeded`) — when
 * the work it was doing is torn down out from under it: the runner container
 * is being recycled, the inner dockerd was killed, an EC2 Spot reclaim is in
 * flight, or a sibling/run cancellation cut the environment. The process then
 * exits NON-ZERO (usually 1), so {@link runStepsSequence} would otherwise
 * classify it as a genuine `step_failed` — a red the fix-dispatch loop chases
 * as if the change set broke a test. It didn't: the step was *cancelled*, not
 * failed. (See the matching note in `ci-config-v2.ts` about collateral
 * `context canceled` shards "recording a misleading non-zero exit code" so the
 * agent can't tell the genuine red from the cascade noise.)
 *
 * This module recognises that signature so the step-runner can tag the outcome
 * `runner_cancelled` (infra-class) and let the §10 auto-retry re-run it on a
 * fresh runner instead of presenting collateral as a real failure.
 *
 * ## Avoiding false positives
 *
 * An application test may legitimately print "context canceled" in its own
 * assertion output. Masking a real failure as collateral would be worse than
 * the bug we're fixing, so the match is deliberately narrow. A step is treated
 * as cancellation collateral only when EITHER:
 *
 *   1. its output carries an unmistakable Docker-daemon connection-loss marker
 *      (`error during connect`, `Cannot connect to the Docker daemon`, …) AND a
 *      Go cancellation phrase — the classic "the daemon went away mid-command"
 *      shape. This is the ONLY rule that accepts `context deadline exceeded`,
 *      because the corroborating daemon-loss marker disambiguates it from an
 *      ordinary operation timeout; or
 *   2. the step's TERMINAL line ENDS on the Go `context.Canceled` error — i.e.
 *      the process died ON the cancellation. This covers both the bare error
 *      (`context canceled`) and the final link of a Go error chain
 *      (`Unable to connect to the server: context canceled`, the shape kubectl
 *      / gh / other Go CLIs print). Build-wrapper exit-propagation noise
 *      (`make: *** [test] Error 1`, `npm ERR!`, `+ exit 1`) is stripped off the
 *      end first, so a non-Docker tool wrapped by `make`/`npm` is still
 *      recognised even though its true last line is buried under the wrapper's
 *      `Error 1`. Rule 2 does NOT accept a bare `context deadline exceeded`:
 *      `context.DeadlineExceeded` is what Go CLIs print for a genuine,
 *      deterministic operation/API timeout (a real, fixable step failure), so
 *      treating it as collateral here would auto-retry a real red into an
 *      eventual infra failure. A deadline is collateral only via Rule 1.
 *
 * A test that prints "context canceled" somewhere in the middle and then fails
 * a real assertion does NOT match: after stripping wrapper noise its last line
 * is the assertion, not the cancellation. Nor does an assertion/log line that
 * merely ENDS on the words (`AssertionError: expected ok, got context
 * canceled`) — the cancellation must be the line's tail AND be preceded by
 * start-of-line or a `:` error-wrap separator (the Go `fmt.Errorf("...: %w")`
 * convention), never bare whitespace or a quote. Pure / synchronous / no I/O —
 * safe to call from the step-runner hot path and trivially unit-testable.
 */

/** Go's `context.Canceled` / `context.DeadlineExceeded` error strings. */
const CANCEL_PHRASE_RE = /context\s+(?:canceled|cancelled|deadline\s+exceeded)\b/i;

/**
 * Unmistakable Docker-daemon connection-loss markers. These are emitted by the
 * docker CLI (and compose/buildx, which embed it) only when the daemon socket
 * is gone — never by ordinary application/test output. Verified against the
 * Docker CLI error surface (`error during connect` / `Cannot connect to the
 * Docker daemon`).
 */
const DAEMON_LOSS_RE =
  /(error during connect|cannot connect to the docker daemon|is the docker daemon running|the docker daemon (?:is not running|is unreachable))/i;

/**
 * A line whose tail IS the Go cancellation error — i.e. the line ENDS on
 * `context canceled` (allowing trailing punctuation), whether bare
 * (`context canceled`) or as the final link of a Go error chain
 * (`Unable to connect to the server: context canceled`, the shape kubectl / gh
 * / other Go CLIs print via `fmt.Errorf("...: %w", err)`).
 *
 * The phrase must be preceded by **start-of-line or a `:` error-wrap
 * separator** — NOT by bare whitespace. A plain space before the phrase is the
 * signature of an assertion/log sentence that merely ends on the words
 * (`AssertionError: expected ok, got context canceled`, `expected context
 * canceled`), which is a GENUINE failure and must stay visible to the fix loop.
 * Requiring the colon-wrap (or line start) keeps those out while still matching
 * every real Go error chain, whose convention is exactly `prefix: context
 * canceled`.
 *
 * DELIBERATELY excludes `context deadline exceeded` (`context.DeadlineExceeded`).
 * A deadline is ambiguous: Go CLIs print that exact string for an ordinary
 * operation/API timeout (an HTTP client deadline, a `--timeout` flag that really
 * expired) that is a REAL, deterministic, fixable step failure — not runner
 * teardown. Auto-retrying those as infra would launder a genuine red into an
 * eventual infra failure. A deadline only counts as collateral when corroborated
 * by an unmistakable daemon-loss marker (Rule 1 below), never on the bare
 * terminal line.
 */
const CANCEL_TERMINAL_RE = /(?:^|:)\s*context\s+(?:canceled|cancelled)['".)\]\s]*$/i;

/**
 * Build-wrapper exit-propagation noise: lines a wrapper (`make`, npm/pnpm/yarn,
 * shell `set -x`) prints AFTER a child exits non-zero, carrying only the exit
 * code, never substantive failure detail. We strip these off the END of a
 * step's output so the "did it die on a cancellation?" check sees the real last
 * line — the tool's own error — not the wrapper's `Error 1`. Without this, a
 * non-Docker Go tool (kubectl/gh) that prints `context canceled` and is then
 * wrapped by `make`/`npm` would slip through as a genuine `step_failed`.
 */
const WRAPPER_EXIT_NOISE_RES: RegExp[] = [
  /^make(?:\[\d+\])?:\s+\*\*\*/i, // make: *** [test] Error 1  /  make[1]: *** ... Stop.
  /^npm (?:err!|error)(?:\s|$)/i, // npm ERR! ...  /  npm error ...
  /^(?:yarn )?error Command failed with exit code/i, // yarn / npm-script wrapper
  /^error:?\s+script\s+".*"\s+(?:exited|failed)/i, // bun / pnpm lifecycle
  /^elifecycle\b/i, // npm ELIFECYCLE
  /^\+\s*exit\s+\d+\b/i, // shell `set -x` -> `+ exit 1`
  /^command failed with exit code \d+/i,
];

function meaningfulLines(lines: readonly string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

function isWrapperExitNoise(line: string): boolean {
  return WRAPPER_EXIT_NOISE_RES.some((re) => re.test(line));
}

/** Drop trailing build-wrapper exit-propagation lines from a tail. */
function stripTrailingWrapperNoise(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && isWrapperExitNoise(lines[end - 1] as string)) end -= 1;
  return lines.slice(0, end);
}

/**
 * Decide whether a non-zero step exit is runner-cancellation collateral rather
 * than a genuine failure.
 *
 * @param tail    chronological trailing lines the step emitted (last = newest).
 * @param excerpt optional failure-excerpt lines (context around the first
 *                failure signal); scanned only for the daemon-loss co-occurrence
 *                rule, never for the terminal-line rule.
 */
export function isRunnerCancellationCollateral(args: {
  tail: readonly string[];
  excerpt?: readonly string[];
}): boolean {
  const tailLines = meaningfulLines(args.tail);
  if (tailLines.length === 0) return false;

  const scan = [...tailLines, ...meaningfulLines(args.excerpt ?? [])];
  if (!scan.some((l) => CANCEL_PHRASE_RE.test(l))) return false;

  // Rule 1: the daemon connection was lost mid-command. This is the only rule
  // that accepts `context deadline exceeded` — the corroborating daemon-loss
  // marker disambiguates a torn-down runner from an ordinary operation timeout.
  if (scan.some((l) => DAEMON_LOSS_RE.test(l))) return true;

  // Rule 2: the step died ON the `context.Canceled` error. The tool's own last
  // line is the cancellation — possibly followed by build-wrapper exit noise
  // (`make: *** Error 1`, `npm ERR!`) which we strip first so the wrapped
  // non-Docker case (kubectl/gh under make/npm) is still recognised. A bare
  // `context deadline exceeded` does NOT match here (CANCEL_TERMINAL_RE excludes
  // it): a deterministic timeout is a real, fixable failure, not collateral.
  const substantive = stripTrailingWrapperNoise(tailLines);
  const last = substantive[substantive.length - 1];
  return last !== undefined && CANCEL_TERMINAL_RE.test(last);
}
