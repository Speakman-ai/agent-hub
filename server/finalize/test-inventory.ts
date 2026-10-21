/**
 * Test inventory: which job instance (job + matrix shard) runs which test file.
 *
 * Dynamic test selection maps a selected test file to the instance that owns
 * it. That mapping is learned from JUnit XML, so it works for any runner and
 * needs no change to `ci.yaml` step scripts:
 *
 *   - Every step gets `FINALIZE_JUNIT_DIR` (one directory per instance). A job
 *     that writes JUnit there is "selectable"; one that doesn't has no
 *     inventory and always runs.
 *   - After an instance finishes, the job runner reads the XML back through the
 *     same `spawnStep` seam the steps used ({@link collectJunitFiles}), so the
 *     local DinD backend, the remote fleet and native host jobs all work the
 *     same way.
 *   - Only full CI runs on the default branch write the inventory
 *     ({@link shouldWriteTestInventory}). Session and selected runs never do.
 *   - {@link lookupTestInventory} returns the inventory for a base sha, or
 *     `stale` when the inventory's sha is not an ancestor of that base.
 *
 * Spec: wiki `finalize-dynamic-test-selection-spec`.
 */
import type Database from 'better-sqlite3';
import type { SpawnStepFn } from './step-runner.js';
import { FINALIZE_RUNNER_WORKSPACE } from './runner-images.js';
import { FINALIZE_JUNIT_DIR_ENV } from './runner-exec-args.js';
import { TEST_INVENTORY_SCHEMA_SQL } from './test-inventory-schema.js';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/** `git merge-base --is-ancestor`: true / false, or null when git can't tell. */
export type IsAncestorFn = (
  repoDir: string,
  ancestor: string,
  descendant: string,
  env?: NodeJS.ProcessEnv,
) => Promise<boolean | null>;

export const defaultIsAncestor: IsAncestorFn = async (repoDir, ancestor, descendant, env) => {
  if (ancestor === descendant) return true;
  try {
    await execFileP('git', ['-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant], {
      timeout: 30_000,
      ...(env ? { env } : {}),
    });
    return true;
  } catch (err) {
    // Exit 1 is "not an ancestor"; anything else (missing object) is unknown.
    return (err as { code?: unknown }).code === 1 ? false : null;
  }
};

// ── Per-instance JUnit directory ────────────────────────────────────────────

export { FINALIZE_JUNIT_DIR_ENV };

const JUNIT_ROOT = '/tmp/finalize-junit';

/**
 * Per-instance JUnit directory. Lives under /tmp, outside the workspace, so a
 * job that checks `git status` for a clean tree never sees it, and it is
 * unique per (run, job, shard) so native host jobs sharing one /tmp can't mix
 * their reports.
 */
