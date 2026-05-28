/**
 * trivial-conflict-resolver.ts — programmatic resolution for mechanical
 * git-rebase conflicts that don't need a human (or an LLM) to mediate.
 *
 * Scope at Phase 1 (intentionally narrow — see wiki:
 * `finalize-code-changes-architecture-v0` §3 for the surrounding flow):
 *
 *   1. **Whitespace-only** — both sides of a `<<<<<<< / ======= / >>>>>>>`
 *      block normalize to identical text after stripping only the
 *      *leading* indentation and *trailing* whitespace from each line.
 *      Interior whitespace (including inside string / template literals)
 *      is preserved verbatim so a `"a   b"` vs `"a b"` difference is not
 *      silently merged away. Pick "ours" once the sides match.
 *
 *   2. **Import-order** — the conflict hunk consists exclusively of
 *      ES / CommonJS `import` lines (or `require(...)` lines), and **no
 *      side-effect-only import** (`import './foo'`) appears in either
 *      side. Side-effect imports are order-sensitive (CSS cascade,
 *      polyfill init), so any side-effect line in the hunk forces us to
 *      fall through to the dispatch path rather than re-sort.
 *      Otherwise: sort the union alphabetically and replace the hunk.
 *      Mixing imports with logic also bails for the same conservative
 *      reason.
 *
 *   3. **package-lock.json regeneration** — any conflict in `package-lock.json`
 *      (or `npm-shrinkwrap.json`) is auto-resolved by re-running
 *      `npm install --package-lock-only --ignore-scripts` against the
 *      rebased `package.json`. `--ignore-scripts` is explicit (npm's
 *      `--package-lock-only` already skips lifecycle scripts, but the
 *      flag makes the no-code-execution guarantee unambiguous now that
 *      we run this against a freshly-rebased file).
 *
 * Out of scope: language-aware AST merges, semantic merges, import dedup
 * across `import * as`, semantic whitespace decisions inside string
 * literals. The resolver is intentionally conservative; ambiguous cases
 * fall through to the agent dispatch path in `rebase.ts`.
 *
 * Pure functions live in this module. The rebase orchestrator owns the
 * `git add` / `git rebase --continue` plumbing; we only return what to
 * write back to the working tree.
 *
 * Line-ending note: {@link replaceHunks} reads via `/\r?\n/` and writes
 * back with `\n`, which means a CRLF source file is normalized to LF on
 * write. Harmless on this LF-only repo; document in case the resolver is
 * ever pulled into a CRLF tree.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Conflict hunk shape extracted from a single file. `ours` is the local
 * (rebased) side — the side above the `=======` marker in a `git rebase`
 * conflict — and `theirs` is the incoming side (the commit being replayed).
 */
export interface ConflictHunk {
  /** Zero-indexed start line in the conflict-marked file. */
  start: number;
  /** Zero-indexed end line (inclusive of the closing `>>>>>>>` marker). */
  end: number;
  ours: string[];
  theirs: string[];
}

/** Result of resolving (or refusing to resolve) one file. */
export interface FileResolution {
  path: string;
  /**
   * `'whitespace'` | `'import-order'` | `'lockfile'` describe which branch
   * fired. `'non-trivial'` means we declined — caller dispatches to the
   * session agent.
   */
  kind: 'whitespace' | 'import-order' | 'lockfile' | 'non-trivial';
  /** New file body to write back. Absent for non-trivial. */
  resolvedText?: string;
  /** Hunks the resolver could not handle (for the dispatch message body). */
  unresolved?: ConflictHunk[];
}

const CONFLICT_START_RE = /^<{7} /;
const CONFLICT_MID_RE = /^={7}\s*$/;
const CONFLICT_END_RE = /^>{7} /;
/**
 * Match `import …;`, `import …` (no semi), and CommonJS `const x = require(...)`
 * — both leading whitespace tolerant. Side-effect imports (`import './x';`)
 * are included by the first branch and explicitly rejected by
 * {@link SIDE_EFFECT_IMPORT_RE} before the import-order branch fires.
 */
const IMPORT_LINE_RE =
  /^\s*(import\s.+|const\s+[^=]+=\s*require\s*\([^)]+\)\s*;?\s*|require\s*\([^)]+\)\s*;?\s*)$/;
