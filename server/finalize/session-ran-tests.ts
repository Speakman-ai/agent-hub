/**
 * Test files a session ran, recovered from its shell `tool_use` rows.
 *
 * This is the cheapest dynamic-selection source (wiki
 * `finalize-dynamic-test-selection-spec`, "Selection sources" 1): agents
 * usually run the tests that cover their change, and every shell command is
 * already persisted in `session_events`. Parsing is deliberately strict.
 * Only explicit file and directory arguments to a recognised runner count, and
 * only when they exist at the final head. Name filters, bare suite runs and
 * anything the parser can't follow add nothing, because the default-branch
 * full run is the backstop for a missed test, not this parser.
 */

import type Database from 'better-sqlite3';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { isTruncatedPayload } from '../session-events-store.js';

const execFileP = promisify(execFile);

/** One shell command as the session issued it. */
export interface SessionShellCommand {
  command: string;
  /** Working directory the engine reported for this command, absolute or repo-relative. */
  cwd?: string;
}

export type TestRunner =
  | 'vitest'
  | 'jest'
  | 'pytest'
  | 'go'
  | 'rspec'
  | 'playwright'
  | 'cypress'
  | 'script';

export interface SessionRanTestPath {
  /** Repo-relative POSIX path. */
  path: string;
  kind: 'file' | 'dir';
  /** Runner of the first command that named this path. */
  runner: TestRunner;
}

/** Answers whether a repo-relative path exists at the final head. */
export type HeadPathLookup = (repoRelPath: string) => 'file' | 'dir' | null;

export interface ExtractSessionRanTestsOptions {
  /** Absolute path of the checkout the session ran in (the worktree). */
  repoRoot: string;
  exists: HeadPathLookup;
}

/** Engine tool names whose input carries a shell command. */
const SHELL_TOOL_NAMES = new Set([
  'Bash',
  'Shell',
  'run_terminal_cmd',
  'run_shell_command',
  'shell',
]);
const COMMAND_KEYS = ['command', 'cmd'] as const;
const CWD_KEYS = ['cwd', 'workingDirectory', 'working_directory', 'directory', 'dir_path'] as const;

/**
 * Shell commands from one session's `tool_use` events, oldest first.
 * Truncated payloads are skipped: the command may be cut, and a cut path
 * could name the wrong file.
 */
export function collectSessionShellCommands(
  db: Database.Database,
  sessionId: string,
): SessionShellCommand[] {
  const rows = db
    .prepare(
      `SELECT e.payload AS payload
         FROM session_events e
         JOIN messages m ON e.parent_kind = 'message' AND e.parent_id = m.id
        WHERE m.session_id = ? AND e.event_type = 'tool_use'
        ORDER BY m.created_at ASC, m.rowid ASC, e.seq ASC`,
    )
    .all(sessionId) as Array<{ payload: string }>;
  const out: SessionShellCommand[] = [];
  for (const row of rows) {
    const cmd = shellCommandFromPayload(row.payload);
    if (cmd) out.push(cmd);
  }
  return out;
}

export function shellCommandFromPayload(payload: string): SessionShellCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || isTruncatedPayload(parsed)) return null;
  const ev = parsed as { tool?: unknown; input?: unknown };
  if (typeof ev.tool !== 'string' || !SHELL_TOOL_NAMES.has(ev.tool)) return null;
  if (!ev.input || typeof ev.input !== 'object') return null;
  const input = ev.input as Record<string, unknown>;
  let command: string | null = null;
  for (const key of COMMAND_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) {
      command = v;
      break;
    }
    if (Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string')) {
      command = (v as string[]).map(shellQuote).join(' ');
      break;
    }
  }
  if (!command) return null;
  for (const key of CWD_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return { command, cwd: v.trim() };
  }
  return { command };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Index of every file and directory at the final head, from `git ls-tree` output. */
export function headPathLookupFromFiles(files: Iterable<string>): HeadPathLookup {
  const fileSet = new Set<string>();
  const dirSet = new Set<string>();
  for (const f of files) {
    if (!f) continue;
    fileSet.add(f);
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const dir = f.slice(0, i);
      if (dirSet.has(dir)) break;
      dirSet.add(dir);
      i = dir.lastIndexOf('/');
    }
  }
  return (p) => (fileSet.has(p) ? 'file' : dirSet.has(p) ? 'dir' : null);
}

/** Tracked files at `ref` in `repoDir`. */
export async function listHeadFiles(repoDir: string, ref = 'HEAD'): Promise<string[]> {
  const { stdout } = await execFileP(
    'git',
    ['-C', repoDir, 'ls-tree', '-r', '-z', '--name-only', ref],
    {
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return stdout.split('\0').filter(Boolean);
}

/** DB + git convenience: the session's ran test paths that exist at `ref`. */
export async function sessionRanTestPaths(args: {
  db: Database.Database;
  sessionId: string;
  repoRoot: string;
  ref?: string;
}): Promise<SessionRanTestPath[]> {
  const commands = collectSessionShellCommands(args.db, args.sessionId);
  if (commands.length === 0) return [];
  const exists = headPathLookupFromFiles(await listHeadFiles(args.repoRoot, args.ref));
  return extractSessionRanTests(commands, { repoRoot: args.repoRoot, exists });
}

// ---------------------------------------------------------------------------
// Shell tokenizing
// ---------------------------------------------------------------------------

export type Token =
  | { kind: 'word'; value: string; dynamic: boolean }
  | { kind: 'op'; value: string };

const OPS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')'];
const REDIRECT_RE = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/;

/**
 * Compound-command syntax the walker doesn't model. A script that uses any of
 * these at a command position is rejected whole rather than half-understood.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

type WordToken = Extract<Token, { kind: 'word' }>;

/** One command in a pipeline: a simple command or a `( ... )` subshell. */
export type ShellCommandNode =
  | { kind: 'simple'; words: WordToken[] }
  | { kind: 'subshell'; list: ShellList };
export type ShellPipeline = ShellCommandNode[];
export interface ShellAndOr {
  first: ShellPipeline;
  rest: Array<{ op: '&&' | '||'; pipeline: ShellPipeline }>;
}
/** Commands separated by `;`, `&` or newlines; `async` marks a `&`-terminated one. */
export type ShellList = Array<{ andOr: ShellAndOr; async: boolean }>;

/**
 * Parse `tokens` into the command-list grammar the walker understands: simple
 * commands and non-empty `( ... )` subshells, joined into pipelines (`|`,
 * `|&`), and-or lists (`&&`, `||`) and lists (`;`, `&`, newline). Returns
 * null for anything else: a dangling or leading operator, unmatched or empty
 * parentheses, a word after `)`, `;;`, or a compound keyword. Those are
 * scripts the shell rejects or that the walker can't follow, so they add
 * nothing.
 */
export function parseShell(tokens: Token[]): ShellList | null {
  let pos = 0;
  const peekOp = (): string | null => {
    const t = tokens[pos];
    return t && t.kind === 'op' ? t.value : null;
  };
  const skipNewlines = () => {
    while (peekOp() === '\n') pos++;
  };

  const parseCommand = (): ShellCommandNode | null => {
    if (peekOp() === '(') {
      pos++;
      const list = parseList(true);
      if (!list || list.length === 0 || peekOp() !== ')') return null;
      pos++;
      if (tokens[pos]?.kind === 'word') return null;
      return { kind: 'subshell', list };
    }
    const words: WordToken[] = [];
    while (tokens[pos]?.kind === 'word') words.push(tokens[pos++] as WordToken);
    if (words.length === 0) return null;
    if (UNSUPPORTED_KEYWORDS.has(words[0].value)) return null;
    return { kind: 'simple', words };
  };

  const parsePipeline = (): ShellPipeline | null => {
    const first = parseCommand();
    if (!first) return null;
    const cmds = [first];
    while (peekOp() === '|' || peekOp() === '|&') {
      pos++;
      skipNewlines();
      const next = parseCommand();
      if (!next) return null;
      cmds.push(next);
    }
    return cmds;
  };

  const parseAndOr = (): ShellAndOr | null => {
    const first = parsePipeline();
    if (!first) return null;
    const rest: ShellAndOr['rest'] = [];
    for (let op = peekOp(); op === '&&' || op === '||'; op = peekOp()) {
      pos++;
      skipNewlines();
      const pipeline = parsePipeline();
      if (!pipeline) return null;
      rest.push({ op, pipeline });
    }
    return { first, rest };
  };

  function parseList(inSubshell: boolean): ShellList | null {
    const list: ShellList = [];
    for (;;) {
      skipNewlines();
      if (pos >= tokens.length || (inSubshell && peekOp() === ')')) return list;
      const andOr = parseAndOr();
      if (!andOr) return null;
      const sep = peekOp();
      if (sep === ';' || sep === '\n' || sep === '&') {
        pos++;
        list.push({ andOr, async: sep === '&' });
      } else if (pos >= tokens.length || (inSubshell && sep === ')')) {
        list.push({ andOr, async: false });
      } else {
        return null;
      }
    }
  }

  const list = parseList(false);
  return list && pos === tokens.length ? list : null;
}

/**
 * A small POSIX-ish tokenizer: quotes, escapes, operators, redirections and
 * comments. Words containing an expansion (`$X`, `$(...)`, backticks) are
 * marked `dynamic` so they never resolve to a path. Redirections and their
 * targets are dropped. Returns null on an unterminated quote.
 */
export function tokenizeShell(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  let word = '';
  let inWord = false;
  let dynamic = false;
  let dropNextWord = false;
  // Here-document delimiters waiting for the end of the current line, whose
  // body is data, never commands.
  let heredocNext: { strip: boolean } | null = null;
  const pendingHeredocs: Array<{ delim: string; strip: boolean }> = [];
  let heredocDynamic = false;

  const flush = () => {
    if (!inWord) return;
    if (heredocNext) {
      if (dynamic) heredocDynamic = true;
      pendingHeredocs.push({ delim: word, strip: heredocNext.strip });
      heredocNext = null;
    } else if (dropNextWord) dropNextWord = false;
    else tokens.push({ kind: 'word', value: word, dynamic });
    word = '';
    inWord = false;
    dynamic = false;
  };

  const skipSubstitution = (start: number): number => {
    // src[start] is '(' after '$'. Skip to the balanced ')'.
    let depth = 0;
    let j = start;
    while (j < n) {
      const c = src[j];
      if (c === '\\') j += 2;
      else if (c === "'") {
        const e = src.indexOf("'", j + 1);
        j = e < 0 ? n : e + 1;
      } else {
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return j + 1;
        j++;
      }
    }
    return -1;
  };

  /** src[start] is '{' after '$'. Index past the matching '}', or -1. */
  const skipBraceExpansion = (start: number): number => {
    let depth = 0;
    for (let j = start; j < n; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return j + 1;
    }
    return -1;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < n) {
        // A literal leading `~` isn't a home dir, but resolution would read it as one.
        if (!inWord && src[i + 1] === '~') dynamic = true;
        word += src[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return null;
      if (!inWord && src[i + 1] === '~') dynamic = true;
      word += src.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      if (!inWord && src[j] === '~') dynamic = true;
      inWord = true;
      for (;;) {
        if (j >= n) return null;
        const d = src[j];
        if (d === '"') break;
        if (d === '\\' && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== '\n') word += src[j + 1];
          j += 2;
          continue;
        }
        if (d === '$' || d === '`') {
          dynamic = true;
          if (d === '$' && (src[j + 1] === '(' || src[j + 1] === '{')) {
            j = src[j + 1] === '(' ? skipSubstitution(j + 1) : skipBraceExpansion(j + 1);
            if (j < 0) return null;
            continue;
          }
          if (d === '`') {
            const e = src.indexOf('`', j + 1);
            if (e < 0) return null;
            j = e + 1;
            continue;
          }
        }
        word += d;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '$' || c === '`') {
      dynamic = true;
      inWord = true;
      if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
        i = src[i + 1] === '(' ? skipSubstitution(i + 1) : skipBraceExpansion(i + 1);
        if (i < 0) return null;
        continue;
      }
      if (c === '`') {
        const e = src.indexOf('`', i + 1);
        if (e < 0) return null;
        i = e + 1;
        continue;
      }
      word += c;
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
      continue;
    }
    // Redirections: [n]op target, where op is one of REDIRECT_RE. Every
    // operator needs a target word (`2>&1` targets `1`); a missing one is a
    // syntax error, so the whole script is rejected.
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
        dynamic = false;
      } else {
        flush();
      }
      if (dropNextWord || heredocNext) return null;
      const rop = REDIRECT_RE.exec(src.slice(i, i + 3))![0];
      i += rop.length;
      if (rop === '<<' || rop === '<<-') heredocNext = { strip: rop === '<<-' };
      else dropNextWord = true;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      flush();
      if (heredocNext || dropNextWord) return null;
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      if (op === '\n' && pendingHeredocs.length > 0) {
        if (heredocDynamic) return null;
        for (const { delim, strip } of pendingHeredocs.splice(0)) {
          for (;;) {
            if (i >= n) return null;
            const nl = src.indexOf('\n', i);
            const end = nl < 0 ? n : nl;
            let line = src.slice(i, end).replace(/\r$/, '');
            if (strip) line = line.replace(/^\t+/, '');
            i = nl < 0 ? n : nl + 1;
            if (line === delim) break;
          }
        }
      }
      continue;
    }
    // Unquoted glob and brace characters expand to words we can't know.
    if (c === '*' || c === '?' || c === '[' || c === '{') dynamic = true;
    word += c;
    inWord = true;
    i++;
  }
  flush();
  // A here-document whose body never started or never ended can't be split
  // from the commands around it.
  if (heredocNext || dropNextWord || pendingHeredocs.length > 0) return null;
  return tokens;
}

