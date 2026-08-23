/**
 * github-auto-merge.ts - wait for GitHub checks, then merge the PR.
 *
 * GitHub native auto-merge only waits for requirements enforced by branch
 * protection. A plain `gh pr merge` (and `gh pr merge --auto` on an
 * unprotected branch) can therefore merge while non-required GitHub Actions
 * checks are still pending. Finalize's Auto Merge contract is stronger: when
 * checks exist, all of them must finish successfully before the merge.
 *
 * We briefly wait for check suites to appear after a push, poll their rollup
 * until it passes, and only then attempt the merge. Repositories with no
 * checks still merge after the discovery window. If a review or another
 * protected requirement blocks that merge, GitHub native auto-merge remains
 * the fallback.
 */

/** Runs `gh <args>`; resolves on exit 0, rejects (throws) on non-zero. */
export type GhRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type MergeMethodFlag = '--squash' | '--merge' | '--rebase';

export interface AutoMergeOutcome {
  /** PR was merged immediately after its checks passed (or no checks appeared). */
  merged: boolean;
  /** GitHub native auto-merge was enabled for a remaining protected requirement. */
  autoEnabled: boolean;
  /** Human-readable note for logs. */
  note: string;
}

export interface AutoMergeCheckWaitOptions {
  /** How long to wait for a newly-pushed PR's first check suite. */
  discoveryTimeoutMs?: number;
  /** How long a passing check set must remain unchanged before merging. */
  stabilizationTimeoutMs?: number;
  /** Maximum time to wait for discovered checks to complete. */
  completionTimeoutMs?: number;
  /** Delay between GitHub check-rollup reads. */
  pollIntervalMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam. */
  now?: () => number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

type CheckGate =
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'passed' }
  | { state: 'failed'; names: string[] };

interface CheckSnapshot {
  gate: CheckGate;
  /** Stable identity set, excluding mutable status/conclusion fields. */
  fingerprint: string;
}

function checkName(row: Record<string, unknown>): string {
  if (typeof row.name === 'string' && row.name.trim()) return row.name.trim();
  if (typeof row.context === 'string' && row.context.trim()) return row.context.trim();
  return 'unknown check';
}

/** Classify the mixed CheckRun / StatusContext rows returned by `gh pr view`. */
export function classifyGithubCheckRollup(raw: unknown): CheckGate {
  if (!Array.isArray(raw) || raw.length === 0) return { state: 'none' };

  let pending = false;
  const failed: string[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      pending = true;
      continue;
    }
    const row = item as Record<string, unknown>;
    const typename = String(row.__typename || '');

    if (typename === 'StatusContext') {
      const state = String(row.state || '').toUpperCase();
      if (state === 'SUCCESS') continue;
      if (state === 'FAILURE' || state === 'ERROR') {
        failed.push(checkName(row));
      } else {
        // EXPECTED, PENDING, and unknown future states are incomplete.
        pending = true;
      }
      continue;
    }

    if (typename === 'CheckRun') {
      const status = String(row.status || '').toUpperCase();
      if (status !== 'COMPLETED') {
        pending = true;
        continue;
      }
      const conclusion = String(row.conclusion || '').toUpperCase();
      if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
        continue;
      }
      // A completed check with no/unknown conclusion is not safe to merge.
      failed.push(checkName(row));
      continue;
    }

    // GitHub currently returns only the two variants above. Treat a new
    // variant conservatively until Agent Hub knows its terminal semantics.
    pending = true;
  }

  if (failed.length > 0) return { state: 'failed', names: failed };
  if (pending) return { state: 'pending' };
  return { state: 'passed' };
}

function checkRollupFingerprint(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((item, index) => {
      if (!item || typeof item !== 'object') return `unknown:${index}`;
      const row = item as Record<string, unknown>;
      return JSON.stringify([
        String(row.__typename || ''),
        String(row.workflow || ''),
        checkName(row),
      ]);
    })
    .sort()
    .join('\n');
}

