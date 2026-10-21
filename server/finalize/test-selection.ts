/**
 * Dynamic test selection: decide which ci.yaml job instances a Finalize round
 * runs when the project is in `testSelection.mode: dynamic`. Every instance
 * that does not run is recorded as `not_selected`.
 *
 * Instances run = `alwaysRun` jobs + jobs with no test inventory + jobs the
 * reviewer requires + instances owning a selected test file, plus their
 * `needs:` closure (and warmup jobs when anything else runs). Any doubt forces
 * a full run with the reason recorded: a selection failure never shrinks the
 * gate, and the full default-branch run is the backstop for a wrong pick.
 *
 * Spec: wiki `finalize-dynamic-test-selection-spec`.
 */
import type Database from 'better-sqlite3';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import { jobInstanceKey } from './base-drift-policy.js';
import { expandJobInstances, type CiConfig } from './ci-config-jobs.js';
import {
  isTestFilePath,
  sessionRanTestPaths,
  type SessionRanTestPath,
} from './session-ran-tests.js';
import {
  lookupTestInventory,
  type IsAncestorFn,
  type TestInventoryEntry,
  type TestInventoryLookup,
} from './test-inventory.js';
import { fullRunPathHits, type TestSelectionPolicy } from './test-selection-policy.js';

const execFileP = promisify(execFile);

/**
 * Why an instance runs. `diff` is a test file the change edits; `unmapped` is
 * a suite's shards pulled in because a test file it owns is new to the
 * inventory, or was added, deleted or renamed (sharding may have moved files).
 */
export type SelectionSource = 'session' | 'reviewer' | 'always' | 'needs' | 'unmapped' | 'diff';

export interface SelectionInstance {
  jobId: string;
  matrixKey: string;
  selected: boolean;
  sources: SelectionSource[];
  files: string[];
  reasons: string[];
}

export interface TestSelection {
  mode: 'dynamic';
  /** Set when every instance runs because selection could not be trusted. */
  forcedFullReason: string | null;
  inventorySha: string | null;
  instances: SelectionInstance[];
}

/**
 * What the in-hub reviewer contributed. `full` covers an explicit
 * `selection: full` as well as a timeout or an unparseable block.
 */
export type ReviewerSelection =
  | { kind: 'none' }
  | {
      kind: 'additions';
      tests: Array<{ file: string; reason?: string }>;
      jobs: Array<{ job: string; reason?: string }>;
    }
  | { kind: 'full'; reason: string };

/** One entry of `git diff --name-status -M base head`. */
export interface ChangedPath {
  /** First letter of the git status: A, M, D, R, C, T, ... */
  status: string;
  path: string;
  /** Source path of a rename or copy. */
  oldPath?: string;
}

export interface SelectionJobInstance {
  jobId: string;
  matrixKey: string;
  needs: string[];
  warmup: boolean;
  /** Suite this instance belongs to, from the job's `shard-by` matrix variable. */
  shardGroup?: string;
}

export interface ComputeTestSelectionInput {
  policy: TestSelectionPolicy;
  instances: SelectionJobInstance[];
  inventory: TestInventoryLookup;
  changed: ChangedPath[];
  sessionRan: SessionRanTestPath[];
  reviewer: ReviewerSelection;
  /** The previous round's selection in the same run. Selection only grows from it. */
  previous?: TestSelection | null;
}

/** Changes that can't move a test result. An empty diff counts as docs-only. */
/**
 * Classified by file type only, never by directory: a docs site can hold
 * components and build scripts. MDX is excluded because it embeds JSX.
 */