// ---------------------------------------------------------------------------
// Command walking
// ---------------------------------------------------------------------------

/**
 * The shell's working directory as an absolute POSIX path, or null when it
 * can't be known (a failed or ambiguous `cd`, an expansion, `popd`, a branch
 * that may or may not have run). Paths never resolve against an unknown cwd.
 */
type Cwd = string | null;

/** Stand-in for `$HOME`: absolute, and never inside a repo. */
const HOME_DIR = '/\0home';

interface RawTestArg {
  runner: TestRunner;
  /** Directory the argument is relative to. */
  base: Cwd;
  arg: string;
  /** Directory the runner treats as its whole suite; an arg resolving here is a bare run. */
  suiteRoot: Cwd;
  /** Discovery bound (vitest `--root`): a kept path must lie inside it. */
  scope?: Cwd;
}

/**
 * Scope of one command. Children (subshells, pipeline elements, background
 * jobs, external programs) get a shallow copy, so they share `out` but their
 * `cwd` and `exited` never leak back.
 */
interface WalkState {
  cwd: Cwd;
  /** False only when the command is known to succeed (`cd` to a known dir, `true`). */
  mayFail: boolean;
  /** True only when the command is known to fail (`false`). */
  mustFail: boolean;
  /** The command ended its shell (`exit`, `exec cmd`). */
  exited: boolean;
  repoRoot: string;
  exists: HeadPathLookup;
  out: RawTestArg[];
  depth: number;
}

/**
 * How a command can end. `ok` / `fail` hold the cwd on the success and
 * failure branches (undefined when that branch is impossible, null when its
 * cwd is unknown); the branches stay separate through `&&` / `||` and merge
 * only where execution rejoins (a list separator or the end of the script).
 */
interface Outcome {
  ok: Cwd | undefined;
  fail: Cwd | undefined;
  /** The shell may have ended (`exit`, `exec cmd`) on some branch. */
  mayExit: boolean;
}

/** Merge two branch cwds that rejoin; undefined is an impossible branch. */
function joinBranch(a: Cwd | undefined, b: Cwd | undefined): Cwd | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a === b ? a : null;
}

/** Cwd where the next list item runs, or undefined when no branch continues. */
function rejoin(o: Outcome): Cwd | undefined {
  return joinBranch(o.ok, o.fail);
}

/**
 * Thrown when a script uses shell machinery the walker doesn't model
 * (`eval`, `source`, `trap`, `set -e`, aliases, a write to `CDPATH`, ...).
 * The whole script then adds nothing and leaves the cwd unknown.
 */
class UnsupportedScript extends Error {}

const MAX_RECURSION = 4;

/**
 * Explicit test paths in `commands` that exist at the final head, de-duplicated
 * and sorted.
 *
 * The walker is closed-world: every bash builtin is either modeled or rejects
 * the script, and wrappers and runners only count in option modes known to
 * run their command. Anything else adds nothing.
 *
 * The working directory follows bash's scoping: only `cd`/`pushd`/`popd` run
 * in the current shell move it; subshells, pipeline elements with a sibling,
 * `&` jobs and external programs (`env -C`, `timeout`, `npm --prefix`, ...)
 * never do. Success is not assumed except for a `cd` whose target is a
 * directory at head (or lies outside the repo), so a cwd that differs between
 * the possible outcomes of `&&` / `||` becomes unknown. `exit` and `exec`
 * end their shell: nothing after them in that shell is collected.
 *
 * Across commands the cwd carries over (Claude Code's shell keeps it); a
 * command with an engine-reported cwd starts there, leaving the repo resets to
 * the root (Claude Code resets it), and an unknown cwd (including after a
 * shell that may have exited) stays unknown until an absolute `cd` or an
 * engine cwd.
 */
