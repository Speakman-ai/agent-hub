/**
 * GET /api/desktop/runtime: which DesktopRuntime backend this host uses for
 * agent desktops, and why. A fail-closed explicit `firecracker` reports
 * `available: false` with the operator-facing reason instead of erroring.
 */
import { Router } from 'express';
import config from '../config.js';
import { isFirecrackerBackendRegistered } from '../session-env/firecracker/firecracker-backend-status.js';
import {
  describeDesktopRuntimeSelection,
  type DesktopRootfsStatus,
} from '../desktop/desktop-runtime-selection.js';
import { firecrackerDesktopRootfsStatus } from '../desktop/desktop-rootfs-status.js';
import { DESKTOP_SCREEN, type DesktopRuntimeMode } from '../desktop/desktop-runtime.js';

export interface DesktopRuntimeRouteDeps {
  configured?: () => DesktopRuntimeMode;
  firecrackerRegistered?: () => boolean;
  finalizeRunnerBackend?: () => string | null | undefined;
  desktopRootfs?: () => DesktopRootfsStatus;
}

export default function createDesktopRuntimeRoutes(deps: DesktopRuntimeRouteDeps = {}): Router {
  const router = Router();
  const configured = deps.configured ?? (() => config.desktopRuntime);
  const firecrackerRegistered =
    deps.firecrackerRegistered ?? (() => isFirecrackerBackendRegistered());
  const finalizeRunnerBackend =
    deps.finalizeRunnerBackend ?? (() => process.env.FINALIZE_RUNNER_BACKEND);
  const desktopRootfs = deps.desktopRootfs ?? (() => firecrackerDesktopRootfsStatus());

  router.get('/api/desktop/runtime', (_req, res) => {
    const registered = firecrackerRegistered();
    const rootfs = desktopRootfs();
    const selection = describeDesktopRuntimeSelection({
      configured: configured(),
      firecrackerRegistered: registered,
      desktopRootfs: rootfs,
      finalizeRunnerBackend: finalizeRunnerBackend(),
    });
    res.json({
      ...selection,
      firecrackerRegistered: registered,
      desktopRootfs: rootfs,
      screen: DESKTOP_SCREEN,
    });
  });

  return router;
}