export function isDocPath(p: string): boolean {
  if (/\.(md|markdown|rst|adoc|txt)$/i.test(p)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return /^(LICENSE|LICENCE|NOTICE|AUTHORS|CHANGELOG|CODEOWNERS)$/i.test(base);
}

export function fullSelection(
  instances: SelectionJobInstance[],
  reason: string,
  inventorySha: string | null = null,
): TestSelection {
  return {
    mode: 'dynamic',
    forcedFullReason: reason,
    inventorySha,
    instances: instances.map((i) => ({
      jobId: i.jobId,
      matrixKey: i.matrixKey,
      selected: true,
      sources: [],
      files: [],
      reasons: [],
    })),
  };
}

/** Keys (`jobInstanceKey`) of the instances a selection leaves out. */
export function notSelectedInstanceKeys(selection: TestSelection): Set<string> {
  const out = new Set<string>();
  for (const i of selection.instances) {
    if (!i.selected) out.add(jobInstanceKey(i.jobId, i.matrixKey));
  }
  return out;
}

class ForceFull extends Error {}

/**
 * Pure selection. Never throws for bad input: anything it can't resolve
 * becomes a forced full run.
 */
export function computeTestSelection(input: ComputeTestSelectionInput): TestSelection {
  const prev = input.previous ?? null;
  const inventorySha = input.inventory.status === 'missing' ? null : input.inventory.sha;
  let current: TestSelection;
  try {
    current = select(input);
  } catch (err) {
    const reason =
      err instanceof ForceFull
        ? err.message
        : `selection error: ${err instanceof Error ? err.message : String(err)}`;
    current = fullSelection(input.instances, reason, inventorySha);
  }
  if (!prev) return current;
  if (prev.forcedFullReason) {
    return fullSelection(input.instances, prev.forcedFullReason, current.inventorySha);
  }
  if (current.forcedFullReason) return current;
  return mergeSelections(prev, current);
}

function select(input: ComputeTestSelectionInput): TestSelection {
  const { policy, instances, inventory, changed, reviewer } = input;
  if (reviewer.kind === 'full') throw new ForceFull(reviewer.reason);

  const changedPaths = changed.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]));
  const hits = fullRunPathHits(changedPaths, policy);
  if (hits.length > 0) {
    const shown =
      hits.slice(0, 5).join(', ') + (hits.length > 5 ? `, +${hits.length - 5} more` : '');
    throw new ForceFull(`changed files match fullRunPaths: ${shown}`);
  }
  if (inventory.status === 'missing') {
    throw new ForceFull('no test inventory yet (no full default-branch run has recorded one)');
  }
  if (inventory.status === 'stale')
    throw new ForceFull(`test inventory is stale: ${inventory.reason}`);

  const instanceKeys = new Set(instances.map((i) => jobInstanceKey(i.jobId, i.matrixKey)));
  const jobIds = new Set(instances.map((i) => i.jobId));
  for (const e of inventory.entries) {
    if (!instanceKeys.has(jobInstanceKey(e.jobId, e.matrixKey))) {
      const label = e.matrixKey ? `${e.jobId}/${e.matrixKey}` : e.jobId;
      throw new ForceFull(`test inventory names ${label}, which is not in the CI config`);
    }
  }

  const byFile = new Map<string, TestInventoryEntry[]>();
  const jobsByDir = new Map<string, Set<string>>();
  const inventoriedJobs = new Set<string>();
  const groupByInstance = new Map<string, string | undefined>(
    instances.map((i) => [jobInstanceKey(i.jobId, i.matrixKey), i.shardGroup]),
  );
  // Suites (`shard-by` values) per job and directory, for files new to the inventory.
  const groupsByJobDir = new Map<string, Set<string>>();
  for (const e of inventory.entries) {
    inventoriedJobs.add(e.jobId);
    const group = groupByInstance.get(jobInstanceKey(e.jobId, e.matrixKey));
    if (group !== undefined) {
      const k = `${e.jobId}\0${path.posix.dirname(e.testFile)}`;
      const groups = groupsByJobDir.get(k);
      if (groups) groups.add(group);
      else groupsByJobDir.set(k, new Set([group]));
    }
    const list = byFile.get(e.testFile);
    if (list) list.push(e);
    else byFile.set(e.testFile, [e]);
    const dir = path.posix.dirname(e.testFile);
    const jobs = jobsByDir.get(dir);
    if (jobs) jobs.add(e.jobId);
    else jobsByDir.set(dir, new Set([e.jobId]));
  }

  const state = new Map<string, SelectionInstance>();
  for (const i of instances) {
    state.set(jobInstanceKey(i.jobId, i.matrixKey), {
      jobId: i.jobId,
      matrixKey: i.matrixKey,
      selected: false,
      sources: [],
      files: [],
      reasons: [],
    });
  }
  // Instances picked by a test-driven source (not `always` / `needs`).
  let testDriven = 0;
  const mark = (
    key: string,
    source: SelectionSource,
    opts: { file?: string; reason?: string } = {},
  ): void => {
    const s = state.get(key);
    if (!s) return;
    s.selected = true;
    if (!s.sources.includes(source)) s.sources.push(source);
    if (opts.file && !s.files.includes(opts.file)) s.files.push(opts.file);
    if (opts.reason && !s.reasons.includes(opts.reason)) s.reasons.push(opts.reason);
    if (source !== 'always' && source !== 'needs') testDriven += 1;
  };
  const markJob = (
    jobId: string,
    source: SelectionSource,
    opts: { file?: string; reason?: string } = {},
  ): void => {
    for (const i of instances) {
      if (i.jobId === jobId) mark(jobInstanceKey(i.jobId, i.matrixKey), source, opts);
    }
  };
  /**
   * A test file was added, deleted or renamed, so hash- and count-based
   * sharding may move files between shards. Run every instance of the job,
   * or, when the job declares `shard-by`, every instance of the suites that
   * own the file (or, for a file new to the inventory, its directory).
   */
  const markSuite = (
    jobId: string,
    file: string,
    opts: { file?: string; reason?: string },
  ): void => {
    const jobInstances = instances.filter((i) => i.jobId === jobId);
    const groups = new Set<string>();
    if (jobInstances.every((i) => i.shardGroup !== undefined)) {
      for (const e of byFile.get(file) ?? []) {
        const g = groupByInstance.get(jobInstanceKey(e.jobId, e.matrixKey));
        if (e.jobId === jobId && g !== undefined) groups.add(g);
      }
      if (groups.size === 0) {
        for (const g of groupsByJobDir.get(`${jobId}\0${path.posix.dirname(file)}`) ?? []) {
          groups.add(g);
        }
      }
    }
    if (groups.size === 0) {
      markJob(jobId, 'unmapped', opts);
      return;
    }
    for (const i of jobInstances) {
      if (groups.has(i.shardGroup!)) mark(jobInstanceKey(i.jobId, i.matrixKey), 'unmapped', opts);
    }
  };
  /** The single job owning a file the inventory has never seen, by directory. */
  const ownerByDir = (file: string, why: string): string => {
    const jobs = jobsByDir.get(path.posix.dirname(file));
    if (!jobs || jobs.size === 0) {
      throw new ForceFull(`${why} ${file} has no owning job in the test inventory`);
    }
    if (jobs.size > 1) {
      throw new ForceFull(
        `${why} ${file} could belong to several jobs: ${[...jobs].sort().join(', ')}`,
      );
    }
    return [...jobs][0];
  };
  /** Select the instances owning `file`; a file new to the inventory runs its whole job. */
  const selectFile = (file: string, source: SelectionSource, reason?: string): void => {
    const owners = byFile.get(file);
    if (owners) {
      for (const e of owners) {
        mark(jobInstanceKey(e.jobId, e.matrixKey), source, { file, ...(reason ? { reason } : {}) });
      }
      return;
    }
    const job = ownerByDir(file, 'selected test');
    markSuite(job, file, { file, reason: `${file} is not in the test inventory` });
  };

  // Jobs that always run.
  for (const jobId of policy.alwaysRun) {
    if (jobIds.has(jobId)) markJob(jobId, 'always', { reason: 'listed in alwaysRun' });
  }
  for (const jobId of jobIds) {
    if (!inventoriedJobs.has(jobId)) {
      markJob(jobId, 'always', { reason: 'job has no test inventory' });
    }
  }

  // Reviewer additions.
  if (reviewer.kind === 'additions') {
    for (const j of reviewer.jobs) {
      if (!jobIds.has(j.job)) throw new ForceFull(`reviewer required unknown job "${j.job}"`);
      markJob(j.job, 'reviewer', j.reason ? { reason: j.reason } : {});
    }
    for (const t of reviewer.tests) selectFile(t.file, 'reviewer', t.reason);
  }

  // Tests the session ran.
  for (const ran of input.sessionRan) {
    if (ran.runner === 'go') {
      selectGoPackage(ran, inventory.entries, mark);
      continue;
    }
    if (ran.kind === 'file') {
      selectFile(ran.path, 'session');
      continue;
    }
    const prefix = `${ran.path}/`;
    const under = inventory.entries.filter((e) => e.testFile.startsWith(prefix));
    if (under.length === 0) {
      throw new ForceFull(`session ran ${ran.path}/, which has no test in the inventory`);
    }
    for (const e of under)
      mark(jobInstanceKey(e.jobId, e.matrixKey), 'session', { file: e.testFile });
  }

  // Test files the diff touches. Edited ones run their own instances; added,
  // deleted or renamed ones run their suite's instances (see markSuite).
  for (const c of changed) {
    const status = c.status.charAt(0).toUpperCase();
    const churn = status === 'A' || status === 'D' || status === 'R' || status === 'C';
    const paths = c.oldPath && status === 'R' ? [c.oldPath, c.path] : [c.path];
    for (const p of paths) {
      const known = byFile.get(p);
      if (!known && !isTestFilePath(p)) continue;
      if (!churn) {
        selectFile(p, 'diff');
        continue;
      }
      const verb =
        status === 'A' || status === 'C' ? 'added' : status === 'D' ? 'deleted' : 'renamed';
      const owners = known
        ? [...new Set(known.map((e) => e.jobId))]
        : [ownerByDir(p, `${verb} test file`)];
      for (const job of owners) {
        markSuite(job, p, { file: p, reason: `test file ${verb}: ${p}` });
      }
    }
  }

  if (
    testDriven === 0 &&
    changed.some((c) => !isDocPath(c.path) || (c.oldPath && !isDocPath(c.oldPath)))
  ) {
    throw new ForceFull('no test was selected for a change that touches non-doc files');
  }

  // `needs:` closure, then warmup jobs when anything else runs.
  const needsByJob = new Map<string, string[]>();
  for (const i of instances) if (!needsByJob.has(i.jobId)) needsByJob.set(i.jobId, i.needs);
  const selectedJobs = (): Set<string> =>
    new Set([...state.values()].filter((s) => s.selected).map((s) => s.jobId));
  const queue = [...selectedJobs()];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const job = queue.shift()!;
    for (const dep of needsByJob.get(job) ?? []) {
      if (!jobIds.has(dep)) continue;
      markJob(dep, 'needs', { reason: `needed by ${job}` });
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  const warmupJobs = new Set(instances.filter((i) => i.warmup).map((i) => i.jobId));
  const anyNonWarmup = [...selectedJobs()].some((j) => !warmupJobs.has(j));
  if (anyNonWarmup) {
    for (const job of warmupJobs) markJob(job, 'needs', { reason: 'warmup job' });
  }

  return {
    mode: 'dynamic',
    forcedFullReason: null,
    inventorySha: inventory.sha,
    instances: [...state.values()],
  };
}

