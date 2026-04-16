/**
 * preview-engine.ts — Docker container orchestration for PR previews.
 *
 * Manages the lifecycle of isolated Docker containers that serve a full
 * Agent Hub stack (server + built client) for a specific PR branch.
 *
 * Lifecycle: build image → create container → start → monitor TTL → stop + remove
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Stmts, PreviewContainerRow, BroadcastFn } from './types.js';

const execFileAsync = promisify(execFile);

/** Port range for preview containers (avoids conflicts with dev server) */
const PORT_RANGE_START = 4000;
const PORT_RANGE_END = 4999;

/** Default TTL in minutes */
export const DEFAULT_TTL_MINUTES = 60;

/** Maximum concurrent preview containers */
export const MAX_CONCURRENT_PREVIEWS = 10;

export interface PreviewEngineDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

let _deps: PreviewEngineDeps | null = null;
let _cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function initPreviewEngine(deps: PreviewEngineDeps): void {
  _deps = deps;

  // Check for expired previews every 60 seconds
  _cleanupInterval = setInterval(() => {
    cleanupExpiredPreviews().catch((err) => {
      console.error('[Preview] Cleanup error:', (err as Error).message);
    });
  }, 60_000);
}

export function stopPreviewEngine(): void {
  if (_cleanupInterval) {
    clearInterval(_cleanupInterval);
    _cleanupInterval = null;
  }
}

/**
 * Check if Docker is available on the host.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available port in the preview range.
 */
async function findAvailablePort(stmts: Stmts): Promise<number> {
  const running = stmts.getRunningPreviews.all() as PreviewContainerRow[];
  const usedPorts = new Set(running.map((r) => r.port).filter(Boolean));

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  throw new Error('No available ports in preview range');
}

/**
 * Build and start a preview container for a PR branch.
 */
export async function createPreview(opts: {
  id: string;
  projectId: string;
  prNumber: number;
  prUrl: string | null;
  branch: string;
  commitSha: string | null;
  repoUrl: string;
  ttlMinutes?: number;
}): Promise<PreviewContainerRow> {
  if (!_deps) throw new Error('Preview engine not initialized');
  const { stmts, broadcast } = _deps;

  const ttl = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;

  // Check concurrent limit
  const running = stmts.getRunningPreviews.all() as PreviewContainerRow[];
  if (running.length >= MAX_CONCURRENT_PREVIEWS) {
    throw new Error(
      `Maximum concurrent previews reached (${MAX_CONCURRENT_PREVIEWS}). Stop an existing preview first.`,
    );
  }

  // Check for existing preview for this PR
  const existing = stmts.getPreviewContainerByPr.get(opts.projectId, opts.prNumber) as
    | PreviewContainerRow
    | undefined;
  if (existing) {
    throw new Error(`Preview already exists for PR #${opts.prNumber} (status: ${existing.status})`);
  }

  // Insert the record in 'building' state
  stmts.createPreviewContainer.run(
    opts.id,
    opts.projectId,
    opts.prNumber,
    opts.prUrl,
    opts.branch,
    opts.commitSha,
    opts.repoUrl,
    ttl,
    ttl, // used for datetime calculation
  );

  const row = stmts.getPreviewContainer.get(opts.id) as PreviewContainerRow;

  broadcast({
    type: 'preview_update',
    projectId: opts.projectId,
    preview: row,
  });

  // Kick off async build (non-blocking)
  buildAndStart(opts.id).catch((err) => {
    console.error(`[Preview] Build failed for ${opts.id}:`, (err as Error).message);
  });

  return row;
}

/**
 * Internal: build the Docker image and start the container.
 */
async function buildAndStart(previewId: string): Promise<void> {
  if (!_deps) throw new Error('Preview engine not initialized');
  const { stmts, broadcast } = _deps;

  const row = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow | undefined;
  if (!row) return;

  const imageName = `agenthub-preview-${row.project_id}-pr${row.pr_number}`;
  const containerName = `agenthub-preview-${row.id}`;
  let buildLog = '';

  try {
    // 1. Build the Docker image
    console.log(`[Preview] Building image for PR #${row.pr_number} on branch ${row.branch}...`);

    const buildArgs = [
      'build',
      '-f',
      'Dockerfile.preview',
      '--build-arg',
      `REPO_URL=${row.repo_url}`,
      '--build-arg',
      `BRANCH=${row.branch}`,
    ];

    if (row.commit_sha) {
      buildArgs.push('--build-arg', `COMMIT_SHA=${row.commit_sha}`);
    }

    buildArgs.push('-t', imageName, '.');

    const { stdout: buildStdout, stderr: buildStderr } = await execFileAsync(
      'docker',
      buildArgs,
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }, // 5 min timeout, 10MB buffer
    );
    buildLog = (buildStdout + '\n' + buildStderr).trim();

    // 2. Find a port
    const port = await findAvailablePort(stmts);
    const url = `http://localhost:${port}`;

    // 3. Start the container
    console.log(`[Preview] Starting container on port ${port}...`);

    const { stdout: containerId } = await execFileAsync('docker', [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      `${port}:3051`,
      '--restart',
      'no',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '-e',
      'NODE_ENV=production',
      imageName,
    ]);

    const trimmedContainerId = containerId.trim();

    // 4. Update the record
    stmts.updatePreviewContainer.run(
      trimmedContainerId,
      port,
      url,
      'running',
      null, // no error
      buildLog,
      previewId,
    );

    const updated = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow;
    broadcast({
      type: 'preview_update',
      projectId: row.project_id,
      preview: updated,
    });

    console.log(
      `[Preview] PR #${row.pr_number} preview running at ${url} (container: ${trimmedContainerId.slice(0, 12)})`,
    );
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown build error';
    console.error(`[Preview] Failed: ${errorMessage}`);

    stmts.updatePreviewContainer.run(
      null, // no container_id
      null, // no port
      null, // no url
      'error',
      errorMessage,
      buildLog || null,
      previewId,
    );

    const updated = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow;
    broadcast({
      type: 'preview_update',
      projectId: row.project_id,
      preview: updated,
    });
  }
}

