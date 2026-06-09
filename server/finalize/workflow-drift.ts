/**
 * workflow-drift.ts — detect drift between `.github/workflows/*.yml` (the
 * literal GitHub Actions gate) and `.agent-hub/ci.yaml` (what the Finalize gate
 * actually runs).
 *
 * Why this exists
 * ----------------
 * The Finalize gate stands in for the GitHub PR check, but it runs a SEPARATE
 * config (`.agent-hub/ci.yaml`). The two can silently diverge: someone adds a
 * job to `ci.yml`, the Finalize config never learns about it, and Finalize goes
 * green on a change GitHub would have failed (the exact false-green class the
 * GitHub-parity work exists to close — see the "Finalize↔GitHub Parity Harness"
 * wiki page).
 *
 * Naive equality does not work here. For agent-hub itself the two configs
 * INTENTIONALLY diverge: GitHub's PR gate runs build + typecheck only, while
 * Finalize runs the full test suite. So drift is computed against an EXPLICIT
 * mirror mapping authored in a SIDECAR file (`.agent-hub/ci-mirror.yaml`), not
 * against a literal diff and NOT inside ci.yaml — see {@link WorkflowMirrorManifest}
 * for why the sidecar matters (ci.yaml fails closed on unknown keys).
 *
 * Contract
 * --------
 * When there is no `.agent-hub/ci-mirror.yaml`, the repo is "not configured for
 * drift checking" and this returns a neutral report (no findings). When it IS
 * configured:
 *   - every in-scope GitHub job must be either mapped by a ci.yaml job or
 *     listed in `ignore`       → otherwise `unmapped_github_job` (error);
 *   - every ci.yaml job must appear in the manifest's `jobs` map (a
 *     `<file>:<jobId>` ref or `finalize-only`) → else `unannotated_ci_job` (error);
 *   - a `jobs` entry for a ci.yaml job that doesn't exist → `unknown_ci_job` (error);
 *   - a mirror ref pointing at a GitHub job that no longer exists is a
 *     `stale_mirror_target` (error); same for a stale `ignore` entry (warning);
 *   - for a strict mirror, the meaningful gate commands (lint/test/build/…,
 *     install scaffolding excluded) are compared and any difference surfaces as
 *     a `command_drift` warning. Append ` (loose)` to a mirror ref to assert
 *     job existence without comparing commands.
 *
 * Errors fail the gate; warnings are advisory. The module is pure (text in,
 * report out); the thin filesystem loader and the CLI wrapper live elsewhere
 * (`loadGithubWorkflows` here, `scripts/check-workflow-drift.ts`).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { CiConfigV2 } from './ci-config.js';

/**
 * Mirror manifest — the EXPLICIT mapping between this repo's `.agent-hub/ci.yaml`
 * jobs and the `.github/workflows/*.yml` jobs they stand in for.
 *
 * It lives in a SIDECAR file (`.agent-hub/ci-mirror.yaml`), NOT inside ci.yaml.
 * That is deliberate: the ci.yaml parser (server/finalize/ci-config.ts) fails
 * CLOSED on unknown keys, and the Finalize orchestrator parses ci.yaml IN
 * PROCESS with whatever server build is deployed. Putting drift metadata inside
 * ci.yaml would make the execution config unparseable by every Hub that hasn't
 * yet shipped the matching schema change — a forward-compatibility break that
 * fails the gate for the very change that introduces it. A sidecar keeps the
 * execution config schema-stable and decouples the drift tool entirely.
 */
export interface WorkflowMirrorManifest {
  /** GitHub workflow filenames in scope for drift (e.g. `ci.yml`). */
  workflows: string[];
  /** `<file>:<jobId>` GitHub jobs intentionally not mirrored by Finalize. */
  ignore: string[];
  /**
   * Map of ci.yaml job id → mirror ref. Each value is a GitHub `<file>:<jobId>`
   * ref (optionally suffixed ` (loose)` to assert existence without comparing
   * commands) or the literal `finalize-only`.
   */
  jobs: Record<string, string>;
}

export interface GithubWorkflowJob {
  jobId: string;
  /** GHA `jobs.<id>.name`, when present. */
  name?: string;
  /** GHA `jobs.<id>.runs-on`, when a plain string. */
  runsOn?: string;
  /** Raw `run:` script of each step that declares one, in order. */
  runScripts: string[];
}