export function extractSessionRanTests(
  commands: SessionShellCommand[],
  opts: ExtractSessionRanTestsOptions,
): SessionRanTestPath[] {
  const repoRoot = path.posix.resolve(toPosix(opts.repoRoot));
  const found = new Map<string, SessionRanTestPath>();
  let carried: Cwd = repoRoot;
  for (const cmd of commands) {
    const start: Cwd = cmd.cwd !== undefined ? resolveAgainst(repoRoot, cmd.cwd) : carried;
    const walked = walkScript(cmd.command, start, { repoRoot, exists: opts.exists, depth: 0 });
    if (!walked) {
      carried = null;
      continue;
    }
    const rejoined = rejoin(walked.outcome);
    const end = walked.outcome.mayExit || rejoined === undefined ? null : rejoined;
    carried = end === null ? null : repoRelative(repoRoot, end) === null ? repoRoot : end;
    for (const raw of walked.out) {
      const hit = resolveTestArg(raw, repoRoot, opts.exists);
      if (hit && !found.has(hit.path)) found.set(hit.path, { ...hit, runner: raw.runner });
    }
  }
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Walk one script from `cwd` in a fresh shell. Null when the script can't be
 * parsed or uses unmodeled machinery: it then collects nothing, and since part
 * of it may still have run, the caller treats its cwd as unknown.
 */
function walkScript(
  src: string,
  cwd: Cwd,
  base: Pick<WalkState, 'repoRoot' | 'exists' | 'depth'>,
): { outcome: Outcome; out: RawTestArg[] } | null {
  const tokens = tokenizeShell(src);
  const list = tokens ? parseShell(tokens) : null;
  if (!list) return null;
  const state: WalkState = {
    ...base,
    cwd,
    mayFail: true,
    mustFail: false,
    exited: false,
    out: [],
  };
  try {
    return { outcome: evalList(list, cwd, state), out: state.out };
  } catch (err) {
    if (err instanceof UnsupportedScript) return null;
    throw err;
  }
}

function evalList(list: ShellList, cwd: Cwd, state: WalkState): Outcome {
  let result: Outcome = { ok: cwd, fail: undefined, mayExit: false };
  for (const { andOr, async } of list) {
    const start = rejoin(result);
    // Every branch so far ended the shell; nothing later runs.
    if (start === undefined) break;
    if (async) {
      // A `&` job runs in a subshell; the parent's cwd is untouched and the
      // list continues with status 0.
      evalAndOr(andOr, start, state);
      result = { ok: start, fail: undefined, mayExit: result.mayExit };
      continue;
    }
    const r = evalAndOr(andOr, start, state);
    result = { ...r, mayExit: result.mayExit || r.mayExit };
  }
  return result;
}

function evalAndOr(node: ShellAndOr, cwd: Cwd, state: WalkState): Outcome {
  let result = evalPipeline(node.first, cwd, state);
  for (const { op, pipeline } of node.rest) {
    // `&&` continues on the success branch, `||` on the failure branch; the
    // other branch skips the right side unchanged.
    const from = op === '&&' ? result.ok : result.fail;
    if (from === undefined) continue;
    const next = evalPipeline(pipeline, from, state);
    result =
      op === '&&'
        ? {
            ok: next.ok,
            fail: joinBranch(result.fail, next.fail),
            mayExit: result.mayExit || next.mayExit,
          }
        : {
            ok: joinBranch(result.ok, next.ok),
            fail: next.fail,
            mayExit: result.mayExit || next.mayExit,
          };
  }
  return result;
}

function evalPipeline(pipeline: ShellPipeline, cwd: Cwd, state: WalkState): Outcome {
  if (pipeline.length === 1) return evalCommand(pipeline[0], cwd, state);
  // Every element of a multi-command pipeline runs in its own subshell.
  for (const cmd of pipeline) evalCommand(cmd, cwd, state);
  return { ok: cwd, fail: cwd, mayExit: false };
}

function evalCommand(cmd: ShellCommandNode, cwd: Cwd, state: WalkState): Outcome {
  if (cmd.kind === 'subshell') {
    // `exit` inside `( ... )` ends only the subshell, with a status we don't
    // track; the parent's cwd is untouched either way.
    const inner = evalList(cmd.list, cwd, state);
    const ok = inner.ok !== undefined || inner.mayExit;
    const fail = inner.fail !== undefined || inner.mayExit;
    return { ok: ok ? cwd : undefined, fail: fail ? cwd : undefined, mayExit: false };
  }
  const scope: WalkState = { ...state, cwd, mayFail: true, mustFail: false, exited: false };
  handleSimpleCommand(cmd.words, scope);
  if (scope.exited) return { ok: undefined, fail: undefined, mayExit: true };
  // A simple command that fails leaves the cwd where it started (a failed cd
  // doesn't move).
  return {
    ok: scope.mustFail ? undefined : scope.cwd,
    fail: scope.mayFail ? cwd : undefined,
    mayExit: false,
  };
}

/** A copy of `state` for a child process: shares `out`, never leaks its cwd. */
function child(state: WalkState, cwd: Cwd = state.cwd): WalkState {
  return { ...state, cwd };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** `target` as an absolute path, relative to `cwd` unless absolute; null when unknowable. */
function resolveAgainst(cwd: Cwd, target: string): Cwd {
  const t = toPosix(target);
  if (t === '~' || t.startsWith('~/')) return path.posix.join(HOME_DIR, t.slice(1));
  if (t.startsWith('~')) return null;
  if (t.startsWith('/')) return path.posix.normalize(t);
  return cwd === null ? null : path.posix.resolve(cwd, t);
}

/** Repo-relative form of an absolute path ('' for the root), or null outside the repo. */
function repoRelative(repoRoot: string, abs: string): string | null {
  const rel = path.posix.relative(repoRoot, abs);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface OptSpec {
  /** Options that take no value. */
  bool?: readonly string[];
  /** Options that take the next word (or `--opt=value`) as their value. */
  value?: readonly string[];
}

interface ParsedOpts {
  opts: Map<string, string | true>;
  rest: string[];
}

/**
 * Leading options of `argv[start..]` against `spec`, stopping at `--` or the
 * first non-option. Null on an option the spec doesn't list, or a value option
 * missing its value: an unmodeled mode, which adds nothing.
 */
function parseOpts(argv: string[], start: number, spec: OptSpec): ParsedOpts | null {
  if (hasExpansion(argv)) return null;
  const bool = new Set(spec.bool ?? []);
  const value = new Set(spec.value ?? []);
  const opts = new Map<string, string | true>();
  let j = start;
  while (j < argv.length) {
    const a = argv[j];
    if (a === '--') return { opts, rest: argv.slice(j + 1) };
    if (!a.startsWith('-') || a === '-') break;
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (bool.has(name) && eq < 0) {
      opts.set(name, true);
      j++;
    } else if (value.has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[j + 1];
      if (v === undefined) return null;
      opts.set(name, v);
      j += eq > 0 ? 1 : 2;
    } else {
      return null;
    }
  }
  return { opts, rest: argv.slice(j) };
}

/**
 * True when any word holds an expansion. Its value is unknown, so it could be
 * an option that changes the mode (`--help`) or one that consumes the next
 * word; option parsing can't classify the words around it, and the whole
 * invocation adds nothing. Leading `NAME=$x` assignments are stripped before
 * argv is built and never reach here.
 */
function hasExpansion(argv: readonly string[]): boolean {
  return argv.some((a) => a.includes('\0'));
}

/** The value of the first of `names` present in `opts`. */
function optValue(opts: Map<string, string | true>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = opts.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Builtins and wrappers
// ---------------------------------------------------------------------------

const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

/** Variables that change where `cd` goes or how the shell starts. */
const SENSITIVE_VARS = new Set([
  'CDPATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
]);

/**
 * Environment variables that inject options into a runner or package
 * manager. A command run with one set adds nothing; exporting one rejects
 * the script, since every later command inherits it.
 */
const OPTION_ENV_RE =
  /^(PYTEST_ADDOPTS|GOFLAGS|SPEC_OPTS|npm_config_\w+|NPM_CONFIG_\w+|pnpm_config_\w+|YARN_\w+)$/;

/** Builtins that can't change the cwd, control flow or what later commands mean. */
const INERT_BUILTINS = new Set([
  'echo',
  'printf',
  'pwd',
  'read',
  'readarray',
  'mapfile',
  'test',
  '[',
  'type',
  'hash',
  'help',
  'history',
  'jobs',
  'dirs',
  'disown',
  'times',
  'ulimit',
  'umask',
  'getopts',
  'let',
  'compgen',
  'complete',
  'compopt',
  'caller',
  'bind',
  'wait',
  'shift',
]);

/** Builtins that only set variables; inert unless they touch SENSITIVE_VARS. */
const VAR_BUILTINS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'unset']);

/**
 * Builtins that change control flow, run strings as code, or redefine
 * commands. The walker doesn't model them, so a script using one is rejected.
 */
const REJECT_BUILTINS = new Set([
  'alias',
  'unalias',
  'break',
  'continue',
  'enable',
  'eval',
  'fc',
  'fg',
  'bg',
  'logout',
  'return',
  'shopt',
  'source',
  '.',
  'suspend',
  'trap',
]);

/** `set` options that don't change which commands run. */
const SAFE_SET_OPTIONS = new Set(['pipefail', 'xtrace', 'verbose']);

function handleSimpleCommand(tokens: WordToken[], state: WalkState): void {
  // A leading `NAME=value` is an assignment even when the value expands.
  let i = 0;
  let injects = false;
  for (; i < tokens.length; i++) {
    const m = ENV_ASSIGN_RE.exec(tokens[i].value);
    if (!m) break;
    if (SENSITIVE_VARS.has(m[1])) throw new UnsupportedScript();
    if (OPTION_ENV_RE.test(m[1])) injects = true;
  }
  if (injects) {
    // A bare assignment may feed an already-exported variable to later commands.
    if (i === tokens.length) throw new UnsupportedScript();
    return;
  }
  stripAndDispatch(
    tokens.slice(i).map((t) => (t.dynamic ? '\0dynamic' : t.value)),
    state,
  );
}

/** `cd` / `pushd` in the current shell. */
function changeDir(argv: string[], state: WalkState): void {
  // An expansion may be the target, an option or several words: where a
  // successful cd lands is unknown, and a failed one stays put.
  if (hasExpansion(argv)) {
    state.cwd = null;
    return;
  }
  const parsed = parseOpts(argv, 1, { bool: ['-L', '-P', '-e', '-@'] });
  const targets = parsed?.rest ?? [];
  // `cd a b` fails ("too many arguments") and an unknown option is an error:
  // the shell stays put.
  if (!parsed || targets.length > 1) {
    state.mustFail = true;
    return;
  }
  // `cd -` needs OLDPWD.
  const dest = targets[0] === '-' ? null : resolveAgainst(state.cwd, targets[0] ?? '~');
  state.cwd = dest;
  if (dest === null) return;
  // Inside the repo, a target that isn't a directory at head may not exist;
  // the failure branch keeps the old cwd.
  const rel = repoRelative(state.repoRoot, dest);
  if (rel !== null && rel !== '' && state.exists(rel) !== 'dir') return;
  state.mayFail = false;
}

/** `set`: only tracing and pipefail are modeled; anything else (`-e`, `-u`, ...) rejects. */
function checkSet(argv: string[]): void {
  for (let j = 1; j < argv.length; j++) {
    const a = argv[j];
    // `set $FLAGS` may turn on -e or -u.
    if (a.startsWith('\0')) throw new UnsupportedScript();
    if (a === '--' || a === '-' || !/^[-+]/.test(a)) return;
    if (a === '-o' || a === '+o') {
      const name = argv[++j];
      if (name === undefined || !SAFE_SET_OPTIONS.has(name)) throw new UnsupportedScript();
      continue;
    }
    if (!/^[-+][xv]+$/.test(a)) throw new UnsupportedScript();
  }
}

/** `kill` of process 0, a negative group or an expansion may hit this shell. */
function checkKill(argv: string[]): void {
  const parsed = parseOpts(argv, 1, { bool: ['-l', '-L'], value: ['-s', '-n'] });
  const pids = parsed
    ? parsed.rest
    : /^-[A-Za-z0-9]+$/.test(argv[1] ?? '')
      ? argv.slice(2)
      : argv.slice(1);
  if (pids.some((p) => p.startsWith('\0') || p === '0' || p.startsWith('-'))) {
    throw new UnsupportedScript();
  }
}

function stripAndDispatch(argv: string[], state: WalkState): void {
  if (argv.length === 0) return;
  const head = argv[0];
  if (head.startsWith('\0')) return;

  // Builtins and keywords run in the current shell (a path is never a builtin).
  if (!head.includes('/')) {
    switch (head) {
      case 'cd':
      case 'pushd':
        return changeDir(argv, state);
      case 'popd':
        state.cwd = null;
        return;
      case 'true':
      case ':':
        state.mayFail = false;
        return;
      case 'false':
        state.mustFail = true;
        return;
      case 'exit':
        state.exited = true;
        return;
      case 'set':
        return checkSet(argv);
      case 'kill':
        return checkKill(argv);
      case 'exec': {
        // `exec cmd` replaces the shell, and a failing exec ends a
        // non-interactive one; bare `exec` only applies redirections.
        const parsed = parseOpts(argv, 1, { bool: ['-c', '-l'], value: ['-a'] });
        if (parsed && parsed.rest.length === 0) return;
        state.exited = true;
        if (parsed) stripAndDispatch(parsed.rest, child(state));
        return;
      }
      case 'command': {
        // `-v` / `-V` only describe the command.
        const parsed = parseOpts(argv, 1, { bool: ['-p'] });
        if (parsed) stripAndDispatch(parsed.rest, state);
        return;
      }
      case 'builtin':
        if (argv[1] && isBuiltinName(argv[1])) stripAndDispatch(argv.slice(1), state);
        return;
      case 'time': {
        // A word after `time` other than `-p` is the timed command itself.
        const rest = argv[1] === '-p' ? argv.slice(2) : argv.slice(1);
        return stripAndDispatch(rest[0] === '--' ? rest.slice(1) : rest, state);
      }
    }
    if (VAR_BUILTINS.has(head)) {
      for (const a of argv.slice(1)) {
        const name = ENV_ASSIGN_RE.exec(a)?.[1] ?? a;
        if (SENSITIVE_VARS.has(name) || OPTION_ENV_RE.test(name) || a.startsWith('\0'))
          throw new UnsupportedScript();
      }
      return;
    }
    if (REJECT_BUILTINS.has(head)) throw new UnsupportedScript();
    if (INERT_BUILTINS.has(head)) return;
  }

  // An expansion can become an option, an option's value or several words,
  // so a program invoked with one runs in a mode we can't know.
  if (argv.some((a) => a.startsWith('\0'))) return;

  // Everything below runs as a separate process, so a cwd it sets stays there.
  const proc = child(state);
  const name = path.posix.basename(head);
  switch (name) {
    case 'env': {
      // Assignments may follow the options; `-S` and friends are unmodeled.
      const parsed = parseOpts(argv, 1, {
        bool: ['-i', '--ignore-environment', '-0', '--null'],
        value: ['-u', '--unset', '-C', '--chdir'],
      });
      if (!parsed) return;
      let rest = parsed.rest;
      while (rest.length && ENV_ASSIGN_RE.test(rest[0])) {
        const name = ENV_ASSIGN_RE.exec(rest[0])![1];
        if (SENSITIVE_VARS.has(name) || OPTION_ENV_RE.test(name)) return;
        rest = rest.slice(1);
      }
      const dir = optValue(parsed.opts, '-C', '--chdir');
      return stripAndDispatch(rest, dir === undefined ? proc : withCwd(proc, dir));
    }
    case 'nohup':
      return stripAndDispatch(argv.slice(1)[0] === '--' ? argv.slice(2) : argv.slice(1), proc);
    case 'nice': {
      const parsed = parseOpts(argv, 1, { value: ['-n', '--adjustment'] });
      if (parsed) stripAndDispatch(parsed.rest, proc);
      return;
    }
    case 'stdbuf': {
      const parsed = parseOpts(
        argv.map((a, k) => (k > 0 ? a.replace(/^(-[ioe])(\S+)$/, '$1=$2') : a)),
        1,
        { value: ['-i', '-o', '-e', '--input', '--output', '--error'] },
      );
      if (parsed) stripAndDispatch(parsed.rest, proc);
      return;
    }
    case 'xvfb-run': {
      const parsed = parseOpts(argv, 1, {
        bool: ['-a', '--auto-servernum'],
        value: [
          '-n',
          '--server-num',
          '-s',
          '--server-args',
          '-e',
          '--error-file',
          '-f',
          '--auth-file',
          '-p',
          '--xauth-protocol',
          '-w',
          '--wait',
        ],
      });
      if (parsed) stripAndDispatch(parsed.rest, proc);
      return;
    }
    case 'timeout': {
      const parsed = parseOpts(argv, 1, {
        bool: ['--preserve-status', '--foreground', '-v', '--verbose'],
        value: ['-s', '--signal', '-k', '--kill-after'],
      });
      if (parsed && parsed.rest.length > 1) stripAndDispatch(parsed.rest.slice(1), proc);
      return;
    }
    case 'bg.sh': {
      if (argv[1] !== 'start') return;
      const parsed = parseOpts(argv, 2, {
        bool: ['--no-watch'],
        value: ['--label', '--timeout-sec'],
      });
      if (!parsed) return;
      // bg.sh runs its command in the session worktree root.
      const job = child(state, state.repoRoot);
      if (parsed.rest.length === 1 && /\s/.test(parsed.rest[0])) recurse(parsed.rest[0], job);
      else stripAndDispatch(parsed.rest, job);
      return;
    }
  }

  if (SHELLS.has(name)) {
    const script = shellCommandString(argv);
    if (script !== null) recurse(script, proc);
    return;
  }

  dispatchRunner(argv, proc);
}

function isBuiltinName(name: string): boolean {
  return (
    INERT_BUILTINS.has(name) ||
    VAR_BUILTINS.has(name) ||
    REJECT_BUILTINS.has(name) ||
    [
      'cd',
      'pushd',
      'popd',
      'true',
      'false',
      ':',
      'exit',
      'set',
      'kill',
      'exec',
      'command',
      'builtin',
    ].includes(name)
  );
}

/**
 * The `-c` script of a shell invocation, or null when the shell isn't run in
 * a modeled mode: no `-c` (a script file or stdin), `-n` (syntax check only),
 * `-e` / `-u` / `-i`, or any other option.
 */
function shellCommandString(argv: string[]): string | null {
  let hasC = false;
  for (let j = 1; j < argv.length; j++) {
    const a = argv[j];
    if (a === '--') return hasC ? (argv[j + 1] ?? null) : null;
    if (a === '--login' || a === '--norc' || a === '--noprofile' || a === '--posix') continue;
    if (a === '-o' || a === '+o') {
      if (!SAFE_SET_OPTIONS.has(argv[++j] ?? '')) return null;
      continue;
    }
    if (/^[-+][clxv]+$/.test(a)) {
      if (a.includes('c')) {
        if (a.startsWith('+')) return null;
        hasC = true;
      }
      continue;
    }
    if (a.startsWith('-') || a.startsWith('+')) return null;
    return hasC && !a.startsWith('\0') ? a : null;
  }
  return null;
}

function recurse(script: string, state: WalkState): void {
  if (state.depth >= MAX_RECURSION) return;
  const inner = walkScript(script, state.cwd, {
    repoRoot: state.repoRoot,
    exists: state.exists,
    depth: state.depth + 1,
  });
  if (inner) state.out.push(...inner.out);
}

// ---------------------------------------------------------------------------
// Package managers and runners
// ---------------------------------------------------------------------------

const RUNNER_BINS: Record<string, TestRunner> = {
  vitest: 'vitest',
  jest: 'jest',
  pytest: 'pytest',
  'py.test': 'pytest',
  rspec: 'rspec',
  playwright: 'playwright',
  cypress: 'cypress',
};

const PYTHONS = /^python(\d+(\.\d+)?)?$/;

/*
 * Package managers. Each mode runs its command in a documented directory,
 * and the walker resolves test paths there or adds nothing:
 *
 * - npm scripts run "from the root of the package folder, regardless of what
 *   the current working directory is" (`--prefix` names that folder);
 *   `npm exec` / npx run in the cwd. npm reads its own options anywhere
 *   before `--`. Workspace options (`-w`, `--workspaces`, ...) resolve names
 *   and globs from package.json contents the walker can't see: unmodeled.
 * - pnpm commands act on the nearest ancestor with a manifest, except
 *   `pnpm exec`, which runs where pnpm started. `-C <dir>` starts pnpm there;
 *   `-w` starts it at the workspace root (the dir holding
 *   pnpm-workspace.yaml).
 * - yarn scripts run in the workspace that declares them. A `name:with:colon`
 *   script may come from another workspace: unmodeled.
 *
 * A bare `pnpm vitest` / `yarn jest` / `bun run vitest` is either a script of
 * that name (package root) or the binary (cwd); it only counts when the two
 * are the same directory.
 */
const NPX_OPTS: OptSpec = {
  bool: ['-y', '--yes', '--no', '-q', '--quiet', '--no-install', '--prefer-offline'],
  value: ['-p', '--package'],
};
const NPM_OPTS: OptSpec = {
  bool: ['-s', '--silent', '-q', '--quiet', '--if-present', '--color', '--no-color', '-y', '--yes'],
  value: ['--prefix', '-C', '--loglevel'],
};
const PNPM_OPTS: OptSpec = {
  bool: [
    '-s',
    '--silent',
    '--if-present',
    '--color',
    '--no-color',
    '--stream',
    '--bail',
    '--no-bail',
    '-w',
    '--workspace-root',
  ],
  value: ['-C', '--dir', '--reporter', '--loglevel'],
};
const YARN_OPTS: OptSpec = {
  bool: ['-s', '--silent', '--verbose', '--no-progress'],
  value: ['--cwd'],
};
const UV_RUN_OPTS: OptSpec = {
  bool: [
    '--frozen',
    '--locked',
    '--no-sync',
    '--isolated',
    '-q',
    '--quiet',
    '--all-extras',
    '--no-dev',
    '--dev',
  ],
  value: [
    '--with',
    '--python',
    '-p',
    '--env-file',
    '--directory',
    '--project',
    '--extra',
    '--group',
  ],
};
const PYTHON_OPTS: OptSpec = {
  bool: ['-u', '-B', '-O', '-OO', '-E', '-s', '-I', '-q', '-P'],
  value: ['-W', '-X'],
};

function dispatchRunner(argv: string[], state: WalkState): void {
  if (hasExpansion(argv)) return;
  const name = path.posix.basename(argv[0]);
  const rest = argv.slice(1);

  if (name === 'npx' || name === 'bunx') {
    const parsed = parseOpts(argv, 1, NPX_OPTS);
    if (parsed) dispatchBin(parsed.rest, state);
    return;
  }
  if (name === 'npm') return dispatchNpm(rest, state);
  if (name === 'pnpm') return dispatchPnpm(rest, state);
  if (name === 'yarn') return dispatchYarn(rest, state);
  if (name === 'bun') {
    if (rest[0] === 'x') return dispatchBin(rest.slice(1), state);
    if (rest[0] === 'run') runPackageScript(rest[1], rest.slice(2), state, state.cwd, true);
    return;
  }
  if (name === 'uv') {
    if (rest[0] !== 'run') return;
    const parsed = parseOpts(rest, 1, UV_RUN_OPTS);
    if (!parsed) return;
    const dir = optValue(parsed.opts, '--directory');
    return stripAndDispatch(parsed.rest, dir === undefined ? state : withCwd(state, dir));
  }
  // poetry and pipenv run in the cwd; hatch and pdm scripts may run from the
  // project root, which isn't modeled.
  if (name === 'poetry' || name === 'pipenv') {
    if (rest[0] !== 'run') return;
    const parsed = parseOpts(rest, 1, {});
    if (parsed) stripAndDispatch(parsed.rest, state);
    return;
  }
  if (name === 'bundle') {
    if (rest[0] !== 'exec') return;
    const parsed = parseOpts(rest, 1, {});
    if (parsed) stripAndDispatch(parsed.rest, state);
    return;
  }
  if (PYTHONS.test(name)) {
    // Interpreter options, then `-m pytest`; anything else isn't a test run.
    const bool = new Set(PYTHON_OPTS.bool);
    const value = new Set(PYTHON_OPTS.value);
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (a === '-m' || a.startsWith('-m')) {
        const mod = a === '-m' ? rest[j + 1] : a.slice(2);
        if (mod === 'pytest') parsePytest(rest.slice(a === '-m' ? j + 2 : j + 1), state);
        return;
      }
      if (bool.has(a)) continue;
      if (value.has(a)) {
        j++;
        continue;
      }
      return;
    }
    return;
  }
  if (name === 'go') {
    if (rest[0] === 'test') parseGoTest(rest.slice(1), state);
    return;
  }
  dispatchBin(argv, state);
}

/** A bin invocation: `vitest ...`, `node_modules/.bin/jest ...`, `bin/rspec ...`. */
function dispatchBin(argv: string[], state: WalkState): void {
  if (argv.length === 0) return;
  const bin = path.posix.basename(argv[0]).replace(/@[^/]*$/, '');
  const runner = RUNNER_BINS[bin];
  const rest = argv.slice(1);
  switch (runner) {
    case 'vitest':
      return parseVitest(rest, state);
    case 'jest':
      return parseJest(rest, state);
    case 'pytest':
      return parsePytest(rest, state);
    case 'rspec':
      return parseRspec(rest, state);
    case 'playwright':
      if (rest[0] === 'test') parsePlaywright(rest.slice(1), state);
      return;
    case 'cypress':
      if (rest[0] === 'run') parseCypress(rest.slice(1), state);
      return;
  }
}

/** Nearest directory at or above `start`, inside the repo, holding `marker` at head. */
function nearestWith(state: WalkState, start: Cwd, marker: string): Cwd {
  if (start === null) return null;
  let rel = repoRelative(state.repoRoot, start);
  if (rel === null) return null;
  for (;;) {
    if (state.exists(rel === '' ? marker : `${rel}/${marker}`) === 'file') {
      return rel === '' ? state.repoRoot : path.posix.join(state.repoRoot, rel);
    }
    if (rel === '') return null;
    const up = path.posix.dirname(rel);
    rel = up === '.' ? '' : up;
  }
}

function packageRoot(state: WalkState, start: Cwd): Cwd {
  return nearestWith(state, start, 'package.json');
}

/**
 * Run `script` with `args` the way a package manager does: in the package
 * root, or for a name that may be a binary instead, only when the package
 * root is also where the binary would run.
 */
function runPackageScript(
  script: string,
  args: string[],
  state: WalkState,
  start: Cwd,
  binFallback: boolean,
): void {
  if (!script || script.startsWith('-') || script.startsWith('\0')) return;
  const root = packageRoot(state, start);
  if (root === null) return;
  if (binFallback && RUNNER_BINS[script] && root !== start) return;
  const scope = child(state, root);
  if (RUNNER_BINS[script]) return dispatchBin([script, ...args], scope);
  if (!/test|spec|e2e/i.test(script)) return;
  const parsed = parseRunnerArgs(args[0] === '--' ? args.slice(1) : args, SCRIPT, root);
  if (parsed) pushPositionals(parsed, 'script', scope);
}

function dispatchNpm(args: string[], state: WalkState): void {
  // npm parses its options anywhere before `--`; for exec, words after the
  // binary belong to the binary.
  const npmValue = new Set(NPM_OPTS.value);
  const npmBool = new Set(NPM_OPTS.bool);
  const execValue = new Set([...npmValue, ...NPX_OPTS.value!]);
  const execBool = new Set([...npmBool, ...NPX_OPTS.bool!]);
  let prefix: string | undefined;
  const pos: string[] = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    const isExec = pos[0] === 'exec' || pos[0] === 'x';
    if (a === '--') {
      pos.push(...(isExec ? [] : ['--']), ...args.slice(j + 1));
      break;
    }
    if (isExec && pos.length >= 2) {
      pos.push(...args.slice(j));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if ((isExec ? execValue : npmValue).has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++j];
      if (v === undefined) return;
      if (name === '--prefix' || name === '-C') prefix = v;
    } else if (!(isExec ? execBool : npmBool).has(name)) {
      return;
    }
  }
  const [sub, ...rest] = pos;
  if (sub === 'exec' || sub === 'x') return dispatchBin(rest, state);
  // npm forwards positionals before `--` and everything after it.
  const forward = (words: string[]) => {
    const k = words.indexOf('--');
    return k < 0 ? words : [...words.slice(0, k), ...words.slice(k + 1)];
  };
  const start = prefix === undefined ? state.cwd : resolveAgainst(state.cwd, prefix);
  if (sub === 'test' || sub === 't' || sub === 'tst') {
    // `--prefix` names the package folder itself.
    if (prefix !== undefined && packageRoot(state, start) !== start) return;
    return runPackageScript('test', forward(rest), state, start, false);
  }
  if (sub === 'run' || sub === 'run-script' || sub === 'rum' || sub === 'urn') {
    if (prefix !== undefined && packageRoot(state, start) !== start) return;
    const words = rest[0] === '--' ? rest.slice(1) : rest;
    return runPackageScript(words[0], forward(words.slice(1)), state, start, false);
  }
}

