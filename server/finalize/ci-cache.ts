/**
 * Cross-runner job cache for `.agent-hub/ci.yaml` (`cache:` on a job).
 *
 * `/finalize-cache` is a Docker volume local to one runner host. On the Spot
 * fleet every matrix shard usually lands on a different host, so a "first shard
 * builds, the rest reuse" pattern misses on every shard. A `cache:` entry backs
 * a set of paths under `/finalize-cache` with an S3 object, GitHub Actions
 * `actions/cache` style:
 *
 *   - A "Restore cache" step runs before the job's steps. It downloads the
 *     exact `key`, else the newest object matching a `restore-keys` prefix,
 *     and extracts it without overwriting files already on the host.
 *   - A "Save cache" step runs after every job step passed, only when the
 *     exact key missed on restore. It tars the paths and uploads them.
 *
 * The Hub resolves keys and mints presigned S3 URLs right before each cache
 * step runs, so fleet agents and job containers never hold AWS credentials. The
 * URL reaches the step through its env (never the persisted `run` text). Cache
 * steps always exit 0: a cache problem logs a warning and the job carries on
 * cold, the same as a GHA cache miss.
 *
 * Entries are scoped per org + project. Every branch of a project shares one
 * namespace, the same trust boundary as the host volume this replaces.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { FINALIZE_IMAGE_CACHE_PATH } from './runner-exec-args.js';
import { substituteEnvString } from './ci-config-jobs.js';
import {
  CACHE_MAX_KEY_LENGTH,
  HASH_FILES_RE,
  parseHashFilesArgs,
  type CiCacheEntry,
} from './ci-cache-spec.js';

export * from './ci-cache-spec.js';

const execFileAsync = promisify(execFile);

export const CACHE_ROOT = FINALIZE_IMAGE_CACHE_PATH;
/** S3's single-PUT ceiling. Presigned multipart would need a part-URL handshake. */
export const CACHE_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024;
const KEY_UNSAFE_CHARS_RE = /[^A-Za-z0-9._+=@,-]/g;

/**
 * Convert a repo-relative glob to a RegExp. `**` spans directories, `*` and `?`
 * stay within one path segment (GHA hashFiles semantics).
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        if (atSegStart && glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export type HashFilesFn = (globs: string[], signal?: AbortSignal) => Promise<string>;

/**
 * GHA-style hashFiles over the commit being checked, not the working tree, so
 * the key matches the bundle the runner materialized. Hashes each matching
 * blob's path + object id. Returns '' when nothing matches (as GHA does).
 */
export function gitTreeHashFiles(worktreePath: string, headSha: string): HashFilesFn {
  let listing: Promise<Array<{ path: string; oid: string }>> | null = null;
  const list = (signal?: AbortSignal) => {
    listing ??= execFileAsync('git', ['-C', worktreePath, 'ls-tree', '-r', '-z', headSha], {
      maxBuffer: 256 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    }).then(({ stdout }) =>
      stdout
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf('\t');
          const [, type, oid] = line.slice(0, tab).split(' ');
          return { type, oid, path: line.slice(tab + 1) };
        })
        .filter((e) => e.type === 'blob')
        .map(({ path, oid }) => ({ path, oid })),
    );
    return listing;
  };
  return async (globs, signal) => {
    const res = globs.map(globToRegExp);
    const matched = (await list(signal))
      .filter((e) => res.some((re) => re.test(e.path)))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (matched.length === 0) return '';
    const h = createHash('sha256');
    for (const e of matched) h.update(`${e.oid} ${e.path}\n`);
    return h.digest('hex');
  };
}

export type ResolvedKey = { ok: true; key: string } | { ok: false; message: string };

/**
 * Resolve a key (or restore-key prefix) template: hashFiles first, then
 * `${VAR}`/`$VAR` from the job env. Characters S3-unfriendly in a flat
 * namespace become '-'.
 */
