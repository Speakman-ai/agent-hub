// Static analyzer that scores each route file's OpenAPI coverage.
//
// For every `server/routes/<name>.ts` we count two things:
//
//   handlers       — `router.<method>(...)` call sites that mount an actual
//                    HTTP handler (the Express side of the surface).
//   registrations  — `registry.registerPath(...)` call sites that document
//                    the same surface in the Zod-to-OpenAPI registry.
//                    Registrations may live inline in the route file OR in
//                    the sibling `<name>.openapi.ts` companion file.
//
// The function is pure: it takes raw source text and returns a numeric
// summary. The CLI wrapper at `scripts/check-openapi-coverage.ts` is the
// only piece that touches the filesystem. The unit test lives next door
// at `server/openapi-coverage.test.ts`.
//
// Ratchet model:
//   Per-file `allowed_unregistered` baselines live in
//   `scripts/openapi-coverage-baseline.json`. The CI check fails when
//   `unregistered > allowed` for any file, so:
//     - You can never *increase* the documentation debt of an already-
//       migrated file by adding a new route without a registerPath.
//     - You can never introduce a brand-new route file without either
//       documenting every handler or adding it to the baseline (which is
//       a deliberate, reviewable change).
//     - Files still pending migration carry their existing debt until
//       their migration card lands, then the baseline ratchets down to
//       zero.

/**
 * Count occurrences of `router.<method>(` where `<method>` is one of the
 * HTTP verbs we route on. Comments and string literals are intentionally
 * NOT stripped — the regex is anchored on `\b` and the `(` that follows,
 * which makes false positives effectively impossible in this codebase
 * (route files don't talk about routers in prose or strings). Keeping
 * the matcher dumb avoids pulling in a full TS parser.
 */
export function countHandlers(source: string): number {
  const re = /\brouter\.(get|post|put|delete|patch)\s*\(/g;
  let count = 0;
  while (re.exec(source) !== null) {
    count++;
  }
  return count;
}

/**
 * Count `registerPath(` call sites. Files use two equivalent calling
 * conventions:
 *
 *   import { registerPath } from '../openapi/registry.js';
 *   registerPath({ ... });            // bare function call
 *
 *   import { registry } from '../openapi/registry.js';
 *   registry.registerPath({ ... });   // member access
 *
 * The `\b` boundary at the start matches both: a preceding `.` (non-word
 * char) is a boundary, and the start-of-token in the bare call is too.
 * It deliberately won't match `foo_registerPath(` or `xregisterPath(`.
 *
 * The import statement itself also matches the bare `registerPath(`
 * pattern — except imports use brace lists (`{ registerPath,` / `, registerPath }`)
 * followed by `,`/`}` rather than `(`. The `\(` requirement filters them
 * out.
 *
 * A single `registerPath` documents one operation, so the count is
 * comparable to the handler count above.
 */
export function countRegistrations(source: string): number {
  const re = /\bregisterPath\s*\(/g;
  let count = 0;
  while (re.exec(source) !== null) {
    count++;
  }
  return count;
}

export interface FileCoverage {
  /** Bare route module name, e.g. `board` for `server/routes/board.ts`. */
  name: string;
  /** Number of router.<verb>() handler mounts in the route file. */
  handlers: number;
  /** Number of registerPath() calls in the route file itself. */
  inlineRegistrations: number;
  /**
   * Number of registerPath() calls in the sibling `<name>.openapi.ts`
   * companion file (null if no companion file exists).
   */
  companionRegistrations: number | null;
  /** inlineRegistrations + (companionRegistrations ?? 0). */
  totalRegistrations: number;
  /** max(0, handlers - totalRegistrations). */
  unregistered: number;
}

/**
 * Score a single route module given its raw source plus (optionally) the
 * raw source of its `.openapi.ts` companion. Pass `null` for `companion`
 * when no companion file exists; pass `''` when the file exists but is
 * empty (so the caller can distinguish "no file" from "empty file" later,
 * even though the score is the same).
 */
export function analyzeFile(
  name: string,
  routeSrc: string,
  companion: string | null,
): FileCoverage {
  const handlers = countHandlers(routeSrc);
  const inlineRegistrations = countRegistrations(routeSrc);
  const companionRegistrations = companion === null ? null : countRegistrations(companion);
  const totalRegistrations = inlineRegistrations + (companionRegistrations ?? 0);
  const unregistered = Math.max(0, handlers - totalRegistrations);
  return {
    name,
    handlers,
    inlineRegistrations,
    companionRegistrations,
    totalRegistrations,
    unregistered,
  };
}

export interface BaselineEntry {
  /** Number of handlers we currently allow to be undocumented in this file. */
  allowed_unregistered: number;
  /** Human-readable note explaining the exemption (usually a migration card id). */
  note?: string;
}

export interface Baseline {
  [routeName: string]: BaselineEntry;
}

export type CoverageVerdict =
  | { kind: 'ok'; file: FileCoverage; allowed: number }
  | { kind: 'slack'; file: FileCoverage; allowed: number; surplus: number }
  | { kind: 'fail'; file: FileCoverage; allowed: number; overflow: number };

/**
 * Compare a single file's measured coverage against its baseline entry.
 *
 *   ok    — exactly at baseline (or both zero).
 *   slack — under baseline; we could ratchet the baseline down. Non-fatal
 *           in CI but worth surfacing so contributors lower the debt.
 *   fail  — over baseline; a new undocumented handler appeared. Fatal.
 */
export function compareWithBaseline(file: FileCoverage, baseline: Baseline): CoverageVerdict {
  const allowed = baseline[file.name]?.allowed_unregistered ?? 0;
  if (file.unregistered > allowed) {
    return { kind: 'fail', file, allowed, overflow: file.unregistered - allowed };
  }
  if (file.unregistered < allowed) {
    return { kind: 'slack', file, allowed, surplus: allowed - file.unregistered };
  }
  return { kind: 'ok', file, allowed };
}
