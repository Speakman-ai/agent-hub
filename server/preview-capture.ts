/**
 * preview-capture.ts — Automated screenshot & video capture for preview environments.
 *
 * Uses Playwright (headless Chromium) to:
 *   1. Wait for the preview container health check to pass
 *   2. Navigate key routes and capture screenshots
 *   3. Record a short video walkthrough of the app
 *   4. Store artifacts on disk and metadata in SQLite
 *
 * Artifacts are stored in: <uploadsDir>/captures/<previewId>/
 */

import { chromium, type Browser } from 'playwright';
import { mkdirSync, existsSync, rmSync, renameSync, statSync } from 'fs';
import path from 'path';
import type { Stmts, PreviewContainerRow, PreviewCaptureRow, BroadcastFn } from './types.js';

/** Routes to capture screenshots of — covers the main UI surfaces */
const CAPTURE_ROUTES = [
  { path: '/', name: 'home', label: 'Home' },
  { path: '/chat', name: 'chat', label: 'Chat' },
  { path: '/settings', name: 'settings', label: 'Settings' },
  { path: '/board', name: 'board', label: 'Kanban Board' },
  { path: '/wiki', name: 'wiki', label: 'Wiki' },
  { path: '/previews', name: 'previews', label: 'Previews' },
];

/** Max time to wait for preview health check (ms) */
const HEALTH_CHECK_TIMEOUT = 60_000;

/** Interval between health check polls (ms) */
const HEALTH_CHECK_INTERVAL = 3_000;

/** Viewport dimensions for captures */
const VIEWPORT = { width: 1280, height: 720 };

/** Max time for entire capture session (ms) */
const CAPTURE_TIMEOUT = 120_000;

export interface CaptureResult {
  previewId: string;
  screenshots: Array<{
    route: string;
    name: string;
    label: string;
    filename: string;
    path: string;
  }>;
  video: {
    filename: string;
    path: string;
  } | null;
  duration_ms: number;
  error: string | null;
}

export interface CaptureEngineDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  uploadsDir: string;
}

let _deps: CaptureEngineDeps | null = null;

/** Track in-progress captures to prevent concurrent requests for the same preview */
const _inProgress = new Set<string>();

/** Cached result of Playwright availability check (null = not yet probed) */
let _playwrightAvailable: boolean | null = null;

export function initCaptureEngine(deps: CaptureEngineDeps): void {
  _deps = deps;
  _playwrightAvailable = null; // Reset cache on re-init
  // Ensure captures directory exists
  mkdirSync(path.join(deps.uploadsDir, 'captures'), { recursive: true });
}

/**
 * Check if Playwright/Chromium is available.
 * Result is cached after the first successful probe to avoid launching a
 * throwaway browser on every request.
 */
export async function isPlaywrightAvailable(): Promise<boolean> {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    _playwrightAvailable = true;
  } catch {
    _playwrightAvailable = false;
  }
  return _playwrightAvailable;
}

/**
 * Check whether a capture is currently running for the given preview.
 */
export function isCaptureInProgress(previewId: string): boolean {
  return _inProgress.has(previewId);
}

/**
 * Wait for the preview container to be healthy (responds to /api/health).
 */
async function waitForHealth(url: string): Promise<boolean> {
  const healthUrl = `${url}/api/health`;
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL));
  }
  return false;
}

/**
 * Capture screenshots and video for a running preview container.
 *
 * Guarded against concurrent invocations for the same previewId — callers
 * should check `isCaptureInProgress()` first, or handle the thrown error.
 * The entire session is bounded by CAPTURE_TIMEOUT.
 */