export async function resolveCacheKey(
  template: string,
  env: Record<string, string>,
  hashFiles: HashFilesFn,
  signal?: AbortSignal,
): Promise<ResolvedKey> {
  let withHashes = '';
  let last = 0;
  for (const m of template.matchAll(HASH_FILES_RE)) {
    const globs = parseHashFilesArgs(m[1]);
    if (!globs) return { ok: false, message: `malformed hashFiles(...) in '${template}'` };
    let digest: string;
    try {
      digest = await hashFiles(globs, signal);
    } catch (err) {
      return {
        ok: false,
        message: `hashFiles failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    withHashes += template.slice(last, m.index) + digest;
    last = (m.index ?? 0) + m[0].length;
  }
  withHashes += template.slice(last);
  const substituted = substituteEnvString(withHashes, env);
  const unresolved = substituted.match(/\$\{[^}]*\}/);
  if (unresolved) {
    return { ok: false, message: `key '${template}' references unset ${unresolved[0]}` };
  }
  const key = substituted.trim().replace(KEY_UNSAFE_CHARS_RE, '-');
  if (!key) return { ok: false, message: `key '${template}' resolved to an empty string` };
  if (key.length > CACHE_MAX_KEY_LENGTH) {
    return { ok: false, message: `key is longer than ${CACHE_MAX_KEY_LENGTH} characters` };
  }
  return { ok: true, key };
}

/** Org + project namespace for a cache key. */
export function cacheObjectPrefix(
  orgId: string | undefined,
  projectId: string | undefined,
): string {
  const seg = (s: string | undefined) => (s || 'default').replace(/[^A-Za-z0-9._-]/g, '-');
  return `finalize-cache/${seg(orgId)}/${seg(projectId)}/`;
}

/** Storage seam. Object keys are full S3 keys (prefix included). */
export interface CacheStore {
  exists(objectKey: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Newest object whose key starts with `objectKeyPrefix`, or null. Throws when
   * the newest cannot be established (e.g. the listing is too large), rather
   * than returning an unverified candidate.
   */
  newestWithPrefix(objectKeyPrefix: string, signal?: AbortSignal): Promise<string | null>;
  presignGet(objectKey: string): Promise<string>;
  presignPut(objectKey: string): Promise<string>;
}

export interface CacheStepContext {
  store: CacheStore | null;
  orgId?: string;
  projectId?: string;
  env: Record<string, string>;
  hashFiles: HashFilesFn;
}

/**
 * Per-execution cache state. One instance per job attempt so a retry on a
 * fresh runner re-resolves (a key saved by a sibling meanwhile is a hit).
 */
export class JobCacheSession {
  private readonly exactHits = new Set<CiCacheEntry>();

  constructor(private readonly ctx: CacheStepContext) {}

  private get prefix(): string {
    return cacheObjectPrefix(this.ctx.orgId, this.ctx.projectId);
  }

  /** Env for a Restore cache step. Never throws. */
  async restoreEnv(entry: CiCacheEntry, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!this.ctx.store) return disabledEnv();
    const key = await resolveCacheKey(entry.key, this.ctx.env, this.ctx.hashFiles, signal);
    if (!key.ok) return { AH_CACHE_STATUS: 'error', AH_CACHE_MESSAGE: `warning: ${key.message}` };
    const store = this.ctx.store;
    try {
      const exactObject = this.prefix + key.key;
      if (await store.exists(exactObject, signal)) {
        this.exactHits.add(entry);
        return {
          AH_CACHE_STATUS: 'hit',
          AH_CACHE_KEY: key.key,
          AH_CACHE_MESSAGE: `restored ${key.key}`,
          AH_CACHE_URL: await store.presignGet(exactObject),
        };
      }
      for (const template of entry.restoreKeys) {
        const restoreKey = await resolveCacheKey(
          template,
          this.ctx.env,
          this.ctx.hashFiles,
          signal,
        );
        if (!restoreKey.ok) continue;
        const found = await store.newestWithPrefix(this.prefix + restoreKey.key, signal);
        if (found) {
          const matched = found.slice(this.prefix.length);
          return {
            AH_CACHE_STATUS: 'partial',
            AH_CACHE_KEY: key.key,
            AH_CACHE_MESSAGE: `restored ${matched} (restore-keys match for ${key.key})`,
            AH_CACHE_URL: await store.presignGet(found),
          };
        }
      }
      return {
        AH_CACHE_STATUS: 'miss',
        AH_CACHE_KEY: key.key,
        AH_CACHE_MESSAGE: `miss: no cache entry for ${key.key}`,
      };
    } catch (err) {
      return {
        AH_CACHE_STATUS: 'error',
        AH_CACHE_MESSAGE: `warning: cache lookup failed (${errMessage(err)}); continuing without cache`,
      };
    }
  }

  /** Env for a Save cache step. Never throws. */
  async saveEnv(entry: CiCacheEntry, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!this.ctx.store) return disabledEnv();
    const key = await resolveCacheKey(entry.key, this.ctx.env, this.ctx.hashFiles, signal);
    if (!key.ok) return { AH_CACHE_STATUS: 'error', AH_CACHE_MESSAGE: `warning: ${key.message}` };
    if (this.exactHits.has(entry)) {
      return {
        AH_CACHE_STATUS: 'skip',
        AH_CACHE_KEY: key.key,
        AH_CACHE_MESSAGE: `${key.key} was restored from an exact hit; not saving again`,
      };
    }
    const store = this.ctx.store;
    try {
      const objectKey = this.prefix + key.key;
      if (await store.exists(objectKey, signal)) {
        return {
          AH_CACHE_STATUS: 'skip',
          AH_CACHE_KEY: key.key,
          AH_CACHE_MESSAGE: `${key.key} was already saved by another job; not saving again`,
        };
      }
      return {
        AH_CACHE_STATUS: 'save',
        AH_CACHE_KEY: key.key,
        AH_CACHE_MESSAGE: `saving ${key.key}`,
        AH_CACHE_URL: await store.presignPut(objectKey),
      };
    } catch (err) {
      return {
        AH_CACHE_STATUS: 'error',
        AH_CACHE_MESSAGE: `warning: cache save setup failed (${errMessage(err)}); not saved`,
      };
    }
  }
}

/**
 * Deadline for resolving a cache step's env (hashFiles, S3 lookups, presigning).
 * It runs before the step's own deadline starts, so it needs its own bound.
 */
export const CACHE_SETUP_TIMEOUT_MS = 2 * 60_000;

/** Minimal cancellation source (structurally the orchestrator's CancelSignal). */
export interface CacheSetupCancel {
  readonly aborted: boolean;
  onAbort(listener: () => void): () => void;
}

export type CacheSetupOutcome =
  | { kind: 'env'; env: Record<string, string> }
  | { kind: 'cancelled' };

/**
 * Run cache-step setup under a deadline and the run's cancellation. Neither a
 * stalled lookup nor a slow credential fetch can hold the job: a timeout
 * resolves to a warning env (the step logs it and the job runs cold or skips
 * the save), and a cancellation resolves at once so the caller can unwind and
 * release its runner. The abort signal handed to `setup` is fired in both
 * cases so cooperative work (S3 requests, git) stops too.
 */
export async function boundedCacheSetup(
  setup: (signal: AbortSignal) => Promise<Record<string, string>>,
  opts: { timeoutMs?: number; cancel?: CacheSetupCancel },
): Promise<CacheSetupOutcome> {
  const timeoutMs = opts.timeoutMs ?? CACHE_SETUP_TIMEOUT_MS;
  if (opts.cancel?.aborted) return { kind: 'cancelled' };
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await Promise.race<CacheSetupOutcome>([
      setup(ac.signal).then(
        (env) => ({ kind: 'env', env }),
        (err) => ({
          kind: 'env',
          env: {
            AH_CACHE_STATUS: 'error',
            AH_CACHE_MESSAGE: `warning: cache setup failed (${errMessage(err)}); continuing without cache`,
          },
        }),
      ),
      new Promise<CacheSetupOutcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            kind: 'env',
            env: {
              AH_CACHE_STATUS: 'error',
              AH_CACHE_MESSAGE: `warning: cache setup timed out after ${Math.round(
                timeoutMs / 1000,
              )}s; continuing without cache`,
            },
          });
        }, timeoutMs);
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      }),
      new Promise<CacheSetupOutcome>((resolve) => {
        unsubscribe = opts.cancel?.onAbort(() => resolve({ kind: 'cancelled' }));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    ac.abort();
  }
}

function disabledEnv(): Record<string, string> {
  return {
    AH_CACHE_STATUS: 'disabled',
    AH_CACHE_MESSAGE:
      'cache storage is not configured on this Hub (FINALIZE_CACHE_BUCKET is unset); skipping',
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function cacheStepName(action: 'restore' | 'save', entry: CiCacheEntry): string {
  return `${action === 'restore' ? 'Restore' : 'Save'} cache (${entry.paths.join(', ')})`;
}

/**
 * Per-step deadline for cache steps. The curl bounds below fire first, so a
 * stalled transfer prints a warning and exits 0 instead of being killed. The
 * job runner still treats a killed cache step as a warning, never a red job.
 */
export const CACHE_STEP_TIMEOUT_MINUTES = 30;
/** Hard ceiling on one transfer; leaves headroom under the step deadline. */
export const CACHE_TRANSFER_MAX_SECONDS = 25 * 60;
/** Abort a transfer slower than 1 MiB/s for a full minute (a stall). */
const CURL_BOUNDS = `--connect-timeout 20 --max-time ${CACHE_TRANSFER_MAX_SECONDS} --speed-limit 1048576 --speed-time 60`;

/**
 * Restore step body. Reads AH_CACHE_* from its env. Always exits 0.
 *
 * The archive is extracted into a staging dir on the same volume and then
 * hard-linked into the cache root. A file only appears in the cache once it is
 * complete, and an existing file is never replaced, even when several jobs on
 * one host restore into the shared volume at the same time.
 */
export function buildRestoreScript(root: string = CACHE_ROOT): string {
  return `set +e
root=${root}
case "\${AH_CACHE_STATUS:-}" in
  hit|partial) ;;
  *) echo "[cache] \${AH_CACHE_MESSAGE:-restore skipped}"; exit 0 ;;
esac
started=$SECONDS
tmp=$(mktemp -d "$root/.ahcache-restore.XXXXXX") || { echo "[cache] warning: cannot write to $root; continuing without cache"; exit 0; }
trap 'rm -rf "$tmp"' EXIT
if ! curl -fsS --retry 3 --retry-delay 2 ${CURL_BOUNDS} -o "$tmp/archive" "$AH_CACHE_URL"; then
  echo "[cache] warning: download failed or stalled; continuing without cache"
  exit 0
fi
case "$(od -An -tx1 -N4 "$tmp/archive" | tr -d ' \\n')" in
  28b52ffd) decompress="zstd -dcq" ;;
  1f8b*) decompress="gzip -dc" ;;
  *) decompress="cat" ;;