export function junitDirForInstance(runId: string, jobId: string, matrixKey: string): string {
  // The readable slug is lossy (sanitized, truncated), so a hash of the exact
  // identity keeps `target=a/b` and `target=a-b` apart.
  const hash = createHash('sha256')
    .update(JSON.stringify([runId, jobId, matrixKey]))
    .digest('hex')
    .slice(0, 16);
  const slug = `${runId}-${jobId}-${matrixKey || 'default'}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 80);
  return `${JUNIT_ROOT}/${slug}-${hash}`;
}

// ── Collection (runs through spawnStep after the instance's steps) ──────────
//
// A collection is either provably complete or it is not used. The collector
// counts the reports first and ends with a DONE marker carrying that count;
// anything short of "DONE seen, count matches, nothing dropped" (file or size
// limits, stdout cap, timeout, non-zero exit, malformed block, runner gone)
// is incomplete, and an incomplete instance removes its whole job from the
// inventory (see writeTestInventory). A partial inventory would let selection
// skip a shard that owns tests the inventory never saw.

/** Step index for the collection command. Far above any real ci.yaml step. */
export const JUNIT_COLLECT_STEP_INDEX = 1_000_000;
/** Step index for the cleanup command run when nothing was collected. */
export const JUNIT_CLEANUP_STEP_INDEX = 1_000_001;

const FILE_MARKER = '@@FINALIZE_JUNIT_FILE ';
const END_MARKER = '@@FINALIZE_JUNIT_END';
const DONE_MARKER = '@@FINALIZE_JUNIT_DONE ';
const INCOMPLETE_MARKER = '@@FINALIZE_JUNIT_INCOMPLETE ';
export const JUNIT_MAX_FILES = 500;
const MAX_FILE_MB = 16;
/** Cap on captured collector stdout (base64 inflates the XML by a third). */
export const JUNIT_MAX_CAPTURE_CHARS = 48 * 1024 * 1024;
const DEFAULT_COLLECT_TIMEOUT_MS = 120_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;

/**
 * Bash that prints every `*.xml` under the JUnit dir as base64 between
 * markers, then a DONE marker with the file count, then removes the dir.
 * Every command that could lose a report is checked: a `find` that could not
 * traverse a subdirectory, a report it can't size or read, more than the file
 * limit, or a report over the size limit prints INCOMPLETE (which voids the
 * whole collection) and stops. Nothing is skipped silently. The list is read
 * from a temp file, not a pipe, so the loop runs in this shell and its
 * failure flag survives. `base64 | tr -d '\n'` works with both GNU and BSD
 * base64 (macOS native jobs); PIPESTATUS checks base64 itself.
 */
export const JUNIT_COLLECT_SCRIPT = [
  'set +e',
  `d="\${${FINALIZE_JUNIT_DIR_ENV}:-}"`,
  `inc() { printf '\\n${INCOMPLETE_MARKER}%s\\n' "$1"; }`,
  `if [ -z "$d" ] || [ ! -d "$d" ]; then printf '\\n${DONE_MARKER}0\\n'; exit 0; fi`,
  'list=$(mktemp 2>/dev/null) || { inc "could not create a temp file"; rm -rf "$d" 2>/dev/null; exit 0; }',
  `if ! find "$d" -type f -name '*.xml' > "$list" 2>/dev/null; then`,
  '  inc "could not read every directory under the JUnit dir"',
  '  rm -f "$list"; rm -rf "$d" 2>/dev/null; exit 0',
  'fi',
  'n=0; failed=0',
  'while IFS= read -r f; do',
  '  n=$((n + 1))',
  `  if [ "$n" -gt ${JUNIT_MAX_FILES} ]; then inc "more than ${JUNIT_MAX_FILES} report(s)"; failed=1; break; fi`,
  '  rel="${f#"$d"/}"',
  '  if ! sz=$(wc -c < "$f" 2>/dev/null); then inc "cannot read $rel"; failed=1; break; fi',
  // BSD wc pads the count with spaces.
  '  sz="${sz//[[:space:]]/}"',
  `  if [ "$sz" -ge ${MAX_FILE_MB * 1024 * 1024} ]; then inc "$rel is ${MAX_FILE_MB}MB or more"; failed=1; break; fi`,
  `  printf '\\n${FILE_MARKER}%s\\n' "$rel"`,
  `  base64 < "$f" 2>/dev/null | tr -d '\\n'`,
  '  if [ "${PIPESTATUS[0]}" -ne 0 ]; then inc "cannot read $rel"; failed=1; break; fi',
  `  printf '\\n${END_MARKER}\\n'`,
  'done < "$list"',
  `[ "$failed" -eq 0 ] && printf '\\n${DONE_MARKER}%s\\n' "$n"`,
  'rm -f "$list"; rm -rf "$d" 2>/dev/null',
  'exit 0',
].join('\n');

/** Removes the JUnit dir (native hosts keep /tmp across jobs). */
export const JUNIT_CLEANUP_SCRIPT = `d="\${${FINALIZE_JUNIT_DIR_ENV}:-}"; [ -n "$d" ] && rm -rf "$d" 2>/dev/null; exit 0`;

export interface JunitFile {
  /** Path relative to the JUnit dir. */
  name: string;
  xml: string;
}

export interface JunitCollection {
  files: JunitFile[];
  /** True only when every report in the dir was read back. */
  complete: boolean;
  /** Why the collection is incomplete. */
  reason?: string;
}

/** Parse the collector's stdout. Complete only with a matching DONE marker. */
export function parseJunitCollectorOutput(stdout: string): JunitCollection {
  const files: JunitFile[] = [];
  let malformed = 0;
  let doneCount: number | null = null;
  let incomplete: string | null = null;
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.startsWith(INCOMPLETE_MARKER)) {
      incomplete = line.slice(INCOMPLETE_MARKER.length).trim() || 'collector gave up';
      continue;
    }
    if (line.startsWith(DONE_MARKER)) {
      const n = Number.parseInt(line.slice(DONE_MARKER.length).trim(), 10);
      doneCount = Number.isFinite(n) ? n : -1;
      continue;
    }
    if (!line.startsWith(FILE_MARKER)) continue;
    const name = line.slice(FILE_MARKER.length).trim();
    const body = (lines[i + 1] ?? '').trim();
    const end = (lines[i + 2] ?? '').replace(/\r$/, '');
    if (end !== END_MARKER || !name || !/^[A-Za-z0-9+/=]*$/.test(body)) {
      malformed += 1;
      continue;
    }
    i += 2;
    files.push({ name, xml: Buffer.from(body, 'base64').toString('utf8') });
  }
  if (incomplete) return { files: [], complete: false, reason: incomplete };
  if (malformed > 0) {
    return { files: [], complete: false, reason: `${malformed} malformed report block(s)` };
  }
  if (doneCount === null) {
    return { files: [], complete: false, reason: 'collector output ended before DONE' };
  }
  if (doneCount !== files.length) {
    return {
      files: [],
      complete: false,
      reason: `collector found ${doneCount} report(s) but returned ${files.length}`,
    };
  }
  return { files, complete: true };
}

/** Spawn one helper command and capture its stdout, bounded. Never throws. */
async function runHelper(args: {
  spawnStep: SpawnStepFn;
  name: string;
  run: string;
  index: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxChars: number;
}): Promise<{ out: string; exitCode: number | null; failure?: string }> {
  let out = '';
  let failure: string | undefined;
  let exitCode: number | null = null;
  try {
    const child = args.spawnStep({
      step: { name: args.name, run: args.run },
      index: args.index,
      cwd: args.cwd,
      env: args.env,
      deadlineMs: args.timeoutMs,
    });
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (why?: string): void => {
        if (done) return;
        done = true;
        if (why) failure ??= why;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(`timed out after ${args.timeoutMs}ms`);
      }, args.timeoutMs);
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (failure) return;
        out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (out.length > args.maxChars) {
          out = '';
          failure = `output exceeded ${args.maxChars} chars`;
        }
      });
      child.on('close', (code: number | null) => {
        exitCode = code;
        finish();
      });
      child.on('error', (err: Error) => finish(`spawn error: ${err.message}`));
    });
  } catch (err) {
    failure = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { out, exitCode, ...(failure ? { failure } : {}) };
}

/**
 * Run the collector through the instance's `spawnStep`. Never throws; any
 * failure comes back as an incomplete collection, which removes the job from
 * the inventory (always runs). That only widens the gate.
 */
export async function collectJunitFiles(args: {
  spawnStep: SpawnStepFn;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Override the stdout cap (tests). */
  maxCaptureChars?: number;
}): Promise<JunitCollection> {
  const res = await runHelper({
    spawnStep: args.spawnStep,
    name: 'collect junit',
    run: JUNIT_COLLECT_SCRIPT,
    index: JUNIT_COLLECT_STEP_INDEX,
    cwd: args.cwd,
    env: args.env,
    timeoutMs: args.timeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS,
    maxChars: args.maxCaptureChars ?? JUNIT_MAX_CAPTURE_CHARS,
  });
  if (res.failure) return { files: [], complete: false, reason: res.failure };
  if (res.exitCode !== 0) {
    return { files: [], complete: false, reason: `collector exited ${String(res.exitCode)}` };
  }
  return parseJunitCollectorOutput(res.out);
}

/** Best-effort removal of the instance's JUnit dir. Never throws. */
export async function cleanupJunitDir(args: {
  spawnStep: SpawnStepFn;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  await runHelper({
    spawnStep: args.spawnStep,
    name: 'clean junit',
    run: JUNIT_CLEANUP_SCRIPT,
    index: JUNIT_CLEANUP_STEP_INDEX,
    cwd: args.cwd,
    env: args.env,
    timeoutMs: args.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    maxChars: 64 * 1024,
  });
}

// ── JUnit XML parsing ───────────────────────────────────────────────────────

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITY[e] ?? m;
  });
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return attrs;
}

const TEST_FILE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|feature|vue|svelte)$/;
const DOTTED_MODULE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

export interface ParseJunitOptions {
  /**
   * Absolute prefixes stripped from file paths so they become repo-relative
   * (jest-junit's `file` attribute is absolute). The runner workspace path is
   * always included.
   */
  workspaceRoots?: string[];
}

function normalizePath(raw: string, roots: string[]): string | null {
  let p = raw.trim().replace(/\\/g, '/');
  if (!p) return null;
  for (const root of roots) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (r && (p === r || p.startsWith(`${r}/`))) {
      p = p.slice(r.length + 1);
      break;
    }
  }
  // Still absolute after stripping the workspace roots: outside the repo.
  if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) return null;
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  if (!p || p.includes('\n') || p.split('/').includes('..')) return null;
  return p;
}

/**
 * pytest (xunit2) has no `file` attribute; its classname is the dotted module
 * plus any test class (`tests.unit.test_api.TestLogin`). Drop trailing class
 * segments and map the module to its file.
 */
function pythonModuleToFile(classname: string): string | null {
  if (!DOTTED_MODULE.test(classname)) return null;
  const segs = classname.split('.');
  while (segs.length > 1 && /^[A-Z]/.test(segs[segs.length - 1])) segs.pop();
  const mod = segs[segs.length - 1];
  // pytest's default discovery: test_*.py or *_test.py. A bare `test`/`tests`
  // segment is only accepted as a package under another segment.
  const isTestModule = /^test_|_test$/.test(mod) || (segs.length > 1 && /^tests?$/.test(mod));
  if (!isTestModule) return null;
  return `${segs.join('/')}.py`;
}

/** Which reporter shapes enclose a testcase; each unlocks one name mapping. */
interface ReporterShape {
  /** An enclosing suite carries go-junit-report's `go.version` property. */
  go: boolean;
  /** An enclosing suite is pytest's (default suite name `pytest`). */
  pytest: boolean;
}

/**
 * Turn a classname / suite name into a file path only when it is one in a
 * recognizable form, never by guessing:
 *   - a name ending in a test-file extension (vitest, Playwright, rspec);
 *   - inside a go-junit-report suite, a slash-separated package import path;
 *   - inside a pytest suite, a dotted test module (`tests.test_api.TestX`).
 * Anything else (jest describe titles, `api/users` outside a Go report, Java
 * class names) returns null, which leaves the testcase unattributed and the
 * instance incomplete.
 */
function pathFromName(name: string | undefined, shape: ReporterShape): string | null {
  const n = (name ?? '').trim();
  if (!n || /\s/.test(n)) return null;
  if (TEST_FILE_EXT.test(n)) return n;
  if (shape.go && n.includes('/')) return n;
  if (shape.pytest) return pythonModuleToFile(n);
  return null;
}

function hasGoVersionProperty(suite: XmlElement): boolean {
  return suite.children.some(
    (c) =>
      c.name === 'properties' &&
      c.children.some((p) => p.name === 'property' && p.attrs.name === 'go.version'),
  );
}

function shapeOf(suites: XmlElement[]): ReporterShape {
  return {
    go: suites.some(hasGoVersionProperty),
    pytest: suites.some((x) => x.attrs.name === 'pytest'),
  };
}

function hasTestcase(el: XmlElement): boolean {
  return el.children.some((c) => c.name === 'testcase' || hasTestcase(c));
}

/**
 * mocha-junit-reporter (Cypress) writes one spec per document: an empty
 * `Root Suite` carrying `file`, then sibling suites whose testcases name no
 * file. That file applies to those cases only in exactly this shape: one
 * such Root Suite directly under the root, and no other suite with a `file`
 * attribute. Anything else gets no document-wide file.
 */
function mochaRootSuiteFile(root: XmlElement): string | undefined {
  if (root.name !== 'testsuites') return undefined;
  const filed: XmlElement[] = [];
  const walk = (el: XmlElement): void => {
    if (el.name === 'testsuite' && el.attrs.file) filed.push(el);
    if (el.name !== 'testcase') el.children.forEach(walk);
  };
  walk(root);
  if (filed.length !== 1) return undefined;
  const [suite] = filed;
  const isRootSuite =
    root.children.includes(suite) && suite.attrs.name === 'Root Suite' && !hasTestcase(suite);
  return isRootSuite ? suite.attrs.file : undefined;
}

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const XML_TAG =
  /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;

/**
 * Parse an XML document into an element tree, or report why it is not
 * well-formed. Strict on structure (balanced, matching tags, one root, no
 * stray `<`), which is what catches a truncated or corrupt report; comments,
 * CDATA, processing instructions and the doctype are skipped. Text content is
 * ignored beyond checking it has no markup.
 */
export function parseXmlElements(xml: string): { root: XmlElement } | { error: string } {
  const src = xml.replace(/^\uFEFF/, '');
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const textOk = (text: string): string | null => {
    if (text.includes('<')) return 'stray "<" in text';
    if (stack.length === 0 && text.trim()) return 'text outside the root element';
    return null;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const text = src.slice(i, lt < 0 ? src.length : lt);
    const bad = textOk(text);
    if (bad) return { error: bad };
    if (lt < 0) break;
    const skip = (open: string, close: string): number | null => {
      if (!src.startsWith(open, lt)) return null;
      const endAt = src.indexOf(close, lt + open.length);
      return endAt < 0 ? -1 : endAt + close.length;
    };
    const skipped =
      skip('<!--', '-->') ??
      skip('<![CDATA[', ']]>') ??
      skip('<?', '?>') ??
      (src.startsWith('<!DOCTYPE', lt) ? skip('<!DOCTYPE', '>') : null);
    if (skipped !== null) {
      if (skipped < 0) return { error: 'unterminated comment, CDATA or declaration' };
      if (src.startsWith('<![CDATA[', lt) && stack.length === 0) {
        return { error: 'CDATA outside the root element' };
      }
      i = skipped;
      continue;
    }
    XML_TAG.lastIndex = lt;
    const m = XML_TAG.exec(src);
    if (!m) return { error: `malformed tag at offset ${lt}` };
    i = XML_TAG.lastIndex;
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      if (rawAttrs.trim() || selfClosing) return { error: `malformed closing tag </${name}>` };
      const open = stack.pop();
      if (!open || open.name !== name) {
        return { error: `</${name}> does not close <${open?.name ?? 'nothing'}>` };
      }
      continue;
    }
    const el: XmlElement = { name, attrs: parseAttrs(rawAttrs), children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) return { error: 'more than one root element' };
    else root = el;
    if (!selfClosing) stack.push(el);
  }
  if (stack.length > 0) return { error: `unclosed <${stack[stack.length - 1].name}>` };
  if (!root) return { error: 'no root element' };
  return { root };
}

/**
 * Distinct test files referenced by one JUnit XML document. Attribution is
 * explicit or nothing. Per testcase:
 *   1. An explicit `file` on the testcase, else on its nearest enclosing
 *      suite (jest-junit `addFileAttribute`, pytest xunit1, rspec), decides
 *      alone; if it is rejected the case is unattributed.
 *   2. Otherwise the classname, then each enclosing suite name, in a
 *      recognizable form (see {@link pathFromName}).
 *   3. Otherwise the file of a mocha / Cypress empty Root Suite, only in that
 *      exact document shape (see {@link mochaRootSuiteFile}).
 * Unattributed cases make the instance incomplete. Malformed XML yields
 * nothing.
 */
export function parseJunitTestFiles(xml: string, opts: ParseJunitOptions = {}): string[] {
  return analyzeJunitReport(xml, opts).files;
}

export interface JunitReportAnalysis {
  files: string[];
  /** False when the document is not well-formed JUnit (see `error`). */
  isJunit: boolean;
  /** Why the document was rejected, when it was. */
  error?: string;
  testcases: number;
  /** Testcases no file could be attributed to. */
  unattributed: number;
}

/** {@link parseJunitTestFiles} plus what is needed to judge completeness. */
export function analyzeJunitReport(xml: string, opts: ParseJunitOptions = {}): JunitReportAnalysis {
  const rejected = (error: string): JunitReportAnalysis => ({
    files: [],
    isJunit: false,
    error,
    testcases: 0,
    unattributed: 0,
  });
  const parsed = parseXmlElements(xml);
  if ('error' in parsed) return rejected(`malformed XML: ${parsed.error}`);
  const { root } = parsed;
  if (root.name !== 'testsuites' && root.name !== 'testsuite') {
    return rejected(`root element is <${root.name}>, not <testsuites> or <testsuite>`);
  }

  const roots = [...(opts.workspaceRoots ?? []), FINALIZE_RUNNER_WORKSPACE];
  const files = new Set<string>();
  const add = (raw: string | null | undefined): boolean => {
    if (!raw) return false;
    const p = normalizePath(raw, roots);
    if (!p) return false;
    files.add(p);
    return true;
  };

  const rootSuiteFile = mochaRootSuiteFile(root);

  let testcases = 0;
  let unattributed = 0;
  const visit = (el: XmlElement, suites: XmlElement[]): boolean => {
    if (el.name === 'testcase') {
      testcases += 1;
      // An explicit `file` (on the case, else its nearest suite) decides on its
      // own: if it is rejected (outside the workspace, `..`), the case stays
      // unattributed rather than falling through to a weaker guess.
      const explicit = el.attrs.file ?? [...suites].reverse().find((x) => x.attrs.file)?.attrs.file;
      const shape = shapeOf(suites);
      const found =
        explicit !== undefined
          ? add(explicit)
          : add(pathFromName(el.attrs.classname, shape)) ||
            [...suites].reverse().some((x) => add(pathFromName(x.attrs.name, shape))) ||
            add(rootSuiteFile);
      if (!found) unattributed += 1;
      return true;
    }
    const inner = el.name === 'testsuite' ? [...suites, el] : suites;
    let hasCase = false;
    for (const child of el.children) hasCase = visit(child, inner) || hasCase;
    // A suite with no testcases still names its file when it has one (vitest
    // writes an empty suite for a file whose tests all skip).
    // A rejected explicit `file` here adds nothing, but there are no cases
    // to lose either.
    if (el.name === 'testsuite' && !hasCase) {
      add(el.attrs.file ?? pathFromName(el.attrs.name, shapeOf(inner)));
    }
    return hasCase;
  };
  visit(root, []);

  return { files: [...files].sort(), isJunit: true, testcases, unattributed };
}

/**
 * What one instance's reports prove about its test set:
 *   - `reported`: at least one well-formed JUnit report, every testcase mapped
 *     to a file. An explicit zero-test report counts: it is evidence.
 *   - `no_reports`: no JUnit at all. That is absence of evidence, not "ran no
 *     tests" (the reporter may be off or misconfigured on this shard).
 *   - `incomplete`: reports exist but can't be trusted in full.
 */
export type InstanceJunitStatus = 'reported' | 'no_reports' | 'incomplete';

export interface JunitAttribution {
  files: string[];
  status: InstanceJunitStatus;
  reason?: string;
}

/**
 * Union of test files across every JUnit file one instance produced. All or
 * nothing: a report that isn't well-formed JUnit or has a testcase no file
 * could be attributed to (jest-junit without `addFileAttribute`, say) means
 * the instance's file set is unknown, so the result is `incomplete` and empty
 * rather than a subset. No reports at all is `no_reports`, never `reported`.
 */
export function testFilesFromJunit(
  files: JunitFile[],
  opts: ParseJunitOptions = {},
): JunitAttribution {
  if (files.length === 0) return { files: [], status: 'no_reports' };
  const all = new Set<string>();
  const incomplete = (reason: string): JunitAttribution => ({
    files: [],
    status: 'incomplete',
    reason,
  });
  for (const f of files) {
    let a: JunitReportAnalysis;
    try {
      a = analyzeJunitReport(f.xml, opts);
    } catch (err) {
      return incomplete(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!a.isJunit) return incomplete(`${f.name}: ${a.error ?? 'not a JUnit report'}`);
    if (a.unattributed > 0) {
      return incomplete(`${f.name}: ${a.unattributed} of ${a.testcases} testcase(s) name no file`);
    }
    for (const p of a.files) all.add(p);
  }
  return { files: [...all].sort(), status: 'reported' };
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function ensureTestInventorySchema(db: Database.Database): void {
  db.exec(TEST_INVENTORY_SCHEMA_SQL);
}

export interface InstanceJunitReport {
  jobId: string;
  matrixKey: string;
  testFiles: string[];
  /**
   * `reported` only when the instance passed and its JUnit proves its whole
   * test set (see {@link InstanceJunitStatus}). Infra errors, cancels,
   * skipped instances and failed instances (which may have bailed early) are
   * `incomplete`.
   */
  status: InstanceJunitStatus;
  reason?: string;
}

/**
 * Jobs that keep inventory rows: every instance is `reported`. One shard
 * with no reports or an incomplete one drops the whole job, so it has no
 * inventory and always runs; a job whose instances all lack JUnit simply
 * isn't selectable.
 */
export function inventoriedJobs(reports: InstanceJunitReport[]): Set<string> {
  const unproven = new Set(reports.filter((r) => r.status !== 'reported').map((r) => r.jobId));
  return new Set(reports.map((r) => r.jobId).filter((j) => !unproven.has(j)));
}

export interface TestInventoryEntry {
  jobId: string;
  matrixKey: string;
  testFile: string;
}

/**
 * Inventory writes are gated here, in one place. Only a full CI run of the
 * default branch (push CI's `git_push` trigger, no job filter, no selection)
 * that produced real results may replace the inventory. Session Finalize runs,
 * PR CI, per-job re-runs, selected runs, cancels and infra errors never do.
 */
export function shouldWriteTestInventory(args: {
  trigger: string | null | undefined;
  branch: string;
  defaultBranch: string;
  fullRun: boolean;
  status: 'success' | 'failure' | 'timeout' | 'infra_error' | 'cancelled';
}): boolean {
  if (args.trigger !== 'git_push') return false;
  if (!args.fullRun) return false;
  if (!args.defaultBranch || args.branch !== args.defaultBranch) return false;
  return args.status === 'success' || args.status === 'failure' || args.status === 'timeout';
}

/**
 * Replace the project's inventory with this run's reports, atomically. The
 * snapshot is whole: a job that wrote no JUnit this run has no rows, so it
 * reads as "no inventory" (always runs) instead of keeping stale files, and
 * so does any job with an incomplete instance: its instances are dropped
 * whole rather than written partially.
 */
export function writeTestInventory(
  db: Database.Database,
  args: {
    projectId: string;
    branch: string;
    sha: string;
    runId: string;
    reports: InstanceJunitReport[];
    now?: number;
    /**
     * Compare-and-swap guard: write only if the recorded sha is still this
     * (`null` = nothing recorded). Omit to write unconditionally.
     */
    expectedSha?: string | null;
  },
): boolean {
  const now = args.now ?? Date.now();
  const current = db.prepare('SELECT sha FROM finalize_test_inventory_state WHERE project_id = ?');
  const del = db.prepare('DELETE FROM finalize_test_inventory WHERE project_id = ?');
  const ins = db.prepare(
    `INSERT OR IGNORE INTO finalize_test_inventory (project_id, job_id, matrix_key, test_file, sha)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const state = db.prepare(
    `INSERT INTO finalize_test_inventory_state (project_id, branch, sha, run_id, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       branch = excluded.branch, sha = excluded.sha,
       run_id = excluded.run_id, recorded_at = excluded.recorded_at`,
  );
  const keep = inventoriedJobs(args.reports);
  return db.transaction((): boolean => {
    if (args.expectedSha !== undefined) {
      const row = current.get(args.projectId) as { sha: string } | undefined;
      if ((row?.sha ?? null) !== args.expectedSha) return false;
    }
    del.run(args.projectId);
    for (const r of args.reports) {
      if (!keep.has(r.jobId)) continue;
      for (const f of r.testFiles) ins.run(args.projectId, r.jobId, r.matrixKey, f, args.sha);
    }
    state.run(args.projectId, args.branch, args.sha, args.runId, now);
    return true;
  })();
}