function dispatchPnpm(args: string[], state: WalkState): void {
  // `-r` / `--filter` run in other packages' directories, which aren't modeled.
  const parsed = parseOpts(args, 0, PNPM_OPTS);
  if (!parsed) return;
  const dir = optValue(parsed.opts, '-C', '--dir');
  let start = dir === undefined ? state.cwd : resolveAgainst(state.cwd, dir);
  if (parsed.opts.has('-w') || parsed.opts.has('--workspace-root')) {
    start = nearestWith(state, start, 'pnpm-workspace.yaml');
    if (start === null) return;
  }
  const [sub, ...rest] = parsed.rest;
  if (sub === undefined) return;
  if (sub === 'exec' || sub === 'dlx') {
    const exec = parseOpts(rest, 0, {});
    if (exec) dispatchBin(exec.rest, child(state, start));
    return;
  }
  if (sub === 'run' || sub === 'run-script') {
    const run = parseOpts(rest, 0, {});
    if (run) runPackageScript(run.rest[0], run.rest.slice(1), state, start, true);
    return;
  }
  if (sub === 'test' || sub === 't' || sub === 'tst')
    return runPackageScript('test', rest, state, start, false);
  runPackageScript(sub, rest, state, start, true);
}

function dispatchYarn(args: string[], state: WalkState): void {
  const parsed = parseOpts(args, 0, YARN_OPTS);
  if (!parsed) return;
  const dir = optValue(parsed.opts, '--cwd');
  const start = dir === undefined ? state.cwd : resolveAgainst(state.cwd, dir);
  const [sub, ...rest] = parsed.rest;
  // `yarn workspace <name>` / `workspaces foreach` run elsewhere; not modeled.
  if (sub === undefined || sub === 'workspace' || sub === 'workspaces') return;
  if (sub === 'exec' || sub === 'dlx') {
    if (packageRoot(state, start) === start) dispatchBin(rest, child(state, start));
    return;
  }
  const [script, scriptArgs] = sub === 'run' ? [rest[0], rest.slice(1)] : [sub, rest];
  if (script === undefined || script.includes(':')) return;
  runPackageScript(script, scriptArgs, state, start, true);
}

