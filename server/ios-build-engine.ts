/**
 * ios-build-engine.ts — macOS VM orchestration for iOS PR preview builds.
 *
 * Manages the lifecycle of iOS builds on EC2 Mac instances:
 *   queue build -> provision VM -> clone + build via Xcode -> archive .ipa
 *   -> capture simulator recording -> upload artifacts -> cleanup VM
 *
 * This is a stub implementation that defines the interface and status
 * management. The actual EC2 Mac instance provisioning and Xcode build
 * commands require a macOS VM environment to be configured.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Stmts, BroadcastFn, IosBuildRow, IosBuildStatus } from './types.js';

const execFileAsync = promisify(execFile);

/** Active (non-terminal) build statuses — used by engine polling and route guards. */
const ACTIVE_STATUSES: readonly IosBuildStatus[] = [
  'queued',
  'provisioning',
  'building',
  'archiving',
  'uploading',
] as const;

/** Check if a build status is active (non-terminal). */
export function isBuildActive(status: IosBuildStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Maximum concurrent iOS builds (EC2 Mac instances are expensive) */
export const MAX_CONCURRENT_IOS_BUILDS = 2;

/** Default Xcode version to use */
export const DEFAULT_XCODE_VERSION = '16.2';

/** Build timeout in minutes */
export const BUILD_TIMEOUT_MINUTES = 30;

export interface IosBuildEngineDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

let _deps: IosBuildEngineDeps | null = null;
let _pollInterval: ReturnType<typeof setInterval> | null = null;

export function initIosBuildEngine(deps: IosBuildEngineDeps): void {
  _deps = deps;

  // Poll for build status updates every 30 seconds
  _pollInterval = setInterval(() => {
    pollBuildStatus().catch((err) => {
      console.error('[iOS Build] Poll error:', (err as Error).message);
    });
  }, 30_000);
}

export function stopIosBuildEngine(): void {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

/**
 * Check if the iOS build infrastructure is available.
 *
 * Currently returns false unconditionally — the actual EC2 Mac instance
 * provisioning and Xcode build pipeline are not yet wired up. Enable this
 * once the infrastructure is configured.
 */
export async function isIosBuildAvailable(): Promise<{
  available: boolean;
  reason?: string;
}> {
  // Stub: infrastructure not yet wired up
  return {
    available: false,
    reason: 'iOS build infrastructure is not yet configured',
  };
}

/**
 * Queue a new iOS build for a PR branch.
 */
export async function queueIosBuild(opts: {
  buildId: string;
  projectId: string;
  prNumber: number;
  branch: string;
  commitSha?: string;
  repoUrl: string;
  prUrl?: string;
}): Promise<void> {
  if (!_deps) throw new Error('iOS build engine not initialized');
  const { stmts, broadcast } = _deps;

  // Check concurrent build limit
  const running = stmts.getRunningIosBuilds.all() as IosBuildRow[];
  if (running.length >= MAX_CONCURRENT_IOS_BUILDS) {
    throw new Error(
      `Maximum concurrent iOS builds reached (${MAX_CONCURRENT_IOS_BUILDS}). ` +
        'Wait for a running build to complete or cancel one.',
    );
  }

  // Insert build record
  stmts.createIosBuild.run(
    opts.buildId,
    opts.projectId,
    opts.prNumber,
    opts.prUrl ?? null,
    opts.branch,
    opts.commitSha ?? null,
    opts.repoUrl,
    'queued',
  );

  broadcast({
    type: 'ios_build_update',
    projectId: opts.projectId,
    buildId: opts.buildId,
    status: 'queued',
  });

  // Start the build pipeline asynchronously
  startBuildPipeline(opts.buildId).catch((err) => {
    console.error(`[iOS Build] Pipeline error for ${opts.buildId}:`, (err as Error).message);
    updateBuildStatus(opts.buildId, 'error', (err as Error).message);
  });
}

/**
 * Cancel a running iOS build.
 */
export async function cancelIosBuild(buildId: string): Promise<void> {
  if (!_deps) throw new Error('iOS build engine not initialized');

  const build = _deps.stmts.getIosBuild.get(buildId) as IosBuildRow | undefined;
  if (!build) throw new Error(`Build ${buildId} not found`);

  if (build.status === 'ready' || build.status === 'error' || build.status === 'cancelled') {
    throw new Error(`Build is already ${build.status}`);
  }

  // Terminate the VM if provisioned
  if (build.vm_instance_id) {
    try {
      await terminateVm(build.vm_instance_id);
    } catch (err) {
      console.warn(`[iOS Build] Failed to terminate VM: ${(err as Error).message}`);
    }
  }

  updateBuildStatus(buildId, 'cancelled');
}

/**
 * Get build logs for a build.
 */
export function getIosBuildLogs(buildId: string): string {
  if (!_deps) throw new Error('iOS build engine not initialized');
  const build = _deps.stmts.getIosBuild.get(buildId) as IosBuildRow | undefined;
  return build?.build_log ?? 'No logs available';
}

// ─── Internal helpers ─────────────────────────────────────────────

function updateBuildStatus(buildId: string, status: IosBuildStatus, errorMessage?: string): void {
  if (!_deps) return;
  const { stmts, broadcast } = _deps;

  stmts.updateIosBuildStatus.run(status, errorMessage ?? null, buildId);

  const build = stmts.getIosBuild.get(buildId) as IosBuildRow | undefined;
  if (build) {
    broadcast({
      type: 'ios_build_update',
      projectId: build.project_id,
      buildId,
      status,
    });
  }
}

function appendBuildLog(buildId: string, line: string): void {
  if (!_deps) return;
  _deps.stmts.appendIosBuildLog.run(line + '\n', buildId);
}

/**
 * The full build pipeline. Each step updates status + logs.
 *
 * Steps:
 * 1. Provision EC2 Mac instance (or connect to existing dedicated host)
 * 2. Clone repo at branch/commit
 * 3. Install dependencies (npm install, pod install)
 * 4. Build with Xcode (xcodebuild archive)
 * 5. Export .ipa
 * 6. Run simulator recording
 * 7. Upload artifacts
 * 8. Generate install link (TestFlight or direct)
 * 9. Cleanup VM
 */
async function startBuildPipeline(buildId: string): Promise<void> {
  if (!_deps) return;

  const startTime = Date.now();

  // Step 1: Provisioning
  updateBuildStatus(buildId, 'provisioning');
  appendBuildLog(buildId, `[${new Date().toISOString()}] Provisioning macOS VM...`);

  // NOTE: This is where EC2 Mac instance provisioning would happen.
  // For now, this is a stub that logs the intent.
  // In production, this would:
  //   - Launch an ec2 mac2.metal instance from a pre-baked AMI
  //   - Wait for instance to reach "running" state
  //   - SSH in and verify Xcode is ready
  appendBuildLog(buildId, `[${new Date().toISOString()}] VM provisioning is not yet configured.`);
  appendBuildLog(
    buildId,
    'To enable iOS builds, configure a macOS VM (EC2 Mac dedicated host or similar).',
  );
  appendBuildLog(buildId, 'Required: macOS 14+, Xcode 16+, CocoaPods, EAS CLI');

  // For now, mark as error with a helpful message
  const duration = Math.round((Date.now() - startTime) / 1000);
  appendBuildLog(buildId, `[${new Date().toISOString()}] Build duration: ${duration}s`);
  updateBuildStatus(
    buildId,
    'error',
    'macOS VM not configured — see build logs for setup instructions',
  );
}

/**
 * Terminate an EC2 Mac instance.
 */
async function terminateVm(instanceId: string): Promise<void> {
  try {
    await execFileAsync('aws', ['ec2', 'terminate-instances', '--instance-ids', instanceId]);
  } catch (err) {
    console.error(`[iOS Build] Failed to terminate ${instanceId}:`, (err as Error).message);
    throw err;
  }
}

/**
 * Poll running builds for status updates from their VMs.
 */
async function pollBuildStatus(): Promise<void> {
  if (!_deps) return;

  const running = _deps.stmts.getRunningIosBuilds.all() as IosBuildRow[];
  for (const build of running) {
    // Check for stuck builds (> BUILD_TIMEOUT_MINUTES)
    const startedAt = new Date(build.created_at).getTime();
    const elapsed = (Date.now() - startedAt) / 60_000;
    if (elapsed > BUILD_TIMEOUT_MINUTES) {
      updateBuildStatus(
        build.id,
        'error',
        `Build timed out after ${BUILD_TIMEOUT_MINUTES} minutes`,
      );
      if (build.vm_instance_id) {
        terminateVm(build.vm_instance_id).catch(() => {});
      }
    }
  }
}