export interface TestInventoryState {
  branch: string;
  sha: string;
  runId: string | null;
  recordedAt: number;
}

export function readTestInventory(
  db: Database.Database,
  projectId: string,
): { state: TestInventoryState; entries: TestInventoryEntry[] } | null {
  const row = db
    .prepare('SELECT * FROM finalize_test_inventory_state WHERE project_id = ?')
    .get(projectId) as
    | { branch: string; sha: string; run_id: string | null; recorded_at: number }
    | undefined;
  if (!row) return null;
  const rows = db
    .prepare(
      `SELECT job_id, matrix_key, test_file FROM finalize_test_inventory
        WHERE project_id = ? ORDER BY job_id, matrix_key, test_file`,
    )
    .all(projectId) as Array<{ job_id: string; matrix_key: string; test_file: string }>;
  return {
    state: { branch: row.branch, sha: row.sha, runId: row.run_id, recordedAt: row.recorded_at },
    entries: rows.map((r) => ({ jobId: r.job_id, matrixKey: r.matrix_key, testFile: r.test_file })),
  };
}

export type TestInventoryLookup =
  | { status: 'ok'; sha: string; branch: string; recordedAt: number; entries: TestInventoryEntry[] }
  | { status: 'stale'; sha: string; branch: string; recordedAt: number; reason: string }
  | { status: 'missing' };