export interface GithubWorkflow {
  filename: string;
  /** GHA top-level `name`, when present. */
  name?: string;
  jobs: GithubWorkflowJob[];
  /**
   * Set when the file could not be parsed into a workflow (YAML syntax error,
   * or a root that isn't a mapping). The jobs list is empty in that case, but
   * an empty list here means "could not inspect" — NOT "inspected, no jobs".
   * The drift checker turns this into a blocking `workflow_parse_error` for any
   * in-scope workflow, so a broken GitHub gate can't masquerade as no-drift.
   */
  parseError?: string;
}

export type DriftKind =
  | 'unmapped_github_job'
  | 'unannotated_ci_job'
  | 'unknown_ci_job'
  | 'stale_mirror_target'
  | 'stale_ignore'
  | 'bad_mirror_ref'
  | 'workflow_parse_error'
  | 'command_drift';

export type DriftSeverity = 'error' | 'warning';

export interface DriftFinding {
  kind: DriftKind;
  severity: DriftSeverity;
  /** `<file>:<jobId>` for a GitHub side, or `jobs.<id>` for a ci.yaml side. */
  ref: string;
  message: string;
  /** Populated for `command_drift`. */
  detail?: { onlyInGithub?: string[]; onlyInCi?: string[] };
}

export interface MirrorMatch {
  ciJob: string;
  githubRef: string;
  /** false when the mirror ref carried ` (loose)`. */
  comparedCommands: boolean;
}

export interface WorkflowDriftReport {
  /** True when there is no `.agent-hub/ci-mirror.yaml` — checker is a no-op. */
  notConfigured: boolean;
  findings: DriftFinding[];
  matches: MirrorMatch[];
  /** Any `error`-severity finding present. This is the gate signal. */
  hasBlockingDrift: boolean;
  /** Any `warning`-severity finding present. */
  hasWarnings: boolean;
}

// ─── GitHub workflow parsing ──────────────────────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a single `.github/workflows/*.yml` document into its jobs and the raw
 * `run:` scripts of each step. Tolerant by design: a malformed file yields an
 * empty job list with `parseError` set rather than throwing, so one broken
 * workflow can't crash the whole drift check — but the error is PRESERVED, not
 * swallowed, so the drift checker can flag a workflow it could not inspect as
 * blocking drift (an unparseable GitHub gate must not read as "no drift").
 *
 * An empty document (`null`/comment-only) is NOT a parse error — there is
 * genuinely nothing to inspect, which is unambiguous.
 */