function withCwd(state: WalkState, dir: string | undefined): WalkState {
  if (dir === undefined || dir.startsWith('\0')) return { ...state, cwd: null };
  return { ...state, cwd: resolveAgainst(state.cwd, dir) };
}

/**
 * Complete option grammar of one runner. Closed-world like the wrappers: an
 * option the spec doesn't list makes the invocation add nothing, because its
 * arity is unknown and its value could look like a test path.
 */
interface RunnerSpec {
  /** Options that take no value (`--opt=value` is accepted too). */
  bool: readonly string[];
  /** Options that always take a value. */
  value: readonly string[];
  /** Options whose value is optional: they take the next word unless it starts with `-`. */
  optional?: readonly string[];
  /** Options that list, describe, compile or select by VCS state: no explicit run. */
  nonRun: readonly string[];
  /**
   * Options that change which named files run (projects, shards, excludes,
   * last-failed, an options file) in a way the walker doesn't model.
   */
  unmodeled?: readonly string[];
  /** Options that change the process directory before anything runs (`go test -C`). */
  chdir?: readonly string[];
  /**
   * Options that bound discovery to a directory resolved from the cwd
   * (vitest `--root`). Positionals still resolve against the cwd, and must
   * fall inside the scope.
   */
  scope?: readonly string[];
  /** Whether `-abc` bundles short options (`-xvs`, `-n4`, `-kfoo`). */
  clusters?: boolean;
}

