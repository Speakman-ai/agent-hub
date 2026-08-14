/**
 * step-workspace-permission.ts — recognise a permission-denied failure rooted at
 * the CI workspace mount so it is not mistaken for a genuine test/build failure.
 *
 * ## The problem
 *
 * The Finalize job container bind-mounts the session worktree at
 * {@link FINALIZE_RUNNER_WORKSPACE} (`/github/workspace`) and runs every step as
 * the `runner` user (uid 1000). When the process that materialized that worktree
 * owns the files as a DIFFERENT uid — the classic rollout skew where an older
 * runner-agent image left `runner` on uid 1001 while the job image pins it to
 * 1000 (see `worktree-job-ownership.ts`) — the bind mount is effectively
 * read-only to the job. The very first `npm ci` / `pip install` / `python3 -m
 * venv` then dies at the INSTALL step, before any test runs, with:
 *
 *     npm error code EACCES
 *     npm error syscall mkdir
 *     npm error path /github/workspace/node_modules
 *     npm error errno -13
 *
 * That non-zero exit would otherwise be classified `step_failed` — a genuine red
 * the fix-dispatch loop chases as if the change set broke a build. It didn't: NO
 * branch edit can make the mount writable. Chasing it burns fix rounds and
 * eventually reports a misleading `fix_no_progress` (the failure is identical
 * every round because the cause is the runner host, not the code).
 *
 * This module recognises that signature so the step-runner can tag the outcome
 * infra-class (`runner_workspace_unwritable`) and let the §10 auto-retry re-run
 * the job on a fresh runner — which clears the rollout-window race once the fleet
 * finishes pulling the uid-aligned image — instead of presenting an unfixable
 * infra fault as a real failure. If it recurs, the run terminates `infra_error`
 * with a retrigger affordance rather than livelocking the fix loop.
 *
 * ## Avoiding false positives
 *
 * The permission signal must be ASSOCIATED with the workspace path, not merely
 * co-present somewhere in the output — otherwise a step that logs its cwd as
 * `/github/workspace` and then fails `EACCES` on an UNRELATED path (`/usr/local`,
 * `$HOME`, …) would be misclassified, masking a genuine failure and triggering
 * pointless infra retries. Association is required one of two ways:
 *
 *   1. **Same diagnostic line** — one line carries both the permission signal and
 *      a workspace-rooted path. This is the shape of every non-npm tool (a shell
 *      `mkdir: … '/github/workspace/…': Permission denied`, Python's
 *      `PermissionError: [Errno 13] Permission denied: '/github/workspace/…'`) and
 *      of npm's own combined line (`Error: EACCES: permission denied, mkdir
 *      '/github/workspace/node_modules'`); or
 *   2. **One npm error record** — npm prints a failure as a block of structured
 *      `npm error <field> <value>` lines. A workspace-rooted `npm error path`
 *      field paired with an `npm error code EACCES`/`EPERM` (or `errno -13`) field
 *      is a single error record whose offending syscall path IS the workspace.
 *      This covers a truncated tail that kept the structured fields but dropped
 *      the combined `Error:` line. The `npm error` prefix keeps ordinary output
 *      (a cwd log, a test that prints the path) from ever satisfying this rule.
 *
 * An `EACCES` whose path is `/usr/local/…` never matches either rule even when a
 * `/github/workspace` cwd line is also present. The step-runner additionally gates
 * this detector behind the shared `hasTestFailureSummary` guardrail, so a genuine
 * red that merely mentions these tokens is never masked. Pure / synchronous / no
 * I/O — safe to call from the step-runner hot path and trivially unit-testable.
 */
import { FINALIZE_RUNNER_WORKSPACE } from './runner-images.js';

/**
 * A permission-denied signal from any toolchain: Node/npm (`EACCES`,
 * `errno -13`), Python (`PermissionError: [Errno 13]`), or a bare shell
 * (`Permission denied`). `EPERM` (errno -1) is the operation-not-permitted
 * sibling that ownership/mount faults also surface.
 */
const PERMISSION_DENIED_RE = /\bEACCES\b|\bEPERM\b|\berrno\s+-?13\b|permission denied/i;

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A path token rooted at the workspace mount: the escaped mount root followed by
 * a real path boundary (a separator `/`, a quote, whitespace, `:`, or a closing
 * bracket) or end-of-line. The boundary stops `/github/workspace-backup` or
 * `/github/workspaceX` from matching the `/github/workspace` mount.
 */
const WORKSPACE_PATH_RE = new RegExp(
  `${escapeRegExp(FINALIZE_RUNNER_WORKSPACE)}(?:/|['"\\s:)\\]]|$)`,
);

/**
 * npm's structured `npm error path <value>` field whose value is rooted at the
 * workspace mount. The same boundary as {@link WORKSPACE_PATH_RE} (a separator or
 * end) keeps `/github/workspace-backup` out; the field is unquoted, so no closing
 * quote is expected.
 */