/**
 * Match a bare side-effect import — `import './polyfill'`,
 * `import "reset.css"`, etc. The presence of any such line in either
 * side of an import-order hunk forces a refusal because alphabetical
 * reordering changes runtime behavior (CSS cascade order, polyfill init
 * order, eager module side effects).
 */
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"][^'"]+['"]\s*;?\s*$/;
/**
 * Bare CommonJS `require('x')` statements are likewise side-effect
 * invocations — their evaluation order matters. We catch them
 * alongside `import './x'` so the import-order branch can refuse them.
 */
const SIDE_EFFECT_REQUIRE_RE = /^\s*require\s*\(\s*['"][^'"]+['"]\s*\)\s*;?\s*$/;

const LOCKFILE_BASENAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

/**
 * Parse a file body into hunks. A "hunk" is the span from a
 * `<<<<<<<` line through the matching `>>>>>>>` line. Nested or malformed
 * conflict markers (rare; usually a sign of a prior bad merge committed)
 * cause the parser to return `null` so the caller falls through to the
 * non-trivial path rather than attempting a half-baked resolution.
 */
export function parseConflictHunks(text: string): ConflictHunk[] | null {
  const lines = text.split(/\r?\n/);
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!CONFLICT_START_RE.test(line)) {
      i += 1;
      continue;
    }
    const start = i;
    const ours: string[] = [];
    const theirs: string[] = [];
    let phase: 'ours' | 'theirs' = 'ours';
    let closed = false;
    i += 1;
    while (i < lines.length) {
      const inner = lines[i];
      if (CONFLICT_START_RE.test(inner)) {
        // Nested conflict — bail.
        return null;
      }
      if (CONFLICT_MID_RE.test(inner)) {
        if (phase !== 'ours') return null; // Two `=======` in one hunk.
        phase = 'theirs';
        i += 1;
        continue;
      }
      if (CONFLICT_END_RE.test(inner)) {
        closed = true;
        i += 1;
        break;
      }
      if (phase === 'ours') ours.push(inner);
      else theirs.push(inner);
      i += 1;
    }
    if (!closed) return null;
    hunks.push({ start, end: i - 1, ours, theirs });
  }
  return hunks;
}

/**
 * Normalize a line for whitespace-only comparison: strip *leading*
 * indentation and *trailing* whitespace, but preserve interior
 * whitespace verbatim. This is deliberately narrower than the original
 * implementation: a previous version collapsed all interior whitespace
 * runs to a single space, which silently considered string-literal
 * differences (e.g. `"a   b"` vs `"a b"`) as trivial and resolved them
 * by keeping "ours". The actual trivial cases the rebase phase needs to
 * cover are tabs-vs-spaces in indentation and trailing whitespace on
 * otherwise-identical lines — both of which `trim()` already collapses.
 *
 * Exported so tests can pin the rule rather than re-deriving it from
 * {@link resolveWhitespace}.
 */
export function normalizeWhitespace(line: string): string {
  return line.trim();
}

/**
 * Whitespace-only resolution. Returns the resolved text or `null` when at
 * least one hunk has a semantic difference (after whitespace
 * normalization). All hunks must be whitespace-only for this to succeed —
 * we don't mix-and-match strategies inside a single file.
 */
export function resolveWhitespace(text: string, hunks: ConflictHunk[]): string | null {
  for (const h of hunks) {
    const ours = h.ours.map(normalizeWhitespace).join('\n');
    const theirs = h.theirs.map(normalizeWhitespace).join('\n');
    if (ours !== theirs) return null;
  }
  return replaceHunks(text, hunks, (h) => h.ours);
}

/**
 * Import-order resolution. Both sides must consist entirely of
 * import-shape lines (plus blank lines, which are passed through) AND
 * contain no bare side-effect imports. The union is sorted alphabetically
 * and deduped before write-back.
 *
 * Side-effect imports (`import './polyfill'`, `import 'reset.css'`,
 * `require('./register')`) are *not* safely reorderable — the import
 * statement's evaluation is the point, and alphabetical sorting silently
 * changes CSS cascade order / polyfill init order / module-eval order.
 * Their presence in either side of a hunk forces the resolver to refuse;
 * the conflict falls through to the dispatch path.
 */
export function resolveImportOrder(text: string, hunks: ConflictHunk[]): string | null {
  for (const h of hunks) {
    if (!isImportOnly(h.ours) || !isImportOnly(h.theirs)) return null;
    if (containsSideEffectImport(h.ours) || containsSideEffectImport(h.theirs)) return null;
  }
  return replaceHunks(text, hunks, (h) => {
    const merged = new Map<string, string>();
    for (const line of [...h.ours, ...h.theirs]) {
      const key = line.trim();
      if (!key) continue;
      // First-write-wins on identical keys; trims trailing whitespace.
      if (!merged.has(key)) merged.set(key, line.trimEnd());
    }
    return [...merged.values()].sort((a, b) => a.trim().localeCompare(b.trim()));
  });
}

