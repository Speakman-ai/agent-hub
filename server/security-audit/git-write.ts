/**
 * git-write.ts — worktree-free creation of a branch carrying a small set of
 * modified files, directly in a hosted bare repo. Used by the security
 * auto-PR flow to land a lockfile/package.json bump on a deterministic
 * branch without ever checking anything out.
 *
 * Mechanics (all git plumbing, no working tree):
 *   1. seed a throwaway index from `baseSha` (`read-tree` under a temp
 *      GIT_INDEX_FILE),
 *   2. `hash-object -w` each new blob and `update-index --cacheinfo` it,
 *   3. `write-tree` → the resulting tree OID,
 *   4. idempotency: if `branch` already points at a commit whose tree equals
 *      the new tree AND whose first parent is `baseSha`, reuse it (no churn —
 *      this is what keeps a re-scan from rewriting an unchanged open bump PR
 *      every run),
 *   5. otherwise `commit-tree` (parent `baseSha`) and a compare-and-swap
 *      `update-ref <ref> <new> <expected-old>` — so a branch that moved between
 *      the read in step 4 and the write here is NOT silently overwritten. On a
 *      CAS miss the whole read→commit→swap sequence retries (bounded). This
 *      protects against concurrent scans across workers / processes / restarts,
 *      not just the in-process per-project serialize lock.
 *
 * Mirrors the CAS-with-retry plumbing of {@link ../native-pr/merge.ts}.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'Agent Hub',
  GIT_AUTHOR_EMAIL: 'agent-hub@localhost',
  GIT_COMMITTER_NAME: 'Agent Hub',
  GIT_COMMITTER_EMAIL: 'agent-hub@localhost',
};

async function git(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    env: env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface CommitFilesToBareBranchArgs {
  repoPath: string;
  /** Commit the new tree is based on (the bump's base, normally default tip). */
  baseSha: string;
  /** Fully-qualified short branch name (without `refs/heads/`). */
  branch: string;
  /** Root-relative path → full UTF-8 content for each file to write. */
  files: Record<string, string>;
  /** Commit message subject/body. */
  message: string;
}

export interface CommitFilesToBareBranchResult {
  headSha: string;
  /** True when a new commit was written; false when an identical one was reused. */
  created: boolean;
}

/** All-zero OID — git's sentinel for "this ref must not currently exist" in a CAS. */
const ZERO_OID = '0000000000000000000000000000000000000000';

/** How many times to retry the read→commit→CAS sequence on a ref-moved race. */
const MAX_CAS_ATTEMPTS = 3;

/**
 * Create/refresh `branch` with `files` overlaid on `baseSha`'s tree. Throws
 * when `files` is empty (a no-op commit is a caller bug), or when the branch
 * keeps moving under us past {@link MAX_CAS_ATTEMPTS} (a persistent racer).
 */
export async function commitFilesToBareBranch(
  args: CommitFilesToBareBranchArgs,
): Promise<CommitFilesToBareBranchResult> {
  const { repoPath, baseSha, branch, files, message } = args;
  const paths = Object.keys(files);
  if (paths.length === 0) {
    throw new Error('commitFilesToBareBranch: no files to commit');
  }
  const ref = `refs/heads/${branch}`;

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ah-secpr-'));
  const indexFile = path.join(tmp, 'index');
  const env: NodeJS.ProcessEnv = { ...process.env, ...AUTHOR_ENV, GIT_INDEX_FILE: indexFile };

  try {
    // The tree is a pure function of (baseSha, files); compute it once. Blobs
    // are written to the object store regardless of the branch ref state.
    await git(repoPath, ['read-tree', baseSha], env);
    for (const relPath of paths) {
      const blobFile = path.join(tmp, 'blob');
      writeFileSync(blobFile, files[relPath]);
      // `--path` lets git apply the repo's clean filters / attributes for the
      // logical path while reading bytes from the temp file.
      const blobSha = (
        await git(repoPath, ['hash-object', '-w', '--path', relPath, blobFile], env)
      ).trim();
      await git(
        repoPath,
        ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${relPath}`],
        env,
      );
    }
    const treeOid = (await git(repoPath, ['write-tree'], env)).trim();

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      // Snapshot the current ref so we can compare-and-swap against exactly it.
      const existing = await revParse(repoPath, ref);

      // Idempotency: an existing branch already at this exact tree + base parent
      // needs no rewrite (avoids head-sha churn on repeated scans).
      if (existing) {
        const [existingTree, existingParent] = await Promise.all([
          revParse(repoPath, `${existing}^{tree}`),
          revParse(repoPath, `${existing}^`),
        ]);
        if (existingTree === treeOid && existingParent === baseSha) {
          return { headSha: existing, created: false };
        }
      }

      const commitSha = (
        await git(repoPath, ['commit-tree', treeOid, '-p', baseSha, '-m', message], env)
      ).trim();

      // CAS: require the ref to still be exactly what we read (or absent). If a
      // concurrent worker moved it in between, this fails and we retry from the
      // fresh state rather than clobbering their commit.
      const expectedOld = existing ?? ZERO_OID;
      try {
        await git(repoPath, ['update-ref', ref, commitSha, expectedOld], env);
        return { headSha: commitSha, created: true };
      } catch {
        // Ref moved since we read it — loop and re-evaluate against the new tip.
      }
    }

    throw new Error(
      `commitFilesToBareBranch: ${ref} kept moving during write (gave up after ${MAX_CAS_ATTEMPTS} attempts)`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function revParse(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['rev-parse', '--verify', '--quiet', ref])).trim() || null;
  } catch {
    return null;
  }
}
