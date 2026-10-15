/**
 * GET /api/desktop/runtime: which DesktopRuntime backend this host uses for
 * agent desktops, and why. A fail-closed explicit `firecracker` reports
 * `available: false` with the operator-facing reason instead of erroring.
 */
import { Router } from 'express';
import config from '../config.js';
import { isFirecrackerBackendRegistered } from '../session-env/firecracker/firecracker-backend-status.js';
import { describeDesktopRuntimeSelection } from '../desktop/desktop-runtime-selection.js';
import { DESKTOP_SCREEN, type DesktopRuntimeMode } from '../desktop/desktop-runtime.js';

export interface DesktopRuntimeRouteDeps {
  configured?: () => DesktopRuntimeMode;
  firecrackerRegistered?: () => boolean;
  finalizeRunnerBackend?: () => string | null | undefined;
}

export default function createDesktopRuntimeRoutes(deps: DesktopRuntimeRouteDeps = {}): Router {
  const router = Router();
  const configured = deps.configured ?? (() => config.desktopRuntime);
  const firecrackerRegistered =
    deps.firecrackerRegistered ?? (() => isFirecrackerBackendRegistered());
  const finalizeRunnerBackend =
    deps.finalizeRunnerBackend ?? (() => process.env.FINALIZE_RUNNER_BACKEND);

  router.get('/api/desktop/runtime', (_req, res) => {
    const selection = describeDesktopRuntimeSelection({
      configured: configured(),
      firecrackerRegistered: firecrackerRegistered(),
      finalizeRunnerBackend: finalizeRunnerBackend(),
    });
    res.json({
      ...selection,
      firecrackerRegistered: firecrackerRegistered(),
      screen: DESKTOP_SCREEN,
    });
  });

  return router;
}
