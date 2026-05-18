/**
 * Production wiring for `PreviewRuntime` + `PreviewComposeRuntime`.
 *
 * Server startup calls {@link createPreviewRuntimes} once; both
 * singletons are then exposed to the chat handler and the session
 * archive/delete hooks via plain getter functions so callers don't need
 * to import the module here.
 *
 * The compose runtime's disk-backed `writeOverrideFile` lives here too —
 * it writes the per-group override YAML to
 * `<dataDir>/preview-compose/<groupId>.yml` with 0600 perms. Keeping the
 * fs interaction in the setup layer means the runtime stays unit-testable
 * with an in-memory DB and zero filesystem touches.
 *
 * Why a separate file rather than inlining in `server/index.ts`:
 *
 *   - The wiring is non-trivial (logSink, fetch adapter, override-file
 *     writer, log broadcaster) and a clean import keeps `index.ts`
 *     readable.
 *   - Test wiring for `routes/sessions.ts`'s archive/delete hooks
 *     re-uses the same factory with injected fakes — no production code
 *     paths get duplicated in tests.
 */

import { spawn as childSpawn } from 'child_process';
import { mkdirSync, appendFileSync, openSync, closeSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import {
  PreviewRuntime,
  type PreviewRuntimeConfig,
  type PreviewLogSink,
  type HealthFetchFn as RuntimeHealthFetchFn,
} from './preview-runtime.js';
import {
  PreviewComposeRuntime,
  buildComposeOverrideYaml,
  type PreviewComposeRuntimeConfig,
  type DeleteOverrideFileFn,
  type HealthFetchFn as ComposeHealthFetchFn,
} from './preview-compose-runtime.js';

export interface CreatePreviewRuntimesDeps {
  db: Database;
  /** Absolute filesystem path; the compose override + log dirs live under it. */
  dataDir: string;
  /** Optional log-line broadcaster — fed straight into PreviewRuntime.notifyLog. */
  notifyLog?: (info: {
    sessionId: string;
    groupId: string;
    processName: string;
    line: string;
    stream: 'stdout' | 'stderr';
  }) => void;
  /** Optional config overrides — primarily used by integration tests. */
  legacyConfig?: PreviewRuntimeConfig;
  composeConfig?: PreviewComposeRuntimeConfig;
}

export interface CreatePreviewRuntimesResult {
  previewRuntime: PreviewRuntime;
  previewComposeRuntime: PreviewComposeRuntime;
  /** Resolved compose override dir (`<dataDir>/preview-compose`). */
  composeOverrideDir: string;
}

/**
 * Tighter return type than the runtime's `WriteOverrideFileFn` contract
 * (which permits `string | null` for opt-out writers). The disk-backed
 * impl always produces a path, so callers + tests don't have to
 * non-null assert. Assignable to the looser runtime type since `string`
 * is a subtype of `string | null`.
 */
type DiskOverrideFileWriter = (opts: {
  groupId: string;
  entryService: string;
  hostPort: number;
  entryPort: number;
}) => string;

/**
 * Build the disk-backed `writeOverrideFile` impl scoped to
 * `composeOverrideDir`. Exported so tests can pin the exact write
 * behaviour (path, perms, body) without standing up the full runtime.
 *
 * The returned writer hardens the inputs:
 *   - `groupId` is stripped to `[A-Za-z0-9_-]` so a hand-built id with
 *     path separators can't land the file outside `composeOverrideDir`.
 *   - An empty post-strip id throws — the caller is the runtime, which
 *     always passes a uuid, so a sanitised-to-empty groupId means
 *     someone forced a hostile value.
 * Perms are `0o600` (owner read/write only) — compose is spawned by
 * the same account so the docker CLI can still resolve the file.
 */

export function buildDiskOverrideFileWriter(composeOverrideDir: string): DiskOverrideFileWriter {
  return ({ groupId, entryService, hostPort, entryPort }) => {
    const safeId = groupId.replace(/[^A-Za-z0-9_-]/g, '');
    if (!safeId) {
      throw new Error(
        `[preview-compose] writeOverrideFile: refusing empty/sanitised groupId (was: ${JSON.stringify(groupId)})`,
      );
    }
    const overridePath = path.join(composeOverrideDir, `${safeId}.yml`);
    const body = buildComposeOverrideYaml({ entryService, hostPort, entryPort });
    writeFileSync(overridePath, body, { mode: 0o600 });
    return overridePath;
  };
}

/**
 * Build the disk-backed `deleteOverrideFile` impl scoped to
 * `composeOverrideDir`. The cleanup hook is best-effort by contract:
 * a missing file is a no-op, and a path that resolves outside the
 * scope dir is refused (defense in depth against a corrupted
 * `override_file_path` column).
 */
export function buildDiskOverrideFileDeleter(composeOverrideDir: string): DeleteOverrideFileFn {
  return (overrideFilePath: string) => {
    const resolved = path.resolve(overrideFilePath);
    const root = path.resolve(composeOverrideDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      console.warn(
        `[preview-compose] deleteOverrideFile: refusing path outside composeOverrideDir (${overrideFilePath})`,
      );
      return;
    }
    try {
      rmSync(resolved, { force: true });
    } catch (err) {
      console.warn(
        `[preview-compose] deleteOverrideFile failed (${resolved}):`,
        (err as Error).message,
      );
    }
  };
}

/**
 * Construct the production runtime pair. Both runtimes share the same
 * SQLite database so the legacy spawn pool + compose pool see each
 * other's allocated ports through the `worktree_preview_processes`
 * UNIQUE(port) invariant.
 */
export function createPreviewRuntimes(
  deps: CreatePreviewRuntimesDeps,
): CreatePreviewRuntimesResult {
  const previewsDir = path.join(deps.dataDir, 'previews');
  const composeOverrideDir = path.join(deps.dataDir, 'preview-compose');
  mkdirSync(previewsDir, { recursive: true });
  mkdirSync(composeOverrideDir, { recursive: true });

  const logSink: PreviewLogSink = {
    open(previewId: string) {
      // `previewId` for multi-process previews is `<groupId>/<processName>`
      // — keep both segments so the path is unique per process. We avoid
      // calling `path.join` on a possibly-relative previewId to keep
      // platform-specific path semantics out.
      const safe = previewId.replace(/[^A-Za-z0-9_:/-]/g, '_');
      const logPath = path.join(previewsDir, `${safe.replace(/\//g, '__')}.log`);
      mkdirSync(path.dirname(logPath), { recursive: true });
      // Touch the file so callers see a stable path even before the
      // first chunk arrives. Best-effort — a write failure here is
      // surfaced on the next append.
      try {
        const fd = openSync(logPath, 'a');
        closeSync(fd);
      } catch {
        /* swallow — appendFileSync below will surface real errors */
      }
      return {
        path: logPath,
        append(chunk: string) {
          try {
            appendFileSync(logPath, chunk);
          } catch (err) {
            console.warn(`[preview-log] append failed (${logPath}):`, (err as Error).message);
          }
        },
        close() {
          /* `appendFileSync` opens + closes per-call; nothing to release */
        },
      };
    },
  };

  const writeOverrideFile = buildDiskOverrideFileWriter(composeOverrideDir);
  const deleteOverrideFile = buildDiskOverrideFileDeleter(composeOverrideDir);

  // Adapt the global `fetch` to the runtimes' minimal {ok,status}
  // contract. Network errors throw — both runtimes catch the throw and
  // treat it as "not ready yet, poll again".
  const sharedFetch: RuntimeHealthFetchFn & ComposeHealthFetchFn = async (url) => {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    return { ok: res.ok, status: res.status };
  };

  const previewRuntime = new PreviewRuntime({
    db: deps.db,
    spawn: childSpawn,
    fetch: sharedFetch,
    logSink,
    config: deps.legacyConfig,
    notifyLog: deps.notifyLog,
  });

  const previewComposeRuntime = new PreviewComposeRuntime({
    db: deps.db,
    spawn: childSpawn,
    fetch: sharedFetch,
    writeOverrideFile,
    deleteOverrideFile,
    config: deps.composeConfig,
  });

  return { previewRuntime, previewComposeRuntime, composeOverrideDir };
}