export function parseGithubWorkflow(text: string, filename: string): GithubWorkflow {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return {
      filename,
      jobs: [],
      parseError: `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (doc === null || doc === undefined) {
    return { filename, jobs: [] }; // empty / comment-only file — nothing to inspect
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      filename,
      jobs: [],
      parseError: `workflow root is not a mapping (got ${Array.isArray(doc) ? 'array' : typeof doc}).`,
    };
  }
  const root = doc as Record<string, unknown>;
  const wfName = asString(root.name);
  const jobsRaw = root.jobs;
  const jobs: GithubWorkflowJob[] = [];
  if (jobsRaw && typeof jobsRaw === 'object' && !Array.isArray(jobsRaw)) {
    for (const [jobId, jobRaw] of Object.entries(jobsRaw as Record<string, unknown>)) {
      if (!jobRaw || typeof jobRaw !== 'object' || Array.isArray(jobRaw)) {
        jobs.push({ jobId, runScripts: [] });
        continue;
      }
      const jobObj = jobRaw as Record<string, unknown>;
      const runScripts: string[] = [];
      const stepsRaw = jobObj.steps;
      if (Array.isArray(stepsRaw)) {
        for (const stepRaw of stepsRaw) {
          if (!stepRaw || typeof stepRaw !== 'object' || Array.isArray(stepRaw)) continue;
          const run = (stepRaw as Record<string, unknown>).run;
          if (typeof run === 'string' && run.trim().length > 0) runScripts.push(run);
        }
      }
      jobs.push({
        jobId,
        ...(asString(jobObj.name) ? { name: asString(jobObj.name) } : {}),
        ...(asString(jobObj['runs-on']) ? { runsOn: asString(jobObj['runs-on']) } : {}),
        runScripts,
      });
    }
  }
  return { filename, ...(wfName ? { name: wfName } : {}), jobs };
}

/**
 * Read and parse every `*.yml` / `*.yaml` file in a `.github/workflows`
 * directory. Returns an empty list (not an error) when the directory is absent,
 * so a repo with no GitHub workflows simply has nothing to drift against.
 * Sorted by filename for deterministic output.
 */
export async function loadGithubWorkflows(workflowsDir: string): Promise<GithubWorkflow[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(workflowsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const files = entries.filter((f) => /\.ya?ml$/i.test(f)).sort();
  const out: GithubWorkflow[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(workflowsDir, file), 'utf8');
    out.push(parseGithubWorkflow(text, file));
  }
  return out;
}

// ─── Mirror manifest (sidecar) parsing ────────────────────────────────

export type MirrorManifestParseResult =
  | { ok: true; manifest: WorkflowMirrorManifest }
  | { ok: false; error: string };

function parseStringArray(raw: unknown, field: string): string[] | { error: string } {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return { error: `'${field}' must be a list of strings.` };
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'string' || v.trim().length === 0) {
      return { error: `'${field}[${i}]' must be a non-empty string.` };
    }
    out.push(v.trim());
  }
  return out;
}

/**
 * Parse a `.agent-hub/ci-mirror.yaml` document. Pure (text in, result out).
 * Shape:
 *   workflows: [ci.yml, ...]      # optional, defaults to []
 *   ignore:    [ci.yml:ci, ...]   # optional, defaults to []
 *   jobs:      { build: ci.yml:build, test: finalize-only }   # required mapping
 */
export function parseMirrorManifest(text: string): MirrorManifestParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return {
      ok: false,
      error: `could not parse as YAML: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (doc === null || doc === undefined) {
    return { ok: false, error: 'manifest is empty; expected a mapping with a `jobs` field.' };
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'manifest must be a top-level mapping.' };
  }
  const root = doc as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!['workflows', 'ignore', 'jobs'].includes(key)) {
      return { ok: false, error: `unknown key '${key}' (allowed: workflows, ignore, jobs).` };
    }
  }
  const workflows = parseStringArray(root.workflows, 'workflows');
  if (!Array.isArray(workflows)) return { ok: false, error: workflows.error };
  const ignore = parseStringArray(root.ignore, 'ignore');
  if (!Array.isArray(ignore)) return { ok: false, error: ignore.error };

  const jobsRaw = root.jobs;
  if (jobsRaw === null || jobsRaw === undefined) {
    return { ok: false, error: "missing required 'jobs' mapping (ci.yaml job id → mirror ref)." };
  }
  if (typeof jobsRaw !== 'object' || Array.isArray(jobsRaw)) {
    return { ok: false, error: "'jobs' must be a mapping of ci.yaml job id → mirror ref." };
  }
  const jobs: Record<string, string> = {};
  for (const [jobId, ref] of Object.entries(jobsRaw as Record<string, unknown>)) {
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      return { ok: false, error: `'jobs.${jobId}' must be a non-empty string mirror ref.` };
    }
    jobs[jobId] = ref.trim();
  }
  return { ok: true, manifest: { workflows, ignore, jobs } };
}

export type MirrorManifestLoadResult =
  | { ok: true; manifest: WorkflowMirrorManifest | null } // null → file absent (not configured)
  | { ok: false; error: string };

/**
 * Read and parse `.agent-hub/ci-mirror.yaml`. Returns `manifest: null` (ok) when
 * the file is absent — the repo simply isn't configured for drift checking.
 */