/**
 * Stop and remove a preview container.
 */
export async function stopPreview(previewId: string): Promise<PreviewContainerRow | null> {
  if (!_deps) throw new Error('Preview engine not initialized');
  const { stmts, broadcast } = _deps;

  const row = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow | undefined;
  if (!row) return null;

  // Mark as stopping
  stmts.updatePreviewContainerStatus.run('stopping', previewId);
  broadcast({
    type: 'preview_update',
    projectId: row.project_id,
    preview: { ...row, status: 'stopping' },
  });

  try {
    if (row.container_id) {
      // Stop the container (10s grace period)
      await execFileAsync('docker', ['stop', '-t', '10', row.container_id]).catch(() => {
        // Container may already be stopped
      });

      // Remove the container
      await execFileAsync('docker', ['rm', '-f', row.container_id]).catch(() => {
        // Container may already be removed
      });
    }

    // Clean up the image
    const imageName = `agenthub-preview-${row.project_id}-pr${row.pr_number}`;
    await execFileAsync('docker', ['rmi', '-f', imageName]).catch(() => {
      // Image may not exist
    });

    stmts.updatePreviewContainerStatus.run('stopped', previewId);

    const updated = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow;
    broadcast({
      type: 'preview_update',
      projectId: row.project_id,
      preview: updated,
    });

    console.log(`[Preview] Stopped PR #${row.pr_number} preview`);
    return updated;
  } catch (err) {
    const errorMessage = (err as Error).message;
    console.error(`[Preview] Stop error: ${errorMessage}`);
    stmts.updatePreviewContainerStatus.run('error', previewId);
    return stmts.getPreviewContainer.get(previewId) as PreviewContainerRow;
  }
}

/**
 * Get container logs (stdout + stderr).
 */
export async function getPreviewLogs(
  previewId: string,
  tail: number = 200,
): Promise<string | null> {
  if (!_deps) throw new Error('Preview engine not initialized');
  const { stmts } = _deps;

  const row = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow | undefined;
  if (!row?.container_id) return row?.build_log || null;

  try {
    const { stdout, stderr } = await execFileAsync('docker', [
      'logs',
      '--tail',
      String(tail),
      row.container_id,
    ]);
    return (stdout + '\n' + stderr).trim();
  } catch {
    return row.build_log || null;
  }
}

/**
 * Rebuild a preview — stops the old one and creates a new build.
 */
export async function rebuildPreview(previewId: string): Promise<void> {
  if (!_deps) throw new Error('Preview engine not initialized');
  const { stmts } = _deps;

  const row = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow | undefined;
  if (!row) throw new Error('Preview not found');

  // Stop existing
  if (row.status === 'running' || row.status === 'building') {
    await stopPreview(previewId);
  }

  // Reset status and kick off rebuild
  stmts.updatePreviewContainerStatus.run('building', previewId);
  buildAndStart(previewId).catch((err) => {
    console.error(`[Preview] Rebuild failed for ${previewId}:`, (err as Error).message);
  });
}

/**
 * Clean up expired preview containers.
 */
export async function cleanupExpiredPreviews(): Promise<number> {
  if (!_deps) throw new Error('Preview engine not initialized');
  const { stmts } = _deps;

  const expired = stmts.getExpiredPreviews.all() as PreviewContainerRow[];
  let cleaned = 0;

  for (const preview of expired) {
    try {
      console.log(`[Preview] TTL expired for PR #${preview.pr_number}, stopping...`);
      await stopPreview(preview.id);
      cleaned++;
    } catch (err) {
      console.error(`[Preview] Failed to clean up ${preview.id}:`, (err as Error).message);
    }
  }

  if (cleaned > 0) {
    console.log(`[Preview] Cleaned up ${cleaned} expired preview(s)`);
  }

  return cleaned;
}