/**
 * go-junit-report records package import paths while the session names
 * repo-relative package dirs, so match an import path ending in the dir.
 */
function selectGoPackage(
  ran: SessionRanTestPath,
  entries: TestInventoryEntry[],
  mark: (key: string, source: SelectionSource, opts?: { file?: string }) => void,
): void {
  const dir = ran.kind === 'file' ? path.posix.dirname(ran.path) : ran.path;
  if (!dir || dir === '.') {
    throw new ForceFull(
      `session ran the root Go package, which can't be matched to an import path`,
    );
  }
  const hits = entries.filter((e) => e.testFile === dir || e.testFile.endsWith(`/${dir}`));
  if (hits.length === 0)
    throw new ForceFull(`session ran Go package ${dir}, which is not in the test inventory`);
  for (const e of hits) mark(jobInstanceKey(e.jobId, e.matrixKey), 'session', { file: e.testFile });
}

/** Union of two rounds' selections: an instance selected in either stays selected. */
export function mergeSelections(prev: TestSelection, next: TestSelection): TestSelection {
  const prevByKey = new Map(prev.instances.map((i) => [jobInstanceKey(i.jobId, i.matrixKey), i]));
  return {
    ...next,
    instances: next.instances.map((n) => {
      const p = prevByKey.get(jobInstanceKey(n.jobId, n.matrixKey));
      if (!p || !p.selected) return n;
      return {
        ...n,
        selected: true,
        sources: union(p.sources, n.sources),
        files: union(p.files, n.files),
        reasons: union(p.reasons, n.reasons),
      };
    }),
  };
}