export async function capturePreview(
  previewId: string,
  opts?: { routes?: typeof CAPTURE_ROUTES; skipVideo?: boolean },
): Promise<CaptureResult> {
  if (!_deps) throw new Error('Capture engine not initialized');
  const { stmts, broadcast, uploadsDir } = _deps;

  // Defense-in-depth: validate previewId to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(previewId)) {
    throw new Error('Invalid preview ID');
  }

  // Guard: reject concurrent captures for the same preview
  if (_inProgress.has(previewId)) {
    throw new Error('Capture already in progress for this preview');
  }
  _inProgress.add(previewId);

  const row = stmts.getPreviewContainer.get(previewId) as PreviewContainerRow | undefined;
  if (!row) {
    _inProgress.delete(previewId);
    throw new Error('Preview not found');
  }
  if (row.status !== 'running') {
    _inProgress.delete(previewId);
    throw new Error(`Preview is not running (status: ${row.status})`);
  }
  if (!row.url) {
    _inProgress.delete(previewId);
    throw new Error('Preview has no URL');
  }

  const startTime = Date.now();
  const captureDir = path.join(uploadsDir, 'captures', previewId);

  // Clean up previous captures for this preview
  if (existsSync(captureDir)) {
    rmSync(captureDir, { recursive: true, force: true });
  }
  mkdirSync(captureDir, { recursive: true });

  // Also clean previous DB records
  stmts.deletePreviewCaptures.run(previewId);

  const result: CaptureResult = {
    previewId,
    screenshots: [],
    video: null,
    duration_ms: 0,
    error: null,
  };

  // Update status to 'capturing'
  broadcast({
    type: 'preview_update',
    projectId: row.project_id,
    preview: { ...row, capture_status: 'capturing' },
  });

  let browser: Browser | null = null;

  // Enforce overall session timeout
  const sessionTimeout = setTimeout(() => {
    if (browser) {
      browser.close().catch(() => {});
      browser = null;
    }
  }, CAPTURE_TIMEOUT);

  try {
    // 1. Wait for health
    console.log(`[Capture] Waiting for preview ${previewId} to be healthy...`);
    const healthy = await waitForHealth(row.url);
    if (!healthy) {
      throw new Error('Preview health check timed out');
    }
    console.log(`[Capture] Preview is healthy, starting capture...`);

    // 2. Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const routes = opts?.routes ?? CAPTURE_ROUTES;

    // 3. Capture screenshots
    const screenshotContext = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'dark',
    });
    const screenshotPage = await screenshotContext.newPage();

    for (const route of routes) {
      // Check if we've been timed out
      if (!browser) throw new Error('Capture session timed out');

      try {
        const fullUrl = `${row.url}${route.path}`;
        await screenshotPage.goto(fullUrl, {
          waitUntil: 'networkidle',
          timeout: 15_000,
        });
        // Give animations time to settle
        await screenshotPage.waitForTimeout(1000);

        const filename = `screenshot-${route.name}.png`;
        const filePath = path.join(captureDir, filename);

        await screenshotPage.screenshot({
          path: filePath,
          fullPage: false,
        });

        const stats = statSync(filePath);
        const relativePath = `captures/${previewId}/${filename}`;

        // Store in DB
        const captureId = `${previewId}-ss-${route.name}`;
        stmts.createPreviewCapture.run(
          captureId,
          previewId,
          'screenshot',
          route.path,
          route.name,
          route.label,
          filename,
          relativePath,
          stats.size,
        );

        result.screenshots.push({
          route: route.path,
          name: route.name,
          label: route.label,
          filename,
          path: relativePath,
        });

        console.log(`[Capture] Screenshot: ${route.name} (${stats.size} bytes)`);
      } catch (err) {
        console.warn(`[Capture] Failed to capture ${route.name}: ${(err as Error).message}`);
      }
    }

    await screenshotContext.close();

    // 4. Record video walkthrough
    if (!opts?.skipVideo && browser) {
      try {
        const videoDir = path.join(captureDir, 'video-tmp');
        mkdirSync(videoDir, { recursive: true });

        const videoContext = await browser.newContext({
          viewport: VIEWPORT,
          colorScheme: 'dark',
          recordVideo: {
            dir: videoDir,
            size: VIEWPORT,
          },
        });
        const videoPage = await videoContext.newPage();

        // Walk through key routes
        for (const route of routes) {
          try {
            await videoPage.goto(`${row.url}${route.path}`, {
              waitUntil: 'networkidle',
              timeout: 15_000,
            });
            // Pause on each page so viewers can see the content
            await videoPage.waitForTimeout(2000);

            // Scroll down to show more content
            await videoPage.evaluate(() => window.scrollBy(0, 300));
            await videoPage.waitForTimeout(1000);
          } catch {
            // Skip routes that fail to load
          }
        }

        // Get the video path from the page before closing context
        const videoObj = videoPage.video();
        await videoPage.close();
        await videoContext.close();

        // Use Playwright's video() API to get the exact file path
        const srcVideo = videoObj ? await videoObj.path() : null;
        if (srcVideo) {
          const videoFilename = 'walkthrough.webm';
          const destVideo = path.join(captureDir, videoFilename);

          // Move video out of temp dir
          renameSync(srcVideo, destVideo);

          const stats = statSync(destVideo);
          const relativePath = `captures/${previewId}/${videoFilename}`;

          // Store in DB
          const captureId = `${previewId}-video`;
          stmts.createPreviewCapture.run(
            captureId,
            previewId,
            'video',
            null,
            'walkthrough',
            'Video Walkthrough',
            videoFilename,
            relativePath,
            stats.size,
          );

          result.video = {
            filename: videoFilename,
            path: relativePath,
          };

          console.log(`[Capture] Video: ${videoFilename} (${stats.size} bytes)`);
        }

        // Clean up temp dir
        rmSync(videoDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[Capture] Video recording failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    result.error = (err as Error).message;
    console.error(`[Capture] Failed:`, result.error);
  } finally {
    clearTimeout(sessionTimeout);
    _inProgress.delete(previewId);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  result.duration_ms = Date.now() - startTime;

  // Broadcast completion
  broadcast({
    type: 'preview_capture_complete',
    projectId: row.project_id,
    previewId,
    result: {
      screenshotCount: result.screenshots.length,
      hasVideo: !!result.video,
      error: result.error,
      duration_ms: result.duration_ms,
    },
  });

  console.log(
    `[Capture] Complete: ${result.screenshots.length} screenshots, video=${!!result.video}, ${result.duration_ms}ms`,
  );

  return result;
}

/**
 * Get capture artifacts for a preview.
 */
export function getPreviewCaptures(previewId: string): PreviewCaptureRow[] {
  if (!_deps) throw new Error('Capture engine not initialized');
  return _deps.stmts.getPreviewCaptures.all(previewId) as PreviewCaptureRow[];
}

/**
 * Delete all captures for a preview.
 */
export function deletePreviewCaptures(previewId: string): void {
  if (!_deps) throw new Error('Capture engine not initialized');
  const { stmts, uploadsDir } = _deps;

  const captureDir = path.join(uploadsDir, 'captures', previewId);
  if (existsSync(captureDir)) {
    rmSync(captureDir, { recursive: true, force: true });
  }
  stmts.deletePreviewCaptures.run(previewId);
}