interface CompiledSpec {
  bool: Set<string>;
  value: Set<string>;
  optional: Set<string>;
  /** Non-run and unmodeled options: either makes the invocation add nothing. */
  reject: Set<string>;
  chdir: Set<string>;
  scope: Set<string>;
  clusters: boolean;
}

function compile(spec: RunnerSpec): CompiledSpec {
  return {
    bool: new Set(spec.bool),
    value: new Set(spec.value),
    optional: new Set(spec.optional ?? []),
    reject: new Set([...spec.nonRun, ...(spec.unmodeled ?? [])]),
    chdir: new Set(spec.chdir ?? []),
    scope: new Set(spec.scope ?? []),
    clusters: spec.clusters ?? false,
  };
}

interface RunnerArgs {
  positionals: string[];
  /** Every option given, in order, with its value (`true` for a flag). */
  options: Array<[string, string | true]>;
  /** Directory positionals resolve against: the cwd, or a chdir option's target. */
  base: Cwd;
  /** Discovery bound from a scope option; undefined when none was given. */
  scope?: Cwd;
}

/**
 * Split runner arguments into options and positionals against `spec`. Null
 * when the invocation runs nothing explicit (a non-run mode) or uses an
 * option the spec doesn't know.
 */
function parseRunnerArgs(args: string[], spec: CompiledSpec, cwd: Cwd): RunnerArgs | null {
  if (hasExpansion(args)) return null;
  const positionals: string[] = [];
  const options: Array<[string, string | true]> = [];
  let base = cwd;
  let scope: Cwd | undefined;
  let moved = false;
  const take = (name: string, value: string | true): boolean => {
    if (spec.reject.has(name)) return false;
    options.push([name, value]);
    const isChdir = spec.chdir.has(name);
    if (isChdir || spec.scope.has(name)) {
      // A repeated directory option would make the result depend on the
      // runner's precedence rules; not modeled.
      if (moved || typeof value !== 'string') return false;
      moved = true;
      const dir = value.startsWith('\0') ? null : resolveAgainst(cwd, value);
      if (isChdir) base = dir;
      else scope = dir;
    }
    return true;
  };
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    // Runners disagree on `--`: vitest (cac) keeps what follows out of its
    // filters, others treat it as positionals. Not modeled.
    if (a === '--') return null;
    if (!a.startsWith('-') || a === '-') {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const known = spec.bool.has(name) || spec.value.has(name) || spec.optional.has(name);
    if (known || spec.reject.has(name)) {
      let value: string | true;
      if (eq > 0) value = a.slice(eq + 1);
      else if (spec.value.has(name)) {
        if (j + 1 >= args.length) return null;
        value = args[++j];
      } else if (spec.optional.has(name) && j + 1 < args.length && !args[j + 1].startsWith('-')) {
        value = args[++j];
      } else value = true;
      if (!take(name, value)) return null;
      continue;
    }
    if (spec.clusters && /^-[A-Za-z]/.test(a) && !a.startsWith('--')) {
      // `-xvs`: bools, then at most one value option taking the rest or the next word.
      let k = 1;
      for (; k < a.length; k++) {
        const flag = `-${a[k]}`;
        if (spec.bool.has(flag)) {
          if (!take(flag, true)) return null;
          continue;
        }
        if (spec.value.has(flag) || spec.optional.has(flag)) {
          let value: string | true = a.slice(k + 1);
          if (value === '') {
            if (spec.value.has(flag)) {
              if (j + 1 >= args.length) return null;
              value = args[++j];
            } else if (j + 1 < args.length && !args[j + 1].startsWith('-')) value = args[++j];
            else value = true;
          }
          if (!take(flag, value)) return null;
          break;
        }
        return null;
      }
      continue;
    }
    return null;
  }
  return { positionals, options, base, ...(scope !== undefined ? { scope } : {}) };
}