/**
 * The inventory usable for a session whose base is `baseSha`. It is `stale`
 * when its sha is not an ancestor of the base (or git can't tell), since
 * hash- and count-based sharding moves files between shards as the file set
 * changes. Callers treat both `stale` and `missing` as a forced full run.
 */
export async function lookupTestInventory(
  db: Database.Database,
  args: {
    projectId: string;
    baseSha: string;
    repoDir: string;
    isAncestor?: IsAncestorFn;
    env?: NodeJS.ProcessEnv;
  },
): Promise<TestInventoryLookup> {
  const inv = readTestInventory(db, args.projectId);
  if (!inv) return { status: 'missing' };
  const { sha, branch, recordedAt } = inv.state;
  const isAncestor = args.isAncestor ?? defaultIsAncestor;
  let ancestor: boolean | null;
  try {
    ancestor = await isAncestor(args.repoDir, sha, args.baseSha, args.env);
  } catch {
    ancestor = null;
  }
  if (ancestor !== true) {
    return {
      status: 'stale',
      sha,
      branch,
      recordedAt,
      reason:
        ancestor === false
          ? `inventory sha ${sha.slice(0, 12)} is not an ancestor of base ${args.baseSha.slice(0, 12)}`
          : `could not tell whether inventory sha ${sha.slice(0, 12)} is an ancestor of base ${args.baseSha.slice(0, 12)}`,
    };
  }
  return { status: 'ok', sha, branch, recordedAt, entries: inv.entries };
}