const NPM_WORKSPACE_PATH_FIELD_RE = new RegExp(
  `^npm error path\\s+${escapeRegExp(FINALIZE_RUNNER_WORKSPACE)}(?:/|$)`,
  'i',
);

/** npm's structured permission-code field: `npm error code EACCES|EPERM` / `errno -13`. */
const NPM_PERMISSION_FIELD_RE = /^npm error (?:code E(?:ACCES|PERM)\b|errno\s+-?13\b)/i;

/** Any `npm error …` diagnostic line (field lines and bare spacer lines alike). */
const NPM_ERROR_LINE_RE = /^npm error\b/i;

/** Strip SGR ANSI colour codes so a coloured `EACCES` still matches. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\[[0-9;]*m/g, '');
}

/**
 * Strip ANSI and trim each line, PRESERVING blank lines. Record parsing needs the
 * blanks — a real blank line is a boundary between two npm error blocks — so this
 * must NOT drop them (dropping them would merge two blocks into one record and let
 * a code field from one pair with a path field from the next).
 */
function trimLines(src: readonly string[] | undefined): string[] {
  return (src ?? []).map((l) => stripAnsi(l).trim());
}

/**
 * True when some SINGLE contiguous npm error record within `lines` carries BOTH a
 * workspace-rooted `npm error path` field and an `npm error code EACCES`/`errno
 * -13` field. npm prints a failure as a maximal run of consecutive `npm error …`
 * lines, broken by ANY line that is not one — including a blank line, which npm
 * emits between two separate error blocks. A bare `npm error` line (the prefix
 * with no field) stays IN the record; a truly blank line breaks it. Requiring
 * both fields in the SAME run stops a workspace-path field from one record pairing
 * with a permission field from a different record (e.g. an EACCES on `~/.npm`
 * followed by a separate non-permission record whose path is the workspace).
 * Caller passes ONE output window with blanks preserved, so records never span the
 * tail/excerpt boundary or a blank-line separator.
 */
function npmRecordAssociatesWorkspacePermission(lines: readonly string[]): boolean {
  let inRecord = false;
  let hasWorkspacePath = false;
  let hasPermissionCode = false;
  // Reset per-record accumulators; return whether the record just closed matched.
  const closeRecord = (): boolean => {
    const matched = inRecord && hasWorkspacePath && hasPermissionCode;
    inRecord = false;
    hasWorkspacePath = false;
    hasPermissionCode = false;
    return matched;
  };
  for (const line of lines) {
    if (NPM_ERROR_LINE_RE.test(line)) {
      inRecord = true;
      if (NPM_WORKSPACE_PATH_FIELD_RE.test(line)) hasWorkspacePath = true;
      if (NPM_PERMISSION_FIELD_RE.test(line)) hasPermissionCode = true;
    } else if (closeRecord()) {
      return true;
    }
  }
  return closeRecord();
}

/**
 * Decide whether a non-zero step exit is a CI workspace permission fault (the
 * bind-mounted `/github/workspace` is not writable by the job's `runner` user)
 * rather than a genuine failure.
 *
 * The permission signal must be ASSOCIATED with the workspace path (same line, or
 * one npm error record) — never merely co-present — so an `EACCES` on an unrelated
 * path is not misclassified because the workspace appears elsewhere (e.g. a cwd
 * log). The caller must only invoke this on an already-non-zero exit (the timeout
 * / spawn-error paths are classified earlier) and should gate it behind
 * `hasTestFailureSummary` so a genuine red that mentions these tokens stays
 * CI-class.
 *
 * @param tail    chronological trailing lines the step emitted (last = newest).
 * @param excerpt optional failure-excerpt lines (context around the first
 *                failure signal).
 */
export function isRunnerWorkspacePermissionError(args: {
  tail: readonly string[];
  excerpt?: readonly string[];
}): boolean {
  // Blanks are preserved (they are npm record boundaries — see trimLines).
  const tailLines = trimLines(args.tail);
  const excerptLines = trimLines(args.excerpt);
  const nonBlank = [...tailLines, ...excerptLines].filter((l) => l.length > 0);
  if (nonBlank.length === 0) return false;

  // Rule 1: a single diagnostic line carries BOTH the permission signal and a
  // workspace-rooted path (shell / Python / npm's combined `Error:` line). This
  // is per-line, so scanning tail + excerpt together (blanks dropped) is safe.
  if (nonBlank.some((l) => PERMISSION_DENIED_RE.test(l) && WORKSPACE_PATH_RE.test(l))) {
    return true;
  }

  // Rule 2: ONE contiguous npm error record carries both a workspace-rooted
  // `npm error path` field and an `npm error code EACCES`/`errno -13` field.
  // Parsed within each output window independently (blanks preserved as record
  // boundaries) so a field from a different record — or a different window (tail
  // vs excerpt) — can never pair.
  return (
    npmRecordAssociatesWorkspacePermission(tailLines) ||
    npmRecordAssociatesWorkspacePermission(excerptLines)
  );
}
