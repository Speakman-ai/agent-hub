/**
 * Production wiring for {@link DevServerRuntime}.
 *
 * Server startup calls {@link createPreviewRuntimes} once; the singleton
 * is then exposed to the chat handler and the session archive/delete
 * hooks via a plain getter function so callers don't need to import the
 * module here.
 *
 * Why a separate file rather than inlining in `server/index.ts`:
 *
 *   - The wiring is non-trivial (health probe adapter, project env
 *     loader, log broadcaster) and a clean import keeps `index.ts`
 *     readable.
 *   - Test wiring for `routes/sessions.ts`'s archive/delete hooks
 *     re-uses the same factory with injected fakes — no production code
 *     paths get duplicated in tests.
 */

import type { Database } from 'better-sqlite3';
import { probePreviewHealth } from './preview-health-fetch.js';
import { loadProjectEnvForSpawn } from './preview-secrets-store.js';
import { reclaimFailedPortsInRange } from './preview-port-reclaim.js';
import { DEFAULT_PREVIEW_PORT_RANGE } from './preview-schema.js';
import {
  DevServerRuntime,
  type DevServerRuntimeConfig,
  type DevServerNotifyStatusFn,
  type ResolveSharedSessionEnvFn,
} from './dev-server-runtime.js';
import type { Project } from '../types.js';

export interface CreatePreviewRuntimesDeps {
  db: Database;
  /** Optional log-line broadcaster — fed straight into the runtime's notifyLog. */
  notifyLog?: (info: {
    sessionId: string;
    groupId: string;
    processName: string;
    line: string;
    stream: 'stdout' | 'stderr';
  }) => void;
  /**
   * Optional terminal-status broadcaster. Fires when the background
   * health-check flips a dev server to `ready` / `failed` outside the
   * chat handler's polling window. Wired in production to the WS
   * `broadcast()` so a reconnecting client sees the transition.
   */
  notifyStatus?: DevServerNotifyStatusFn;
  /** Optional config overrides — primarily used by integration tests. */
  devServerConfig?: DevServerRuntimeConfig;
  /** Project resolver for the dev-server runtime's `reap` pass. */
  getProject?: (projectId: string) => Project | null;
  /**
   * Session-owned env lookup. Supplied in production so a preview runs inside
   * the same boundary as the session's terminal and commands.
   */
  resolveSharedEnv?: ResolveSharedSessionEnvFn;
  /**
   * Keep the session env's idle clock alive while the preview is in use
   * (guest daemons do not count as Hub-visible live processes).
   */
  onSessionActivity?: (sessionId: string) => void;
}

export interface CreatePreviewRuntimesResult {
  devServerRuntime: DevServerRuntime;
}

/**
 * Construct the production runtime. Health probes go through
 * `probePreviewHealth` rather than undici's `fetch`: when the Hub runs in
 * Docker the probe host is `host.docker.internal`, and Vite/Angular dev
 * servers reject that `Host` with a 403 from their allowedHosts gate. The
 * probe must therefore send `Host: localhost`, and undici's `fetch`
 * silently ignores a manual Host override (verified — it still sends the
 * URL's hostname), so a fetch-based probe would 403 forever and the
 * preview would never flip to `ready`. `probePreviewHealth` uses Node's
 * `http.get`, which honors the override.
 */
export function createPreviewRuntimes(
  deps: CreatePreviewRuntimesDeps,
): CreatePreviewRuntimesResult {
  const devServerRuntime = new DevServerRuntime({
    db: deps.db,
    fetch: async (url) => {
      const { ok, statusCode } = await probePreviewHealth(url);
      return { ok, status: statusCode ?? 0 };
    },
    loadProjectEnv: (projectId, ctx) =>
      loadProjectEnvForSpawn(projectId, { sessionId: ctx.sessionId }),
    getProject: deps.getProject,
    notifyLog: deps.notifyLog,
    notifyStatus: deps.notifyStatus,
    config: deps.devServerConfig,
    ...(deps.resolveSharedEnv ? { resolveSharedEnv: deps.resolveSharedEnv } : {}),
    ...(deps.onSessionActivity ? { onSessionActivity: deps.onSessionActivity } : {}),
  });

  const portMin = deps.devServerConfig?.portRange?.min ?? DEFAULT_PREVIEW_PORT_RANGE.min;
  const portMax = deps.devServerConfig?.portRange?.max ?? DEFAULT_PREVIEW_PORT_RANGE.max;
  const reclaimedOnBoot = reclaimFailedPortsInRange(deps.db, portMin, portMax);
  if (reclaimedOnBoot > 0) {
    console.log(
      `[preview] startup: reclaimed ${reclaimedOnBoot} failed preview port(s) in [${portMin}, ${portMax}]`,
    );
  }

  return { devServerRuntime };
}
