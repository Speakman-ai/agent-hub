/**
 * release-range.ts — resolve which work a production deployment actually shipped.
 *
 * A production deploy of `main` records `deployment.ref` = the post-merge main
 * HEAD SHA. But `finalize_runs` are keyed by the PRE-merge feature-branch
 * `head_sha` / `validated_head_sha` / `branch`, and a squash-merge deletes the
 * feature branch entirely. So matching the single deployed SHA against finalize
 * linkage resolves nothing, and no release items get recorded (the symptom
 * operators saw as "no release items in deployments").
 *
 * The fix: when a production deployment succeeds, look at the commit RANGE that
 * is new in this deploy — everything reachable from the deployed ref but not
 * from the environment's previously-live ref — and pull two kinds of linkage
 * out of it:
 *
 *   1. **Commit SHAs.** `git log A..B` walks all parents, so for a non-squash
 *      `merge` commit the merged-in feature-branch tip (== `finalize_runs`
 *      `head_sha`/`validated_head_sha`) appears as its own entry. Feeding every
 *      in-range SHA back as a candidate `ref` lets the existing finalize
 *      head-SHA matcher resolve those cards.
 *   2. **PR numbers.** A squash-merge leaves no reachable feature commit, but
 *      the squash commit SUBJECT ends with ` (#N)` (and a `merge`-method commit
 *      subject starts with `Merge pull request #N`). Parsing N and rebuilding
 *      the native PR URL (`/projects/<projectId>/pulls/<N>`) lets the existing
 *      `pr_url` matcher resolve the card.
 *
 * Only the commit SUBJECT is parsed for PR numbers, and only the two exact
 * shapes the native merge writer (`server/native-pr/merge.ts`) and GitHub's
 * squash default produce — so a bare `#123` reference in a commit BODY can't
 * spuriously pull an unrelated card into the release.
 *
 * Everything is best-effort: a missing previous ref, a shallow clone, or any
 * git failure falls back to `{ refs: [currentRef], prUrls: [] }`, which
 * preserves the pre-fix behavior rather than throwing inside the deploy path.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildNativePrUrl } from '../native-pr/url.js';

const execFileAsync = promisify(execFile);

/** Record separator and field separator for the `git log` machine format. */
const REC_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/**
 * Hard cap on how many in-range commits we inspect / how many candidate refs
 * and PR URLs we return. A single release window between two production deploys
 * is rarely more than a few dozen commits; this only guards a pathological
 * range (e.g. a brand-new environment whose previous ref is an ancient commit)
 * from building a multi-thousand-element SQL `IN (...)` list.
 */
const MAX_RANGE_COMMITS = 1500;

export interface CollectReleaseRangeLinksInput {
  /** Checkout that contains the deployed ref AND the previous ref's history. */
  worktreePath: string;
  /** The environment's previously-live ref (null on the first deploy). */
  previousRef: string | null;
  /** The ref this deployment made live (the post-merge main HEAD SHA). */
  currentRef: string;
  /** Project slug — used to rebuild native PR URLs from parsed PR numbers. */
  projectId: string;
  /** Test seam. Defaults to a real `git -C <cwd> <args>` exec. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
}

export interface ReleaseRangeLinks {
  /** Candidate refs to feed the resolver (in-range commit SHAs + currentRef). */
  refs: string[];
  /** Candidate native PR URLs parsed from in-range merge/squash subjects. */
  prUrls: string[];
}

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Extract a native PR number from a single commit SUBJECT line. Matches only:
 *   - squash:       "Some title (#123)"            (GitHub + native squash)
 *   - merge-method: "Merge pull request #123 ..."  (native `merge`)
 * Returns null for anything else (including bare `#123` mid-subject).
 */
export function parsePrNumberFromSubject(subject: string): number | null {
  const trimmed = subject.trim();
  const merge = /^Merge pull request #(\d+)\b/.exec(trimmed);
  if (merge) return toPrNumber(merge[1]);
  const squash = /\(#(\d+)\)\s*$/.exec(trimmed);
  if (squash) return toPrNumber(squash[1]);
  return null;
}

function toPrNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/**
 * Resolve the shipped-work linkage for a production deployment. NEVER throws —
 * any failure falls back to `{ refs: [currentRef], prUrls: [] }`.
 */
export async function collectReleaseRangeLinks(
  input: CollectReleaseRangeLinksInput,
): Promise<ReleaseRangeLinks> {
  const currentRef = input.currentRef.trim();
  const fallback: ReleaseRangeLinks = {
    refs: currentRef ? [currentRef] : [],
    prUrls: [],
  };
  const previousRef = input.previousRef?.trim() ?? '';
  // No previous ref (first deploy) or a no-op re-deploy of the same ref → no
  // bounded range to inspect; keep the legacy single-ref behavior.
  if (!currentRef || !previousRef || previousRef === currentRef) return fallback;

  const runGit = input.runGit ?? defaultRunGit;
  let stdout: string;
  try {
    stdout = await runGit(
      [
        'log',
        `--max-count=${MAX_RANGE_COMMITS}`,
        `--format=%H${FIELD_SEP}%s${REC_SEP}`,
        `${previousRef}..${currentRef}`,
      ],
      input.worktreePath,
    );
  } catch {
    return fallback;
  }

  const refs = new Set<string>();
  if (currentRef) refs.add(currentRef);
  const prUrls = new Set<string>();
  for (const record of stdout.split(REC_SEP)) {
    const entry = record.trim();
    if (!entry) continue;
    const sepIdx = entry.indexOf(FIELD_SEP);
    const sha = (sepIdx === -1 ? entry : entry.slice(0, sepIdx)).trim();
    const subject = sepIdx === -1 ? '' : entry.slice(sepIdx + 1);
    if (sha) refs.add(sha);
    const prNumber = parsePrNumberFromSubject(subject);
    if (prNumber !== null) prUrls.add(buildNativePrUrl(input.projectId, prNumber));
  }

  return {
    refs: uniq([...refs]).slice(0, MAX_RANGE_COMMITS),
    prUrls: uniq([...prUrls]).slice(0, MAX_RANGE_COMMITS),
  };
}