const VITEST = compile({
  bool: [
    '--run',
    '--watch',
    '-w',
    '--ui',
    '--coverage',
    '--no-coverage',
    '--passWithNoTests',
    '--globals',
    '--dom',
    '--isolate',
    '--no-isolate',
    '--fileParallelism',
    '--no-file-parallelism',
    '--typecheck',
    '--allowOnly',
    '--hideSkippedTests',
    '--logHeapUsage',
    '--color',
    '--no-color',
    '--clearScreen',
    '--no-clearScreen',
    '--expandSnapshotDiff',
    '--disableConsoleIntercept',
    '--printConsoleTrace',
    '--includeTaskLocation',
    '--dangerouslyIgnoreUnhandledErrors',
    '--sequence.shuffle',
    '--sequence.concurrent',
    '--coverage.enabled',
    '--no-watch',
  ],
  value: [
    '-t',
    '--testNamePattern',
    '-c',
    '--config',
    '-r',
    '--root',
    '--reporter',
    '--outputFile',
    '--outputFile.junit',
    '--outputFile.json',
    '--environment',
    '--pool',
    '--maxWorkers',
    '--minWorkers',
    '--maxConcurrency',
    '--mode',
    '--testTimeout',
    '--hookTimeout',
    '--teardownTimeout',
    '--slowTestThreshold',
    '--retry',
    '--bail',
    '--browser',
    '--diff',
    '--sequence.seed',
    '--coverage.provider',
    '--coverage.reporter',
    '--coverage.reportsDirectory',
    '--coverage.include',
    '--coverage.exclude',
    '--bail',
    '--browser',
    '--reporters',
  ],
  // Arity from vitest's cli-config.ts: `[value]` options take the next word.
  optional: ['--silent', '-u', '--update', '--inspect', '--inspect-brk', '--inspectBrk', '--open'],
  nonRun: ['-h', '--help', '-v', '--version', '--standalone', '--clearCache', '--changed'],
  // `--dir` is a scan base whose resolution vitest doesn't document.
  unmodeled: ['--dir', '--project', '--exclude', '--workspace', '--shard'],
  scope: ['-r', '--root'],
});

const JEST = compile({
  bool: [
    'b',
    'boolean',
    '--bail',
    '-b',
    '--ci',
    '--coverage',
    '--collectCoverage',
    '--no-coverage',
    '--watch',
    '--watchAll',
    '--runInBand',
    '-i',
    '--verbose',
    '--silent',
    '--detectOpenHandles',
    '--forceExit',
    '--passWithNoTests',
    '--cache',
    '--no-cache',
    '--json',
    '--colors',
    '--no-colors',
    '--updateSnapshot',
    '-u',
    '--runTestsByPath',
    '--logHeapUsage',
    '--expand',
    '-e',
    '--errorOnDeprecated',
    '--noStackTrace',
    '--useStderr',
    '--debug',
    '--clearMocks',
    '--resetMocks',
    '--restoreMocks',
    '--injectGlobals',
    '--detectLeaks',
    '--watchman',
    '--no-watchman',
    '--randomize',
    '--testLocationInResults',
    '--bail',
    '-b',
  ],
  value: [
    '-t',
    '--testNamePattern',
    '-c',
    '--config',
    '--testPathPattern',
    '--testPathPatterns',
    '--reporters',
    '--maxWorkers',
    '-w',
    '--outputFile',
    '--coverageDirectory',
    '--coverageReporters',
    '--coverageProvider',
    '--collectCoverageFrom',
    '--testTimeout',
    '--seed',
    '--env',
    '--testEnvironment',
    '--maxConcurrency',
  ],
  nonRun: [
    '-h',
    '--help',
    '-v',
    '--version',
    '--listTests',
    '--showConfig',
    '--init',
    '--clearCache',
    '--findRelatedTests',
    '--onlyChanged',
    '-o',
    '--changedSince',
    '--lastCommit',
  ],
  // Each of these narrows which files jest discovers or runs.
  unmodeled: [
    '--rootDir',
    '--roots',
    '--testPathIgnorePatterns',
    '--shard',
    '--selectProjects',
    '--ignoreProjects',
  ],
});

const PYTEST = compile({
  bool: [
    '-x',
    '--exitfirst',
    '-v',
    '--verbose',
    '-q',
    '--quiet',
    '-s',
    '-l',
    '--showlocals',
    '--ff',
    '--failed-first',
    '--nf',
    '--new-first',
    '--no-header',
    '--no-summary',
    '--strict-markers',
    '--strict-config',
    '--disable-warnings',
    '--runxfail',
    '--pdb',
    '--trace',
    '--cache-clear',
    '--no-cov',
    '--full-trace',
    '--doctest-modules',
  ],
  value: [
    '-k',
    '-m',
    '-c',
    '-p',
    '-W',
    '-n',
    '-r',
    '--rootdir',
    '--confcutdir',
    '--junitxml',
    '--junit-xml',
    '--junit-prefix',
    '--tb',
    '--numprocesses',
    '--maxprocesses',
    '--maxfail',
    '--cov-report',
    '--cov-config',
    '--cov-fail-under',
    '--log-level',
    '--log-file',
    '--log-file-level',
    '--log-cli-level',
    '--log-format',
    '--durations',
    '--durations-min',
    '--pythonwarnings',
    '--basetemp',
    '--import-mode',
    '--dist',
    '--capture',
    '--timeout',
    '--reruns',
    '--reruns-delay',
    '--html',
    '--color',
    '--code-highlight',
    '--show-capture',
    '--count',
    '--randomly-seed',
  ],
  optional: ['--cov'],
  nonRun: [
    '-h',
    '--help',
    '-V',
    '--version',
    '--collect-only',
    '--co',
    '--fixtures',
    '--funcargs',
    '--fixtures-per-test',
    '--markers',
    '--setup-plan',
    '--setup-only',
    '--cache-show',
  ],
  // These skip named files or tests based on earlier runs or ignore lists.
  unmodeled: [
    // `-o addopts=...` injects options.
    '-o',
    '--override-ini',
    '--lf',
    '--last-failed',
    '--lfnf',
    '--last-failed-no-failures',
    '--sw',
    '--stepwise',
    '--stepwise-skip',
    '--deselect',
    '--ignore',
    '--ignore-glob',
  ],
  clusters: true,
});

const RSPEC = compile({
  bool: [
    '-b',
    '--backtrace',
    '--color',
    '--no-color',
    '--force-color',
    '-w',
    '--warnings',
    '--fail-fast',
    '--no-fail-fast',
    '--fail-fast',
    '--no-fail-fast',
    '--no-profile',
    '--force-colour',
    '--no-colour',
  ],
  value: [
    '-e',
    '--example',
    '-E',
    '--example-matches',
    '-t',
    '--tag',
    '-I',
    '-r',
    '--require',
    '-o',
    '--out',
    '-f',
    '--format',
    '--seed',
    '--order',
    '--default-path',
    '--failure-exit-code',
    '--error-exit-code',
    '--deprecation-out',
  ],
  // OptionParser: `--fail-fast[=COUNT]` only takes an attached value;
  // `--profile [COUNT]` takes the next word.
  optional: ['-p', '--profile'],
  nonRun: ['-h', '--help', '-v', '--version', '--dry-run', '--init', '--bisect'],
  unmodeled: [
    '--only-failures',
    '--next-failure',
    '-O',
    '--options',
    '-P',
    '--pattern',
    '--exclude-pattern',
  ],
});

const PLAYWRIGHT = compile({
  bool: [
    '--fail-on-flaky-tests',
    '--forbid-only',
    '--fully-parallel',
    '--headed',
    '--ignore-snapshots',
    '--no-deps',
    '--pass-with-no-tests',
    '--quiet',
    '--reporter-only-failures',
    '-x',
  ],
  value: [
    '--add-reporter',
    '-c',
    '--config',
    '--global-timeout',
    '-g',
    '--grep',
    '-G',
    '--grep-invert',
    '--max-failures',
    '--output',
    '--repeat-each',
    '--reporter',
    '--retries',
    '--run-agents',
    '--timeout',
    '--trace',
    '--tsconfig',
    '--update-source-method',
    '-j',
    '--workers',
  ],
  optional: ['--debug', '--shuffle', '-u', '--update-snapshots'],
  nonRun: ['-h', '--help', '--list', '--ui', '--ui-host', '--ui-port', '--only-changed'],
  unmodeled: [
    '--project',
    '--shard',
    '--last-failed',
    '--last-failed-file',
    '--test-list',
    '--test-list-invert',
  ],
});