async function readGithubCheckGate(prUrl: string, runGh: GhRunner): Promise<CheckSnapshot> {
  const { stdout } = await runGh(['pr', 'view', prUrl, '--json', 'statusCheckRollup']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not read GitHub checks for ${prUrl}: gh returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`could not read GitHub checks for ${prUrl}: missing check rollup`);
  }
  const rollup = (parsed as { statusCheckRollup?: unknown }).statusCheckRollup;
  return {
    gate: classifyGithubCheckRollup(rollup),
    fingerprint: checkRollupFingerprint(rollup),
  };
}

async function waitForGithubChecks(
  prUrl: string,
  runGh: GhRunner,
  options: AutoMergeCheckWaitOptions,
): Promise<'passed' | 'none'> {
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const stabilizationTimeoutMs = options.stabilizationTimeoutMs ?? discoveryTimeoutMs;
  const completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let discoveredAt: number | null = null;
  let passingSince: number | null = null;
  let passingFingerprint: string | null = null;

  while (true) {
    const { gate, fingerprint } = await readGithubCheckGate(prUrl, runGh);
    const currentTime = now();

    if (gate.state === 'failed') {
      throw new Error(`GitHub checks failed for ${prUrl}: ${gate.names.join(', ')}`);
    }
    if (gate.state === 'none') {
      passingSince = null;
      passingFingerprint = null;
      if (discoveredAt === null) {
        if (currentTime - startedAt >= discoveryTimeoutMs) return 'none';
      } else if (currentTime - discoveredAt >= completionTimeoutMs) {
        throw new Error(`timed out waiting ${completionTimeoutMs}ms for GitHub checks on ${prUrl}`);
      }
    } else {
      discoveredAt ??= currentTime;
      if (gate.state === 'passed') {
        if (passingFingerprint !== fingerprint) {
          passingFingerprint = fingerprint;
          passingSince = currentTime;
        }
        if (currentTime - (passingSince ?? currentTime) >= stabilizationTimeoutMs) {
          return 'passed';
        }
      } else {
        // A newly-visible pending check invalidates an earlier green snapshot.
        passingSince = null;
        passingFingerprint = null;
      }
      if (currentTime - discoveredAt >= completionTimeoutMs) {
        throw new Error(`timed out waiting ${completionTimeoutMs}ms for GitHub checks on ${prUrl}`);
      }
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Wait for GitHub checks, then merge a PR or enable native auto-merge if a
 * non-check protected requirement still blocks the merge.
 *
 * @param prUrl PR URL or number understood by `gh pr merge`.
 * @param runGh Injected `gh` runner (rejects on non-zero exit).
 * @param method Merge strategy flag (default `--squash`).
 * @throws when checks fail/time out, or neither merge path succeeds.
 */
export async function mergeOrEnableGithubAutoMerge(
  prUrl: string,
  runGh: GhRunner,
  method: MergeMethodFlag = '--squash',
  waitOptions: AutoMergeCheckWaitOptions = {},
): Promise<AutoMergeOutcome> {
  const checkResult = await waitForGithubChecks(prUrl, runGh, waitOptions);

  try {
    await runGh(['pr', 'merge', method, prUrl]);
    return {
      merged: true,
      autoEnabled: false,
      note: `merged ${prUrl} (${method}; GitHub checks ${checkResult === 'passed' ? 'passed' : 'not configured'})`,
    };
  } catch (immediateErr) {
    const immediateMsg =
      immediateErr instanceof Error ? immediateErr.message : String(immediateErr);
    try {
      await runGh(['pr', 'merge', '--auto', method, prUrl]);
      return {
        merged: false,
        autoEnabled: true,
        note: `enabled GitHub native auto-merge for ${prUrl} after checks passed (merge blocked: ${immediateMsg})`,
      };
    } catch (autoErr) {
      const autoMsg = autoErr instanceof Error ? autoErr.message : String(autoErr);
      throw new Error(
        `could not merge or enable auto-merge for ${prUrl}: immediate=[${immediateMsg}]; auto=[${autoMsg}]`,
      );
    }
  }
}