function union<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])];
}

/** Parse `git diff --name-status -z -M` output. */
export function parseNameStatusZ(stdout: string): ChangedPath[] {
  const parts = stdout.split('\0');
  const out: ChangedPath[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) {
      i += 1;
      continue;
    }
    const letter = status.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (!oldPath || !newPath) throw new Error('truncated git diff output');
      out.push({ status: letter, path: newPath, oldPath });
      i += 3;
    } else {
      const p = parts[i + 1];
      if (!p) throw new Error('truncated git diff output');
      out.push({ status: letter, path: p });
      i += 2;
    }
  }
  return out;
}

export async function gitChangedPaths(
  repoDir: string,
  base: string,
  head: string,
  env?: NodeJS.ProcessEnv,
): Promise<ChangedPath[]> {
  const { stdout } = await execFileP(
    'git',
    ['-C', repoDir, 'diff', '--name-status', '-z', '-M', '--no-color', base, head],
    { maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) },
  );
  return parseNameStatusZ(stdout);
}

export interface ResolveTestSelectionArgs {
  db: Database.Database;
  projectId: string;
  policy: TestSelectionPolicy;
  config: CiConfig;
  worktreePath: string;
  baseSha: string | null;
  headSha: string;
  sessionId: string;
  reviewer: ReviewerSelection;
  previous: TestSelection | null;
  env?: NodeJS.ProcessEnv;
  isAncestor?: IsAncestorFn;
  listChangedPaths?: typeof gitChangedPaths;
  listSessionRanTests?: typeof sessionRanTestPaths;
}

