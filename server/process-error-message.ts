// Pick the best error body to surface when a CLI process exits non-zero.
//
// Context (see chat.ts close handler):
//   * stderr is usually authoritative, but Codex writes the harmless line
//     "Reading additional input from stdin..." to stderr on every invocation,
//     even when stdin=ignore. Without filtering, users saw THAT as the error.
//   * Codex emits the real upstream error (e.g. HTTP 400 "model not supported
//     when using Codex with a ChatGPT account") as a JSONL `turn.failed` event
//     on STDOUT, which the stream parser turns into result{isError:true,text}.
//     chat.ts accumulates that text into streamErrorMessage.
//
// Precedence (most specific → most generic):
//   1. stderr with the informational stdin notice stripped
//   2. streamErrorMessage (real upstream error captured from stdout)
//   3. generic "<engine> exited with code <code>"
//
// Keeping this as a pure helper makes it unit-testable without spinning up a
// real child process or the full chat pipeline.

export interface ProcessErrorInputs {
  stderr: string;
  streamErrorMessage: string;
  engine: string;
  exitCode: number | null;
}

/**
 * Known informational/noise lines written to stderr by CLI processes that
 * should NEVER be used as the surfaced error body. Extend as we discover new
 * ones. Matched per-line (trailing newline optional).
 */
const STDERR_NOISE_PATTERNS: RegExp[] = [
  // Codex prints this on every invocation even when stdin is /dev/null.
  /^Reading additional input from stdin\.\.\.\s*$/,
];

/**
 * Strip known informational noise from a stderr buffer, line-by-line.
 * Returns the remaining (meaningful) content, trimmed.
 */
export function stripStderrNoise(stderr: string): string {
  if (!stderr) return '';
  const kept: string[] = [];
  for (const line of stderr.split('\n')) {
    const matchesNoise = STDERR_NOISE_PATTERNS.some((re) => re.test(line));
    if (!matchesNoise) kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * Compose the final error message surfaced to the user + stored on the
 * assistant message. See module docstring for precedence.
 */
export function pickProcessErrorMessage(inputs: ProcessErrorInputs): string {
  const cleanStderr = stripStderrNoise(inputs.stderr);
  if (cleanStderr) return cleanStderr;
  const streamError = inputs.streamErrorMessage.trim();
  if (streamError) return streamError;
  return `${inputs.engine} exited with code ${inputs.exitCode}`;
}