esac
mkdir "$tmp/x"
if ! $decompress "$tmp/archive" | tar -x -C "$tmp/x"; then
  echo "[cache] warning: extract failed; continuing without cache"
  exit 0
fi
# One no-replace install pass. cp -l creates every file with link(2), which
# fails with EEXIST instead of replacing, so a file another job installed
# first (even mid-race) is kept. Directories are created or reused, never
# moved, so nothing can end up nested inside an existing directory.
cp -al -n "$tmp/x/." "$root/" 2>/dev/null
bytes=$(stat -c %s "$tmp/archive")
echo "[cache] $AH_CACHE_MESSAGE ($((bytes / 1048576)) MiB in $((SECONDS - started))s)"
`;
}

/**
 * Save step body for one entry. Paths were validated at parse time against a
 * charset with no shell meaning beyond globbing, so they are spliced unquoted
 * (each prefixed with ./ so none can read as a tar option).
 *
 * The upload is a conditional PUT (If-None-Match: *, signed into the URL), so
 * when two shards race to save the same key the first one wins and the other
 * gets 412/409, which is reported as already saved. An entry never changes
 * under the jobs reading it.
 */
export function buildSaveScript(entry: CiCacheEntry, root: string = CACHE_ROOT): string {
  const patterns = entry.paths.map((p) => `./${p}`).join(' ');
  return `set +e