export async function loadMirrorManifest(manifestPath: string): Promise<MirrorManifestLoadResult> {
  let text: string;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, manifest: null };
    return {
      ok: false,
      error: `could not read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parseMirrorManifest(text);
  if (!parsed.ok) return { ok: false, error: `${manifestPath}: ${parsed.error}` };
  return { ok: true, manifest: parsed.manifest };
}

// ─── Command canonicalization ─────────────────────────────────────────

/**
 * Shell scaffolding lines that carry no gate semantics. Retry loops, control
 * flow, and pure logging differ freely between a GHA workflow (which wraps
 * `npm ci` in a 4-attempt retry loop) and a Finalize step (a bare command) —
 * comparing them would be all noise. Dropping them lets the comparison focus on
 * the actual build/test/lint commands.
 */
const SCAFFOLDING_RE =
  /^(for\b|do\b|done\b|while\b|until\b|if\b|then\b|else\b|elif\b|fi\b|case\b|esac\b|sleep\b|echo\b|exit\b|set\s+-|cd\s+\S+\s*$|\)\s*$|\{\s*$|\}\s*$|;;\s*$)/;

/** Package-manager install / native-rebuild commands — structural, not gate logic. */
const INSTALL_RE = /^(npm\s+(ci|install|i|rebuild)\b|yarn\s+(install)?\b|pnpm\s+(install|i)\b)/;

/**
 * Reduce a step's `run` script to the SET of meaningful gate commands it runs.
 *
 * Normalisation, line by line:
 *   - drop blank lines, comments, and scaffolding (retry loops, control flow);
 *   - drop lines containing a GHA `${{ … }}` context expression (GitHub-only,
 *     never present on the Finalize side);
 *   - peel a wrapping subshell: `(cd x && npm test)` → `cd x && npm test`;
 *   - strip a trailing `&& exit 0` (retry-loop success marker);
 *   - collapse internal whitespace;
 *   - drop package-manager install commands (every job installs differently;
 *     install parity is not what drift is about).
 */
export function canonicalCommands(runScripts: string[]): Set<string> {
  const out = new Set<string>();
  for (const script of runScripts) {
    for (const rawLine of script.split('\n')) {
      let line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      if (line.includes('${{')) continue;
      // Strip a retry-loop success marker first, so a wrapped "(...) && exit 0"
      // reduces to "(...)" before paren-peeling.
      line = line.replace(/\s*&&\s*exit\s+0\s*$/, '').trim();
      // Peel one layer of subshell parens: "(cd x && cmd)" → "cd x && cmd".
      if (line.startsWith('(') && line.endsWith(')')) {
        line = line.slice(1, -1).trim();
      } else if (line.startsWith('(')) {
        line = line.slice(1).trim();
      }
      if (line.length === 0) continue;
      if (SCAFFOLDING_RE.test(line)) continue;
      // Collapse whitespace runs to single spaces.
      const normalized = line.replace(/\s+/g, ' ');
      // Install/rebuild scaffolding — drop whether or not it has a cd prefix.
      const afterCd = normalized.replace(/^cd\s+\S+\s*&&\s*/, '');
      if (INSTALL_RE.test(afterCd)) continue;
      out.add(normalized);
    }
  }
  return out;
}

// ─── Mirror ref parsing ───────────────────────────────────────────────

interface ParsedMirrorRef {
  kind: 'finalize-only' | 'github' | 'invalid';
  /** `<file>:<jobId>` when kind === 'github'. */
  githubRef?: string;
  /** true when the ref carried ` (loose)`. */
  loose?: boolean;
}

const FINALIZE_ONLY = 'finalize-only';

/** Parse a per-job `mirror:` annotation string. */
export function parseMirrorRef(raw: string): ParsedMirrorRef {
  let value = raw.trim();
  let loose = false;
  const looseMatch = value.match(/\s*\(\s*loose\s*\)\s*$/i);
  if (looseMatch) {
    loose = true;
    value = value.slice(0, looseMatch.index).trim();
  }
  if (value.toLowerCase() === FINALIZE_ONLY) {
    return { kind: 'finalize-only' };
  }
  // `<file>:<jobId>` — file ends in .yml/.yaml, jobId is a GHA id.
  const m = value.match(/^([\w.-]+\.ya?ml):([\w.-]+)$/);
  if (m) {
    return { kind: 'github', githubRef: `${m[1]}:${m[2]}`, loose };
  }
  return { kind: 'invalid' };
}

// ─── Drift computation ────────────────────────────────────────────────

function buildGithubJobIndex(
  workflows: GithubWorkflow[],
  scope: Set<string> | null,
): Map<string, GithubWorkflowJob> {
  const index = new Map<string, GithubWorkflowJob>();
  for (const wf of workflows) {
    if (scope && !scope.has(wf.filename)) continue;
    for (const job of wf.jobs) {
      index.set(`${wf.filename}:${job.jobId}`, job);
    }
  }
  return index;
}

export interface ComputeDriftInput {
  ciConfig: CiConfigV2;
  /** Parsed `.agent-hub/ci-mirror.yaml`, or null when absent (not configured). */
  manifest: WorkflowMirrorManifest | null;
  workflows: GithubWorkflow[];
}

/**
 * Compute the drift report. Pure: no filesystem, no process state.
 */
export function computeWorkflowDrift({
  ciConfig,
  manifest,
  workflows,
}: ComputeDriftInput): WorkflowDriftReport {
  if (!manifest) {
    return {
      notConfigured: true,
      findings: [],
      matches: [],
      hasBlockingDrift: false,
      hasWarnings: false,
    };
  }

  const findings: DriftFinding[] = [];
  const matches: MirrorMatch[] = [];

  // In-scope GitHub jobs. When `workflows` is declared, restrict to it; else
  // every parsed workflow is in scope.
  const scope = manifest.workflows.length > 0 ? new Set(manifest.workflows) : null;
  const githubJobs = buildGithubJobIndex(workflows, scope);

  // An in-scope workflow that failed to parse is BLOCKING drift: we could not
  // inspect the GitHub gate at all, so we cannot certify "no drift". This must
  // outrank the benign-looking signals it would otherwise degrade into (e.g. an
  // ignore entry for one of its jobs reading as a mere stale_ignore warning).
  for (const wf of workflows) {
    if (scope && !scope.has(wf.filename)) continue;
    if (wf.parseError) {
      findings.push({
        kind: 'workflow_parse_error',
        severity: 'error',
        ref: wf.filename,
        message: `GitHub workflow '${wf.filename}' could not be parsed (${wf.parseError}); drift cannot be verified against it.`,
      });
    }
  }

  // A declared scope that names a workflow with zero parsed jobs (missing file
  // or unparseable) is itself drift — the mirror points at nothing.
  if (scope) {
    const present = new Set(workflows.map((w) => w.filename));
    for (const wf of scope) {
      if (!present.has(wf)) {
        findings.push({
          kind: 'stale_mirror_target',
          severity: 'error',
          ref: wf,
          message: `ci-mirror.yaml 'workflows' lists '${wf}' but no such workflow file was found in .github/workflows.`,
        });
      }
    }
  }

  // A manifest 'jobs' entry for a ci.yaml job that doesn't exist → typo/stale.
  for (const mappedJobId of Object.keys(manifest.jobs)) {
    if (!(mappedJobId in ciConfig.jobs)) {
      findings.push({
        kind: 'unknown_ci_job',
        severity: 'error',
        ref: `jobs.${mappedJobId}`,
        message: `ci-mirror.yaml maps job '${mappedJobId}', which does not exist in .agent-hub/ci.yaml.`,
      });
    }
  }

  // Track which GitHub jobs got claimed by a mirror mapping or an ignore entry.
  const claimed = new Set<string>();

  // ── ci.yaml jobs → mirror mapping (from the sidecar manifest) ──
  for (const [jobId, job] of Object.entries(ciConfig.jobs)) {
    const ciRef = `jobs.${jobId}`;
    const mirrorRef = manifest.jobs[jobId];
    if (!mirrorRef) {
      findings.push({
        kind: 'unannotated_ci_job',
        severity: 'error',
        ref: ciRef,
        message: `ci.yaml job '${jobId}' is not mapped in ci-mirror.yaml. Add a 'jobs.${jobId}:' entry with a GitHub '<file>:<jobId>' ref or 'finalize-only'.`,
      });
      continue;
    }
    const parsed = parseMirrorRef(mirrorRef);
    if (parsed.kind === 'invalid') {
      findings.push({
        kind: 'bad_mirror_ref',
        severity: 'error',
        ref: ciRef,
        message: `ci-mirror.yaml job '${jobId}' has an unparseable mirror ref '${mirrorRef}'. Expected '<file>.yml:<jobId>', '<file>.yml:<jobId> (loose)', or 'finalize-only'.`,
      });
      continue;
    }
    if (parsed.kind === 'finalize-only') {
      continue; // no GitHub counterpart expected
    }
    const githubRef = parsed.githubRef!;
    claimed.add(githubRef);
    const githubJob = githubJobs.get(githubRef);
    if (!githubJob) {
      findings.push({
        kind: 'stale_mirror_target',
        severity: 'error',
        ref: ciRef,
        message: `ci-mirror.yaml job '${jobId}' mirrors '${githubRef}', which no longer exists in .github/workflows (job removed/renamed, or its file is out of 'workflows' scope).`,
      });
      continue;
    }
    matches.push({ ciJob: jobId, githubRef, comparedCommands: !parsed.loose });
    if (parsed.loose) continue;

    // Strict mirror → compare meaningful gate commands.
    const githubCmds = canonicalCommands(githubJob.runScripts);
    const ciCmds = canonicalCommands(job.steps.map((s) => s.run));
    const onlyInGithub = [...githubCmds].filter((c) => !ciCmds.has(c)).sort();
    const onlyInCi = [...ciCmds].filter((c) => !githubCmds.has(c)).sort();
    if (onlyInGithub.length > 0 || onlyInCi.length > 0) {
      findings.push({
        kind: 'command_drift',
        severity: 'warning',
        ref: ciRef,
        message:
          `ci.yaml job '${jobId}' and GitHub '${githubRef}' run different commands. ` +
          (onlyInGithub.length > 0 ? `Only on GitHub: ${onlyInGithub.join('; ')}. ` : '') +
          (onlyInCi.length > 0 ? `Only in ci.yaml: ${onlyInCi.join('; ')}.` : ''),
        detail: {
          ...(onlyInGithub.length > 0 ? { onlyInGithub } : {}),
          ...(onlyInCi.length > 0 ? { onlyInCi } : {}),
        },
      });
    }
  }

  // ── ignore entries ──
  for (const ignoreRef of manifest.ignore) {
    claimed.add(ignoreRef);
    if (!githubJobs.has(ignoreRef)) {
      findings.push({
        kind: 'stale_ignore',
        severity: 'warning',
        ref: ignoreRef,
        message: `ci-mirror.yaml 'ignore' lists '${ignoreRef}', which no longer exists in the in-scope workflows. Remove the stale entry.`,
      });
    }
  }

  // ── in-scope GitHub jobs not claimed by any mirror or ignore ──
  for (const ref of githubJobs.keys()) {
    if (!claimed.has(ref)) {
      findings.push({
        kind: 'unmapped_github_job',
        severity: 'error',
        ref,
        message: `GitHub job '${ref}' is not mapped by any ci.yaml job and is not in ci-mirror.yaml 'ignore'. Map it (add a 'jobs.<id>: ${ref}' entry) or add it to 'ignore'.`,
      });
    }
  }

  const hasBlockingDrift = findings.some((f) => f.severity === 'error');
  const hasWarnings = findings.some((f) => f.severity === 'warning');
  return { notConfigured: false, findings, matches, hasBlockingDrift, hasWarnings };
}

/**
 * Render a human-readable, deterministic summary of a drift report for the CLI
 * gate output. Sorted by severity then ref so the same drift always prints the
 * same lines (snapshot-friendly).
 */
export function formatDriftReport(report: WorkflowDriftReport): string {
  if (report.notConfigured) {
    return 'workflow-drift: no .agent-hub/ci-mirror.yaml — drift checking not configured; skipping.';
  }
  const lines: string[] = [];
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');
  const bySeverity = [...errors, ...warnings].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return a.ref.localeCompare(b.ref);
  });
  if (bySeverity.length === 0) {
    lines.push(`workflow-drift: OK — ${report.matches.length} mirrored job(s), no drift.`);
    return lines.join('\n');
  }
  lines.push(
    `workflow-drift: ${errors.length} error(s), ${warnings.length} warning(s) ` +
      `across ${report.matches.length} mirrored job(s).`,
  );
  for (const f of bySeverity) {
    const tag = f.severity === 'error' ? 'ERROR' : 'warn ';
    lines.push(`  [${tag}] ${f.kind} (${f.ref}): ${f.message}`);
  }
  return lines.join('\n');
}