function isImportOnly(lines: string[]): boolean {
  let sawImport = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (!IMPORT_LINE_RE.test(line)) return false;
    sawImport = true;
  }
  return sawImport;
}

/** True if any non-blank line is a bare side-effect import / require. */
function containsSideEffectImport(lines: string[]): boolean {
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (SIDE_EFFECT_IMPORT_RE.test(line) || SIDE_EFFECT_REQUIRE_RE.test(line)) return true;
  }
  return false;
}

/**
 * Replace each hunk span (start…end inclusive) in the original text with
 * the lines returned by `pick(hunk)`. Hunks are processed in reverse so
 * line numbers stay stable across edits.
 */
function replaceHunks(
  text: string,
  hunks: ConflictHunk[],
  pick: (h: ConflictHunk) => string[],
): string {
  const lines = text.split(/\r?\n/);
  const ordered = [...hunks].sort((a, b) => b.start - a.start);
  for (const h of ordered) {
    const replacement = pick(h);
    lines.splice(h.start, h.end - h.start + 1, ...replacement);
  }
  return lines.join('\n');
}

/** True for files the lockfile-regeneration branch handles. */
export function isLockfilePath(filePath: string): boolean {
  const base = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
  return LOCKFILE_BASENAMES.has(base);
}

/**
 * Regenerate `package-lock.json` in `cwd` against the current `package.json`
 * by running `npm install --package-lock-only --ignore-scripts --no-audit
 * --no-fund`. The `--package-lock-only` flag is the contractually-documented
 * "rebuild the lockfile without touching node_modules" entry point — we
 * want the orchestrator's behavior to be reproducible regardless of
 * whether the worktree has a populated `node_modules/` (it often won't).
 *
 * `--ignore-scripts` is explicit even though `--package-lock-only` already
 * skips lifecycle scripts in current npm. The function runs against a
 * freshly-rebased `package.json` that may have picked up new dependencies
 * since the agent last vetted the tree; making the no-code-execution
 * guarantee opt-in via flag insulates us from any future npm behavior
 * change.
 *
 * On success the caller still owes a `git add <lockfile>`; this function
 * only manages npm.
 */
export async function regenerateLockfile(
  cwd: string,
  opts: { runNpm?: typeof execFileAsync; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const run = opts.runNpm ?? execFileAsync;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  try {
    await run(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd,
        env: opts.env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}

/**
 * Resolve a single file's conflicts. Composes the parser + the three
 * branches in priority order: lockfile > whitespace > import-order >
 * non-trivial.
 *
 * Lockfile is special: we do NOT consult conflict hunks at all. The mere
 * fact that the file is conflicted means we want to regenerate from
 * `package.json`. The caller (rebase.ts) handles the regeneration side
 * effect; this function reports the kind so the orchestrator can choose
 * whether to invoke `regenerateLockfile`.
 */
export function classifyFileResolution(filePath: string, body: string): FileResolution {
  if (isLockfilePath(filePath)) {
    return { path: filePath, kind: 'lockfile' };
  }
  const hunks = parseConflictHunks(body);
  if (!hunks || hunks.length === 0) {
    // No parseable conflicts — treat as non-trivial so the caller flags
    // it. Most likely the file has nested markers from a prior bad merge.
    return { path: filePath, kind: 'non-trivial', unresolved: [] };
  }
  const ws = resolveWhitespace(body, hunks);
  if (ws !== null) return { path: filePath, kind: 'whitespace', resolvedText: ws };
  const imp = resolveImportOrder(body, hunks);
  if (imp !== null) return { path: filePath, kind: 'import-order', resolvedText: imp };
  return { path: filePath, kind: 'non-trivial', unresolved: hunks };
}

export const __test = {
  CONFLICT_START_RE,
  CONFLICT_MID_RE,
  CONFLICT_END_RE,
  IMPORT_LINE_RE,
  SIDE_EFFECT_IMPORT_RE,
  SIDE_EFFECT_REQUIRE_RE,
  LOCKFILE_BASENAMES,
  isImportOnly,
  containsSideEffectImport,
};