/** Job instances of a config in the shape selection needs. */
export function selectionInstancesFor(config: CiConfig): SelectionJobInstance[] {
  return expandJobInstances(config, {}).map((i) => ({
    jobId: i.jobId,
    matrixKey: i.matrixKey,
    needs: i.needs,
    warmup: i.warmup,
    ...(i.shardGroup !== undefined ? { shardGroup: i.shardGroup } : {}),
  }));
}

/**
 * Gather the inputs (diff, inventory, session-ran tests) and compute one
 * round's selection. Any failure while gathering is a forced full run.
 */
export async function resolveTestSelection(args: ResolveTestSelectionArgs): Promise<TestSelection> {
  const instances = selectionInstancesFor(args.config);
  try {
    if (!args.baseSha) {
      return computeTestSelection({
        policy: args.policy,
        instances,
        inventory: { status: 'missing' },
        changed: [],
        sessionRan: [],
        reviewer: { kind: 'full', reason: 'the base commit of this round is unknown' },
        previous: args.previous,
      });
    }
    const listChanged = args.listChangedPaths ?? gitChangedPaths;
    const listRan = args.listSessionRanTests ?? sessionRanTestPaths;
    const [changed, inventory, sessionRan] = await Promise.all([
      listChanged(args.worktreePath, args.baseSha, args.headSha, args.env),
      lookupTestInventory(args.db, {
        projectId: args.projectId,
        baseSha: args.baseSha,
        repoDir: args.worktreePath,
        ...(args.isAncestor ? { isAncestor: args.isAncestor } : {}),
        ...(args.env ? { env: args.env } : {}),
      }),
      listRan({
        db: args.db,
        sessionId: args.sessionId,
        repoRoot: args.worktreePath,
        ref: args.headSha,
      }),
    ]);
    return computeTestSelection({
      policy: args.policy,
      instances,
      inventory,
      changed,
      sessionRan,
      reviewer: args.reviewer,
      previous: args.previous,
    });
  } catch (err) {
    const reason = `selection error: ${err instanceof Error ? err.message : String(err)}`;
    if (args.previous?.forcedFullReason) {
      return fullSelection(instances, args.previous.forcedFullReason);
    }
    return fullSelection(instances, reason);
  }
}

const SELECTION_SOURCES = ['session', 'reviewer', 'always', 'needs', 'unmapped', 'diff'] as const;

const TestSelectionSchema = z.object({
  mode: z.literal('dynamic'),
  forcedFullReason: z.string().nullable(),
  inventorySha: z.string().nullable(),
  instances: z.array(
    z.object({
      jobId: z.string(),
      matrixKey: z.string(),
      selected: z.boolean(),
      sources: z.array(z.enum(SELECTION_SOURCES)),
      files: z.array(z.string()),
      reasons: z.array(z.string()),
    }),
  ),
});

/** Parse `finalize_runs.test_selection`; null when absent or malformed. */
export function parseTestSelection(raw: string | null | undefined): TestSelection | null {
  if (!raw) return null;
  try {
    const parsed = TestSelectionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** One-line summary for logs and traces. */
export function describeTestSelection(selection: TestSelection): string {
  const total = selection.instances.length;
  if (selection.forcedFullReason)
    return `full run of ${total} instance(s): ${selection.forcedFullReason}`;
  const ran = selection.instances.filter((i) => i.selected).length;
  return `selected ${ran} of ${total} instance(s)`;
}