const CYPRESS_RUN = compile({
  bool: [
    '--component',
    '--e2e',
    '--headed',
    '--headless',
    '--no-exit',
    '--parallel',
    '--pass-with-no-tests',
    '--posix-exit-codes',
    '-q',
    '--quiet',
    '--runner-ui',
    '--no-runner-ui',
  ],
  value: [
    '--auto-cancel-after-failures',
    '-b',
    '--browser',
    '--ci-build-id',
    '-C',
    '--config-file',
    '-e',
    '--env',
    '-x',
    '--expose',
    '--group',
    '-k',
    '--key',
    '-p',
    '--port',
    '-r',
    '--reporter',
    '-o',
    '--reporter-options',
    '-s',
    '--spec',
    '-t',
    '--tag',
  ],
  // `--project` makes spec paths relative to another root; not modeled.
  optional: ['--record'],
  nonRun: ['-h', '--help'],
  // `--config specPattern=...` changes which specs `--spec` may run.
  unmodeled: ['-P', '--project', '-c', '--config'],
});

/** `go test` flags, normalized to a single dash. */
const GO_TEST = compile({
  bool: [
    '-v',
    '-race',
    '-short',
    '-failfast',
    '-json',
    '-cover',
    '-a',
    '-x',
    '-trimpath',
    '-msan',
    '-asan',
    '-work',
    '-benchmem',
    '-fullpath',
    '-buildvcs',
  ],
  value: [
    '-run',
    '-skip',
    '-bench',
    '-count',
    '-timeout',
    '-tags',
    '-p',
    '-parallel',
    '-cpu',
    '-coverprofile',
    '-coverpkg',
    '-covermode',
    '-benchtime',
    '-shuffle',
    '-mod',
    '-modfile',
    '-ldflags',
    '-gcflags',
    '-asmflags',
    '-C',
    '-blockprofile',
    '-cpuprofile',
    '-memprofile',
    '-mutexprofile',
    '-outputdir',
    '-trace',
    '-fuzztime',
    '-vet',
    '-overlay',
    '-pkgdir',
    '-toolexec',
  ],
  // -c compiles, -n prints, -list lists, -fuzz fuzzes instead of testing.
  nonRun: ['-c', '-n', '-list', '-h', '-help', '-fuzz', '-o', '-args'],
  // `-exec prog` runs the test binary through prog, which may not run it.
  unmodeled: ['-exec'],
  chdir: ['-C'],
});

function unionSpecs(specs: CompiledSpec[]): CompiledSpec {
  // The runner behind a package script is unknown, so an option that any
  // runner treats as non-run, unmodeled or directory-moving (`-v` is vitest's
  // version flag but pytest's verbose; `-r` is vitest's root but pytest's
  // report chars) makes the invocation add nothing.
  const reject = new Set(specs.flatMap((s) => [...s.reject, ...s.chdir, ...s.scope]));
  const value = new Set(specs.flatMap((s) => [...s.value]).filter((o) => !reject.has(o)));
  const optional = new Set(
    specs.flatMap((s) => [...s.optional]).filter((o) => !value.has(o) && !reject.has(o)),
  );
  const bool = new Set(
    specs
      .flatMap((s) => [...s.bool])
      .filter((o) => !value.has(o) && !optional.has(o) && !reject.has(o)),
  );
  return { bool, value, optional, reject, chdir: new Set(), scope: new Set(), clusters: false };
}

/** For package scripts of an unknown runner. */
const SCRIPT = unionSpecs([VITEST, JEST, PYTEST, RSPEC, PLAYWRIGHT]);

/** Test-file shapes per runner; a kept file must match (directories pass). */
const JS_TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/.+\.[cm]?[jt]sx?$)/;
const TEST_FILE_PATTERNS: Record<TestRunner, RegExp> = {
  vitest: JS_TEST_FILE,
  jest: JS_TEST_FILE,
  playwright: JS_TEST_FILE,
  cypress: /\.(cy|spec|test)\.[cm]?[jt]sx?$/,
  pytest: /((^|\/)test_[^/]*|_test)\.py$/,
  rspec: /_spec\.rb$/,
  go: /_test\.go$/,
  script:
    /(\.(test|spec|cy)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/)|((^|\/)test_[^/]*\.py$)|(_test\.(py|go)$)|(_spec\.rb$)/,
};

/** Whether a repo-relative path has the shape of a test file for any supported runner. */
export function isTestFilePath(repoRelPath: string): boolean {
  return TEST_FILE_PATTERNS.script.test(repoRelPath);
}

function pushPositionals(parsed: RunnerArgs, runner: TestRunner, state: WalkState): void {
  for (const arg of parsed.positionals) {
    state.out.push({
      runner,
      base: parsed.base,
      arg,
      suiteRoot: parsed.base,
      ...('scope' in parsed ? { scope: parsed.scope } : {}),
    });
  }
}

function parseVitest(args: string[], state: WalkState): void {
  let a = args;
  const sub = a[0];
  if (
    sub === 'related' ||
    sub === 'bench' ||
    sub === 'list' ||
    sub === 'init' ||
    sub === 'typecheck'
  )
    return;
  if (sub === 'run' || sub === 'watch' || sub === 'dev') a = a.slice(1);
  const parsed = parseRunnerArgs(a, VITEST, state.cwd);
  if (parsed) pushPositionals(parsed, 'vitest', state);
}

function parseJest(args: string[], state: WalkState): void {
  const parsed = parseRunnerArgs(args, JEST, state.cwd);
  if (parsed) pushPositionals(parsed, 'jest', state);
}

function parsePytest(args: string[], state: WalkState): void {
  const parsed = parseRunnerArgs(args, PYTEST, state.cwd);
  if (parsed) pushPositionals(parsed, 'pytest', state);
}

function parseRspec(args: string[], state: WalkState): void {
  const parsed = parseRunnerArgs(args, RSPEC, state.cwd);
  if (parsed) pushPositionals(parsed, 'rspec', state);
}

function parsePlaywright(args: string[], state: WalkState): void {
  const parsed = parseRunnerArgs(args, PLAYWRIGHT, state.cwd);
  if (parsed) pushPositionals(parsed, 'playwright', state);
}

function parseCypress(args: string[], state: WalkState): void {
  const parsed = parseRunnerArgs(args, CYPRESS_RUN, state.cwd);
  // `cypress run` takes no positionals; anything else is a misparse.
  if (!parsed || parsed.positionals.length > 0) return;
  for (const [name, value] of parsed.options) {
    if ((name !== '--spec' && name !== '-s') || typeof value !== 'string') continue;
    if (value.startsWith('\0')) continue;
    for (const spec of value.split(',')) {
      const s = spec.trim();
      if (s) state.out.push({ runner: 'cypress', base: state.cwd, arg: s, suiteRoot: null });
    }
  }
}

function parseGoTest(args: string[], state: WalkState): void {
  // Go accepts `-flag` and `--flag`. `-args` forwards the rest to the test
  // binary (`-test.list`, `-test.run`, ...), which isn't modeled, so it
  // reaches GO_TEST's reject set like any other unmodeled option.
  const own = args.map((a) => (a.startsWith('--') && a.length > 2 ? a.slice(1) : a));
  const parsed = parseRunnerArgs(own, GO_TEST, state.cwd);
  if (!parsed) return;
  for (const p of parsed.positionals) {
    // `./x/...` names the directory tree x; `./...` alone is the whole module.
    const arg = p === '...' ? '.' : p.endsWith('/...') ? p.slice(0, -4) || '.' : p;
    state.out.push({ runner: 'go', base: parsed.base, arg, suiteRoot: parsed.base });
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Candidate spellings of one argument, most literal first: the argument
 * itself, then with a pytest `::node` id, an rspec `[1:2]` id, or a
 * `:line[:col]` suffix removed.
 */
function argCandidates(arg: string): string[] {
  const out = [arg];
  const node = arg.indexOf('::');
  if (node > 0) out.push(arg.slice(0, node));
  const bracket = arg.match(/^(.+?)\[[\d:,\s]+\]$/);
  if (bracket) out.push(bracket[1]);
  const line = arg.match(/^(.+?)(?::\d+)+$/);
  if (line) out.push(line[1]);
  return out;
}

function resolveTestArg(
  raw: RawTestArg,
  repoRoot: string,
  exists: HeadPathLookup,
): { path: string; kind: 'file' | 'dir' } | null {
  if (raw.arg.includes('\0') || raw.arg === '' || /[*?{}]/.test(raw.arg)) return null;
  for (const cand of argCandidates(raw.arg)) {
    const abs = resolveAgainst(raw.base, cand);
    if (abs === null) continue;
    const rel = repoRelative(repoRoot, abs);
    if (rel === null || rel === '') continue;
    if (raw.suiteRoot !== null && abs === raw.suiteRoot) return null;
    if ('scope' in raw) {
      // Outside the discovery bound the runner never finds the file.
      if (raw.scope == null || abs === raw.scope) return null;
      if (!abs.startsWith(`${raw.scope}/`)) return null;
    }
    const kind = exists(rel);
    // A file must look like a test for its runner; a stray config, log or
    // source file is never a test the session ran.
    if (kind === 'file' && !TEST_FILE_PATTERNS[raw.runner].test(rel)) return null;
    if (kind) return { path: rel, kind };
  }
  return null;
}
