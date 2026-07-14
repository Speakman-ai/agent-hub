/**
 * One-shot compose preview validation for Settings → Build and run.
 */
import type { Project } from './types.js';
import type { PreviewComposeRuntime } from './preview/preview-compose-runtime.js';
import { isLegacyPreviewComposeConfig } from './preview/preview-compose-config.js';

const BUILD_TEST_SESSION_PREFIX = '__preview_build_test__';
const POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min — cold compose + DB restore budget

export interface PreviewComposeBuildTestResult {
  ok: boolean;
  ports: { allocated: number | null };
  durationMs: number;
  error?: string;
  logTail: string[];
  url?: string;
}

export async function runPreviewComposeBuildTest(
  runtime: PreviewComposeRuntime,
  project: Project,
  options?: {
    timeoutMs?: number;
    clock?: { nowMs: () => number; sleep: (ms: number) => Promise<void> };
  },
): Promise<PreviewComposeBuildTestResult> {
  const clock = options?.clock ?? {
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = clock.nowMs();
  const cwd = project.cwd;
  if (!cwd || typeof cwd !== 'string') {
    return {
      ok: false,
      ports: { allocated: null },
      durationMs: 0,
      error: 'Project has no cwd configured.',
      logTail: [],
    };
  }
  if (!project.prEnv?.preview?.enabled || !project.prEnv.preview.compose) {
    return {
      ok: false,
      ports: { allocated: null },
      durationMs: clock.nowMs() - start,
      error: 'Preview compose config is not enabled.',
      logTail: [],
    };
  }
  if (!isLegacyPreviewComposeConfig(project.prEnv.preview.compose)) {
    return {
      ok: false,
      ports: { allocated: null },
      durationMs: clock.nowMs() - start,
      error:
        'Compose build test is only available for legacy app-wrapping configs. ' +
        'Start the managed dev server instead; compose is for backing services.',
      logTail: [],
    };
  }

  const sessionId = `${BUILD_TEST_SESSION_PREFIX}${project.id}`;
  let previewId: string | null = null;
  let port: number | null = null;

  try {
    const started = await runtime.startPreview(sessionId, project, cwd);
    previewId = started.previewId;
    port = started.port;

    const deadline = clock.nowMs() + timeoutMs;
    while (clock.nowMs() < deadline) {
      const row = runtime.getById(previewId);
      if (!row) {
        return {
          ok: false,
          ports: { allocated: port },
          durationMs: clock.nowMs() - start,
          error: 'Preview process disappeared during health check.',
          logTail: runtime.getLogTail(previewId),
        };
      }
      if (row.status === 'ready') {
        return {
          ok: true,
          ports: { allocated: port },
          durationMs: clock.nowMs() - start,
          logTail: runtime.getLogTail(previewId),
          url: started.url,
        };
      }
      if (row.status === 'failed') {
        return {
          ok: false,
          ports: { allocated: port },
          durationMs: clock.nowMs() - start,
          error: 'Compose preview failed health check — see logs below.',
          logTail: runtime.getLogTail(previewId),
        };
      }
      await clock.sleep(POLL_MS);
    }

    return {
      ok: false,
      ports: { allocated: port },
      durationMs: clock.nowMs() - start,
      error: `Compose preview timed out after ${Math.round(timeoutMs / 1000)}s.`,
      logTail: previewId ? runtime.getLogTail(previewId) : [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ports: { allocated: port },
      durationMs: clock.nowMs() - start,
      error: message,
      logTail: previewId ? runtime.getLogTail(previewId) : [],
    };
  } finally {
    if (previewId) {
      try {
        await runtime.stopPreview(previewId);
      } catch {
        /* best-effort teardown */
      }
    }
  }
}
