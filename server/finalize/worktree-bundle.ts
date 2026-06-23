/**
 * worktree-bundle.ts — ship the code under test to a remote runner WITHOUT
 * pushing to GitHub (Agent Hub's whole point is pre-merge validation).
 *
 * The Hub `git bundle`s the session worktree's committed HEAD (a single
 * integrity-checked file that is a real git repo — CI steps run `git`, e.g.
 * `git rev-parse HEAD` for the cache key, so a flat tarball won't do), uploads
 * it to a bundle store keyed per run, and hands the agent a ref. The agent
 * downloads, verifies the sha256, and `git clone`s it into /github/workspace.
 *
 * The store is abstracted so local dev / Phase-2a use a directory while prod
 * uses S3 (presigned). One bundle per run is shared by all its matrix shards.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { copyFile, mkdir, rm } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface WorktreeRef {
  key: string;
  sha256: string;
  sizeBytes: number;
  /**
   * Optional presigned HTTPS GET URL. Set by stores that can presign (S3) so a
   * cross-host fleet agent downloads the bundle with a plain `fetch` and needs
   * NO AWS SDK / credentials of its own. Absent for the local-dir store (the
   * same-host Phase-2a path), where the agent reads the bundle via `store.get`.
   */
  getUrl?: string;
}

/** Pluggable bundle store (local dir for dev/2a; S3 in prod). */
export interface BundleStore {
  put(key: string, filePath: string): Promise<void>;
  get(key: string, destPath: string): Promise<void>;
  /**
   * Optionally mint a short-lived presigned GET URL for `key`. Stores that
   * can't presign (local dir) omit this or return null, and the agent falls
   * back to `store.get`. Returning a URL lets a remote agent fetch credential-free.
   */
  presignGet?(key: string): Promise<string | null>;
}

/** Local-directory store — for single-host dev / Phase-2a and tests. */
export class LocalDirBundleStore implements BundleStore {
  constructor(private readonly root: string) {}
  private resolve(key: string): string {
    return path.join(this.root, key);
  }
  async put(key: string, filePath: string): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(filePath, dest);
  }
  async get(key: string, destPath: string): Promise<void> {
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(this.resolve(key), destPath);
  }
}

async function sha256File(filePath: string): Promise<{ hex: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (c) => {
        size += c.length;
        hash.update(c);
      })
      .on('end', () => resolve())
      .on('error', reject);
  });
  return { hex: hash.digest('hex'), size };
}

/**
 * Build the rev arguments for `git bundle create`. A git bundle must contain at
 * least one *ref*; a bare commit OID has none, so `git bundle create <file>
 * <sha>` aborts with "fatal: Refusing to create empty bundle" even when the
 * commit is perfectly real (this is exactly what broke every remote-fleet
 * Finalize run once the bundle was pinned to FINALIZE_HEAD_SHA). When the caller
 * pins to a raw SHA, append `HEAD` so the bundle records a ref: the SHA's
 * objects are still packaged (they're reachable from the positional rev) and the
 * agent checks out the SHA after clone, so the bundle content stays provably
 * pinned to the validated commit. A symbolic rev (HEAD, a branch name) already
 * carries a ref and is passed through unchanged.
 */
export function bundleRevArgs(rev?: string): string[] {
  if (!rev) return ['HEAD'];
  return /^[0-9a-f]{7,40}$/i.test(rev) ? [rev, 'HEAD'] : [rev];
}

/**
 * Does this error message describe a *deterministic* `git bundle` failure (e.g.
 * "Refusing to create empty bundle")? Such a failure recurs identically on
 * retry, so the orchestrator must classify it as deterministic rather than the
 * transient `container_unavailable` — otherwise the one-auto-retry path
 * livelocks, re-running the same broken bundle "until infrastructure recovers"
 * when nothing infrastructural is wrong.
 */
export function isWorktreeBundleFailureMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('refusing to create empty bundle') ||
    (m.includes('bundle') && m.includes('create') && m.includes('fatal'))
  );
}

/**
 * Produce a git bundle of the worktree's committed history (default HEAD) and
 * upload it under `key`. Returns the ref to embed in the job's wire spec.
 */
export async function createWorktreeBundle(args: {
  worktreePath: string;
  key: string;
  store: BundleStore;
  rev?: string;
}): Promise<WorktreeRef> {
  const tmp = path.join(os.tmpdir(), `finalize-bundle-${process.pid}-${Date.now()}.bundle`);
  try {
    // `git bundle create <file> <rev>` captures <rev> plus the history to reach
    // it — the agent reconstructs a real repo via `git clone`. The rev args MUST
    // include a ref (see bundleRevArgs) or git refuses to create the bundle.
    await execFileAsync('git', [
      '-C',
      args.worktreePath,
      'bundle',
      'create',
      tmp,
      ...bundleRevArgs(args.rev),
    ]);
    const { hex, size } = await sha256File(tmp);
    await args.store.put(args.key, tmp);
    return { key: args.key, sha256: hex, sizeBytes: size };
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Stream a presigned HTTPS URL to a local file (no AWS SDK needed). */
async function downloadUrl(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`worktree bundle download failed: HTTP ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
}

/**
 * Agent side: download the bundle named by `ref`, verify its sha256, and clone
 * it into `destPath` (then checkout `rev` when pinning a specific commit).
 *
 * Prefers `ref.getUrl` (presigned, credential-free fetch — the cross-host fleet
 * path); falls back to `store.get` for the same-host local-dir path. One of the
 * two must be available.
 */
export async function materializeWorktree(args: {
  ref: WorktreeRef;
  store?: BundleStore;
  destPath: string;
  rev?: string;
}): Promise<void> {
  const tmp = path.join(os.tmpdir(), `finalize-fetch-${process.pid}-${Date.now()}.bundle`);
  try {
    if (args.ref.getUrl) {
      await downloadUrl(args.ref.getUrl, tmp);
    } else if (args.store) {
      await args.store.get(args.ref.key, tmp);
    } else {
      throw new Error(`worktree bundle ${args.ref.key} has no getUrl and no store to fetch from`);
    }
    const { hex } = await sha256File(tmp);
    if (hex !== args.ref.sha256) {
      throw new Error(
        `worktree bundle ${args.ref.key} sha256 mismatch (expected ${args.ref.sha256}, got ${hex})`,
      );
    }
    await rm(args.destPath, { recursive: true, force: true });
    await execFileAsync('git', ['clone', '--quiet', tmp, args.destPath]);
    if (args.rev) {
      await execFileAsync('git', ['-C', args.destPath, 'checkout', '--quiet', args.rev]);
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Per-run bundle key. One bundle is shared by all the run's matrix shards, but
 * when `headSha` is supplied it's folded into the key so a fix-dispatch round
 * that advances HEAD writes a DISTINCT object instead of overwriting the prior
 * round's bundle. Omitting `headSha` keeps the legacy key (back-compat).
 */
export function worktreeBundleKey(orgId: string, runId: string, headSha?: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-');
  const rev = headSha ? `-${safe(headSha).slice(0, 40)}` : '';
  return `worktrees/${safe(orgId || 'default')}/${safe(runId)}${rev}.bundle`;
}