/**
 * Record one finished default-branch run's JUnit reports. Applies the write
 * gate, then skips a run for a commit that is an ancestor of the sha already
 * recorded, or whose ancestry git can't determine (a re-run of an old commit
 * must not roll the inventory back).
 * Returns whether the inventory was written.
 */
export async function recordTestInventoryFromRun(
  db: Database.Database,
  args: {
    projectId: string;
    trigger: string | null | undefined;
    branch: string;
    defaultBranch: string;
    fullRun: boolean;
    status: 'success' | 'failure' | 'timeout' | 'infra_error' | 'cancelled';
    headSha: string;
    runId: string;
    reports: InstanceJunitReport[];
    repoDir: string;
    isAncestor?: IsAncestorFn;
    now?: number;
  },
): Promise<boolean> {
  if (!shouldWriteTestInventory(args)) return false;
  const isAncestor = args.isAncestor ?? defaultIsAncestor;
  // The ancestry check is async, so another run can record in between. Each
  // write is a compare-and-swap against the sha that was checked; a lost race
  // re-checks against the new snapshot.
  for (let attempt = 0; attempt < 5; attempt++) {
    const recorded = readTestInventory(db, args.projectId)?.state.sha ?? null;
    if (recorded !== null && recorded !== args.headSha) {
      const older = await isAncestor(args.repoDir, args.headSha, recorded).catch(() => null);
      // Older than what's recorded, or git can't tell: keep the snapshot.
      if (older !== false) return false;
    }
    const wrote = writeTestInventory(db, {
      projectId: args.projectId,
      branch: args.branch,
      sha: args.headSha,
      runId: args.runId,
      reports: args.reports,
      expectedSha: recorded,
      ...(args.now !== undefined ? { now: args.now } : {}),
    });
    if (wrote) return true;
  }
  return false;
}