root=${root}
if [ "\${AH_CACHE_STATUS:-}" != save ]; then
  echo "[cache] \${AH_CACHE_MESSAGE:-save skipped}"
  exit 0
fi
cd "$root" || { echo "[cache] warning: $root is missing; not saved"; exit 0; }
shopt -s nullglob
files=()
for p in ${patterns}; do
  [ -e "$p" ] && files+=("$p")
done
if [ \${#files[@]} -eq 0 ]; then
  echo "[cache] nothing to save: no cache path exists under $root"
  exit 0
fi
started=$SECONDS
tmp=$(mktemp -d "$root/.ahcache-save.XXXXXX") || { echo "[cache] warning: cannot write to $root; not saved"; exit 0; }
trap 'rm -rf "$tmp"' EXIT
if command -v zstd >/dev/null 2>&1; then
  tar -cf - --exclude='./.ahcache-*' "\${files[@]}" | zstd -q -T0 -3 -o "$tmp/archive"
else
  tar -cf - --exclude='./.ahcache-*' "\${files[@]}" | gzip -1 > "$tmp/archive"
fi
if [ $? -ne 0 ]; then
  echo "[cache] warning: archive failed; not saved"
  exit 0
fi
bytes=$(stat -c %s "$tmp/archive")
if [ "$bytes" -gt ${CACHE_MAX_ARCHIVE_BYTES} ]; then
  echo "[cache] warning: archive is $((bytes / 1048576)) MiB, over the 5 GiB upload limit; not saved"
  exit 0
fi
code=$(curl -sS --retry 3 --retry-delay 2 ${CURL_BOUNDS} -X PUT -H 'If-None-Match: *' -H 'Content-Type: application/octet-stream' -T "$tmp/archive" -o /dev/null -w '%{http_code}' "$AH_CACHE_URL")
case "$code" in
  2??) echo "[cache] saved $AH_CACHE_KEY ($((bytes / 1048576)) MiB in $((SECONDS - started))s)" ;;
  412|409) echo "[cache] $AH_CACHE_KEY was saved by another job first; keeping that copy" ;;
  *) echo "[cache] warning: upload failed (HTTP \${code:-none}); not saved" ;;
esac
exit 0
`;
}
