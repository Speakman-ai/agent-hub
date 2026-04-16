/**
 * capture-engine.ts — Lightweight Playwright-based capture system.
 *
 * Replaces the old Docker-based preview-engine.ts.  Agents trigger a capture
 * for a PR; the engine clones the branch, builds, starts a temp server, then
 * uses Playwright to screenshot key routes and record a walkthrough video.
 * Console errors from every page are captured for agent self-validation.
 * Results are posted back to the GitHub PR as a comment.
 *
 * ⚠️  SECURITY — UNTRUSTED CODE EXECUTION
 * --------------------------------------
 * This engine runs `npm ci` and `npm run build` and finally boots a dev server
 * via `tsx index.ts` from the cloned PR branch. That PR code is **attacker-
 * controlled** (anyone with fork access can open a PR). The subprocess we
 * spawn inherits `process.env`, which on the hub includes API keys, the
 * GitHub App private key, and paths to the hub's SQLite DB.
 *
 * Mitigations in place:
 *   • Feature is off by default (`capturesEnabled=false` in config).
 *   • `branch`, `commit_sha`, and `repo_url` are validated against strict
 *     allowlists before being passed to `git` (see validateCaptureInputs).
 *   • The temp clone directory and the child's cwd are isolated under
 *     `os.tmpdir()` and removed on finally.
 *   • The engine is not mounted in front of unauthenticated endpoints — the
 *     REST API is behind the hub's API-key middleware.
 *
 * ⚠️  The hub environment is still exposed to arbitrary PR code once the
 * dev server starts. Operators enabling captures on a hub that also holds
 * secrets must understand this and ideally run captures under a dedicated
 * sandboxed user / container with a scrubbed env.
 */

import { execFile as execFileCb, type ChildProcess, spawn } from 'child_process';
import { createServer as createNetServer } from 'net';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import config from './config.js';
import type { Stmts, PrCaptureRow, PrCaptureArtifactRow, BroadcastFn } from './types.js';

// ─── Constants ──────────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 720 };
const HEALTH_CHECK_TIMEOUT = 90_000;
const BUILD_TIMEOUT = 300_000;
const CAPTURE_TIMEOUT = 120_000;
const HEALTH_POLL_INTERVAL = 3_000;
const VIDEO_PAUSE_MS = 2_000;

// Default routes used for Agent-Hub itself. Projects that aren't the hub
// should override this via config.captureRoutes — otherwise most of these
// paths will 404 and appear as errors.
const DEFAULT_CAPTURE_ROUTES = [
  { path: '/', name: 'home', label: 'Home' },
  { path: '/chat', name: 'chat', label: 'Chat' },
  { path: '/settings', name: 'settings', label: 'Settings' },
  { path: '/board', name: 'board', label: 'Kanban Board' },
  { path: '/wiki', name: 'wiki', label: 'Wiki' },
] as const;

// ─── Input validation ───────────────────────────────────────────
// Defence-in-depth: these validators are the last line before untrusted
// fields are handed to `git clone` / `git checkout`. The webhook handler
// and REST route also validate — but since capture rows can be created
// from multiple entry points we re-check here.
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,255}$/;
const COMMIT_SHA_RE = /^[a-f0-9]{7,64}$/i;
const REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/;

export function validateCaptureInputs(row: {
  branch: string;
  commit_sha: string | null;
  repo_url: string;
}): void {
  if (!BRANCH_RE.test(row.branch)) {
    throw new Error(`Invalid branch name (rejected by safety check): ${row.branch}`);
  }
  if (row.commit_sha && !COMMIT_SHA_RE.test(row.commit_sha)) {
    throw new Error(`Invalid commit sha (rejected by safety check): ${row.commit_sha}`);
  }
  if (!REPO_URL_RE.test(row.repo_url)) {
    throw new Error(`Invalid repo url (rejected by safety check): ${row.repo_url}`);
  }
}

// ─── Return type ────────────────────────────────────────────────

export interface CaptureResult {
  captureId: string;
  status: 'done' | 'error';
  screenshots: Array<{
    route: string;
    name: string;
    label: string;
    filename: string;
    consoleErrors: string[];
  }>;
  video: { filename: string } | null;
  duration_ms: number;
  error: string | null;
  commentUrl: string | null;
}

// ─── Module state ───────────────────────────────────────────────

interface CaptureEngineDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  uploadsDir: string;
}

let _deps: CaptureEngineDeps | null = null;
const _inProgress = new Set<string>();
let _playwrightAvailable: boolean | null = null;

export function initCaptureEngine(deps: CaptureEngineDeps): void {
  _deps = deps;
  console.log('[Capture] Engine initialised');
}

function deps(): CaptureEngineDeps {
  if (!_deps) throw new Error('[Capture] Engine not initialised — call initCaptureEngine first');
  return _deps;
}

// ─── Playwright availability ────────────────────────────────────

export async function isPlaywrightAvailable(): Promise<boolean> {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  try {
    await import('playwright');
    _playwrightAvailable = true;
  } catch {
    _playwrightAvailable = false;
  }
  console.log(`[Capture] Playwright available: ${_playwrightAvailable}`);
  return _playwrightAvailable;
}

export function isCaptureInProgress(captureId: string): boolean {
  return _inProgress.has(captureId);
}

// ─── Helpers ────────────────────────────────────────────────────

function execAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        env: opts.env ?? process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { stdout?: string; stderr?: string };
          e.stdout = stdout;
          e.stderr = stderr;
          return reject(e);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const addr = srv.address() as AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const url = `http://localhost:${port}/api/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms on port ${port}`);
}

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  // Handles https://github.com/owner/repo, https://github.com/owner/repo.git,
  // and git@github.com:owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = repoUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stop a spawned child process gracefully, then forcefully. Resolves when the
 * process has actually exited so the caller can safely rm the cwd. Avoids the
 * fire-and-forget setTimeout race from an earlier version.
 */
function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) return resolve();

    const onExit = (): void => {
      clearTimeout(hardKill);
      resolve();
    };
    proc.once('exit', onExit);
    proc.once('error', onExit);

    try {
      proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }

    const hardKill = setTimeout(() => {
      try {
        if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, 5_000);
  });
}

// ─── Core capture flow ──────────────────────────────────────────

export async function runCapture(captureId: string): Promise<CaptureResult> {
  const { stmts, broadcast, uploadsDir } = deps();

  const row = stmts.getPrCapture.get(captureId) as PrCaptureRow | undefined;
  if (!row) throw new Error(`[Capture] No capture row found for id=${captureId}`);
  if (row.status !== 'queued') {
    throw new Error(
      `[Capture] Capture ${captureId} is in status '${row.status}', expected 'queued'`,
    );
  }

  // Last-line safety net: refuse to exec git on a row that shouldn't have
  // passed earlier validation. If this throws, something upstream is missing
  // a check.
  validateCaptureInputs(row);

  if (_inProgress.has(captureId)) {
    throw new Error(`[Capture] Capture ${captureId} is already in progress`);
  }
  _inProgress.add(captureId);

  const startTime = Date.now();
  let tempDir: string | null = null;
  let serverProcess: ChildProcess | null = null;
  let browser: import('playwright').Browser | null = null;
  let buildLog = '';

  const result: CaptureResult = {
    captureId,
    status: 'error',
    screenshots: [],
    video: null,
    duration_ms: 0,
    error: null,
    commentUrl: null,
  };

  try {
    // ── Build phase ───────────────────────────────────────────────
    stmts.updatePrCaptureStatus.run('building', captureId);
    broadcast({ type: 'capture_status', captureId, projectId: row.project_id, status: 'building' });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-capture-'));
    console.log(`[Capture] ${captureId} — temp dir: ${tempDir}`);

    // Clone. `--` separates flags from positional args so that even if the
    // allowlist were widened later, git still can't interpret branch/repo as
    // an option.
    console.log(`[Capture] ${captureId} — cloning ${row.repo_url} branch ${row.branch}`);
    const cloneResult = await execAsync(
      'git',
      ['clone', '--depth', '1', '--branch', row.branch, '--', row.repo_url, tempDir],
      { timeout: BUILD_TIMEOUT },
    );
    buildLog += `$ git clone --depth 1 --branch ${row.branch}\n${cloneResult.stdout}\n${cloneResult.stderr}\n`;

    // Checkout specific commit if provided. `commit_sha` is hex-only per the
    // validator above — it cannot be a flag — so `--` is not needed (and
    // would turn `git checkout` into a pathspec restore, which is wrong).
    if (row.commit_sha) {
      console.log(`[Capture] ${captureId} — checking out ${row.commit_sha}`);
      const checkoutResult = await execAsync('git', ['checkout', row.commit_sha], {
        cwd: tempDir,
        timeout: 30_000,
      });
      buildLog += `$ git checkout ${row.commit_sha}\n${checkoutResult.stdout}\n${checkoutResult.stderr}\n`;
    }

    // Install root deps
    console.log(`[Capture] ${captureId} — npm ci (root)`);
    const rootInstall = await execAsync('npm', ['ci'], { cwd: tempDir, timeout: BUILD_TIMEOUT });
    buildLog += `$ npm ci (root)\n${rootInstall.stdout}\n${rootInstall.stderr}\n`;
    stmts.updatePrCapture.run('building', null, buildLog, 0, 0, null, null, captureId);

    // Install server deps
    console.log(`[Capture] ${captureId} — npm ci (server)`);
    const serverInstall = await execAsync('npm', ['ci'], {
      cwd: path.join(tempDir, 'server'),
      timeout: BUILD_TIMEOUT,
    });
    buildLog += `$ npm ci (server)\n${serverInstall.stdout}\n${serverInstall.stderr}\n`;
    stmts.updatePrCapture.run('building', null, buildLog, 0, 0, null, null, captureId);

    // Install client deps + build
    console.log(`[Capture] ${captureId} — npm ci + build (client)`);
    const clientInstall = await execAsync('npm', ['ci'], {
      cwd: path.join(tempDir, 'client'),
      timeout: BUILD_TIMEOUT,
    });
    buildLog += `$ npm ci (client)\n${clientInstall.stdout}\n${clientInstall.stderr}\n`;

    const clientBuild = await execAsync('npm', ['run', 'build'], {
      cwd: path.join(tempDir, 'client'),
      timeout: BUILD_TIMEOUT,
    });
    buildLog += `$ npm run build (client)\n${clientBuild.stdout}\n${clientBuild.stderr}\n`;
    stmts.updatePrCapture.run('building', null, buildLog, 0, 0, null, null, captureId);

    // ── Serve phase ─────────────────────────────────────────────
    const port = await findAvailablePort();
    console.log(`[Capture] ${captureId} — starting server on port ${port}`);

    serverProcess = spawn('npx', ['tsx', 'index.ts'], {
      cwd: path.join(tempDir, 'server'),
      env: {
        ...process.env,
        AGENT_HUB_PORT: String(port),
        NODE_ENV: 'production',
        AGENT_HUB_SERVE_CLIENT: path.join(tempDir, 'client', 'dist'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverLog = '';
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      serverLog += chunk.toString();
    });
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      serverLog += chunk.toString();
    });

    try {
      await waitForHealth(port, HEALTH_CHECK_TIMEOUT);
    } catch (healthErr) {
      buildLog += `\n--- Server log ---\n${serverLog}\n`;
      throw new Error(
        `Server failed to become healthy: ${healthErr instanceof Error ? healthErr.message : String(healthErr)}`,
      );
    }

    console.log(`[Capture] ${captureId} — server healthy on port ${port}`);

    // ── Capture phase ───────────────────────────────────────────
    stmts.updatePrCaptureStatus.run('capturing', captureId);
    broadcast({
      type: 'capture_status',
      captureId,
      projectId: row.project_id,
      status: 'capturing',
    });

    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });

    const captureDir = path.join(uploadsDir, 'captures', captureId);
    fs.mkdirSync(captureDir, { recursive: true });

    const baseUrl = `http://localhost:${port}`;

    // Screenshots of each route
    const screenshotContext = await browser.newContext({ viewport: VIEWPORT });
    const screenshotPage = await screenshotContext.newPage();

    for (const route of DEFAULT_CAPTURE_ROUTES) {
      const consoleErrors: string[] = [];

      screenshotPage.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
      screenshotPage.on('pageerror', (err) => {
        consoleErrors.push(err.message);
      });

      const url = `${baseUrl}${route.path}`;
      console.log(`[Capture] ${captureId} — screenshotting ${route.label} (${url})`);

      try {
        await screenshotPage.goto(url, {
          waitUntil: 'networkidle',
          timeout: CAPTURE_TIMEOUT,
        });
      } catch (navErr) {
        consoleErrors.push(
          `Navigation error: ${navErr instanceof Error ? navErr.message : String(navErr)}`,
        );
      }

      const filename = `screenshot-${route.name}.png`;
      const filePath = path.join(captureDir, filename);
      await screenshotPage.screenshot({ path: filePath, fullPage: false });

      const stat = fs.statSync(filePath);
      const artifactId = randomUUID();
      const errorsJson = consoleErrors.length > 0 ? JSON.stringify(consoleErrors) : null;

      stmts.createPrCaptureArtifact.run(
        artifactId,
        captureId,
        'screenshot',
        route.path,
        route.name,
        route.label,
        filename,
        filePath,
        stat.size,
        errorsJson,
      );

      result.screenshots.push({
        route: route.path,
        name: route.name,
        label: route.label,
        filename,
        consoleErrors,
      });

      // Remove listeners to avoid accumulation across routes
      screenshotPage.removeAllListeners('console');
      screenshotPage.removeAllListeners('pageerror');
    }

    await screenshotContext.close();

    // Video walkthrough
    let videoFilename: string | null = null;
    try {
      const videoDir = path.join(captureDir, 'video-tmp');
      fs.mkdirSync(videoDir, { recursive: true });

      const videoContext = await browser.newContext({
        viewport: VIEWPORT,
        recordVideo: { dir: videoDir, size: VIEWPORT },
      });
      const videoPage = await videoContext.newPage();

      for (const route of DEFAULT_CAPTURE_ROUTES) {
        const url = `${baseUrl}${route.path}`;
        try {
          await videoPage.goto(url, { waitUntil: 'networkidle', timeout: CAPTURE_TIMEOUT });
        } catch {
          // Continue recording even if a route fails to load
        }
        await sleep(VIDEO_PAUSE_MS);
      }

      await videoPage.close();
      await videoContext.close();

      // Playwright saves the video in the videoDir — find it
      const videoFiles = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
      if (videoFiles.length > 0) {
        videoFilename = 'walkthrough.webm';
        const videoSrc = path.join(videoDir, videoFiles[0]);
        const videoDst = path.join(captureDir, videoFilename);
        fs.renameSync(videoSrc, videoDst);

        const videoStat = fs.statSync(videoDst);
        const videoArtifactId = randomUUID();

        stmts.createPrCaptureArtifact.run(
          videoArtifactId,
          captureId,
          'video',
          null,
          'walkthrough',
          'Walkthrough Video',
          videoFilename,
          videoDst,
          videoStat.size,
          null,
        );

        result.video = { filename: videoFilename };
      }

      // Clean up temp video dir
      fs.rmSync(videoDir, { recursive: true, force: true });
    } catch (videoErr) {
      console.log(
        `[Capture] ${captureId} — video recording failed: ${videoErr instanceof Error ? videoErr.message : String(videoErr)}`,
      );
      // Non-fatal — screenshots are the primary output
    }

    // ── Finalize ──────────────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    result.status = 'done';
    result.duration_ms = durationMs;

    stmts.updatePrCapture.run(
      'done',
      null,
      buildLog,
      result.screenshots.length,
      result.video ? 1 : 0,
      durationMs,
      null,
      captureId,
    );

    broadcast({
      type: 'capture_complete',
      projectId: row.project_id,
      captureId,
      result: {
        screenshotCount: result.screenshots.length,
        hasVideo: result.video !== null,
        error: null,
        duration_ms: durationMs,
      },
    });

    console.log(
      `[Capture] ${captureId} — done (${result.screenshots.length} screenshots, video=${result.video !== null}, ${durationMs}ms)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Capture] ${captureId} — error: ${message}`);

    result.status = 'error';
    result.error = message;
    result.duration_ms = Date.now() - startTime;

    stmts.updatePrCapture.run(
      'error',
      message,
      buildLog,
      result.screenshots.length,
      result.video ? 1 : 0,
      result.duration_ms,
      null,
      captureId,
    );

    broadcast({
      type: 'capture_complete',
      projectId: row.project_id,
      captureId,
      result: {
        screenshotCount: result.screenshots.length,
        hasVideo: false,
        error: message,
        duration_ms: result.duration_ms,
      },
    });
  } finally {
    // Close browser first so its handles on the server are released, then
    // wait for the server to actually exit before removing the temp dir.
    // Otherwise rmSync races with node still holding its DB/file handles.
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore
      }
    }

    if (serverProcess && !serverProcess.killed) {
      await stopServer(serverProcess);
    }

    // Remove temp dir
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`[Capture] ${captureId} — cleaned up temp dir`);
      } catch (cleanupErr) {
        console.warn(
          `[Capture] ${captureId} — failed to clean temp dir: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
    }

    _inProgress.delete(captureId);
  }

  return result;
}

// ─── Query helpers ──────────────────────────────────────────────

export function getCaptureArtifacts(captureId: string): PrCaptureArtifactRow[] {
  const { stmts } = deps();
  return stmts.getPrCaptureArtifacts.all(captureId) as PrCaptureArtifactRow[];
}

export function deleteCaptureArtifacts(captureId: string): void {
  const { stmts, uploadsDir } = deps();

  // Remove files from disk
  const captureDir = path.join(uploadsDir, 'captures', captureId);
  if (fs.existsSync(captureDir)) {
    fs.rmSync(captureDir, { recursive: true, force: true });
    console.log(`[Capture] ${captureId} — deleted artifact directory`);
  }

  // Remove DB rows
  stmts.deletePrCaptureArtifacts.run(captureId);
  console.log(`[Capture] ${captureId} — deleted artifact rows from DB`);
}

// ─── Post PR comment ────────────────────────────────────────────

export async function postPrComment(captureId: string): Promise<string | null> {
  const { stmts } = deps();

  const row = stmts.getPrCapture.get(captureId) as PrCaptureRow | undefined;
  if (!row) {
    console.error(`[Capture] postPrComment: no capture row for ${captureId}`);
    return null;
  }

  const token = config.botGithubToken;
  if (!token) {
    console.warn('[Capture] postPrComment: no botGithubToken configured, skipping');
    return null;
  }

  const parsed = parseOwnerRepo(row.repo_url);
  if (!parsed) {
    console.error(`[Capture] postPrComment: could not parse owner/repo from ${row.repo_url}`);
    return null;
  }

  const artifacts = stmts.getPrCaptureArtifacts.all(captureId) as PrCaptureArtifactRow[];
  const screenshots = artifacts.filter((a) => a.type === 'screenshot');
  const videos = artifacts.filter((a) => a.type === 'video');

  // Build comment body
  const lines: string[] = [];
  lines.push(`## \u{1f4f8} PR Capture — Branch: \`${row.branch}\``);
  lines.push('');

  if (row.status === 'error') {
    lines.push(`> **Error:** ${row.error_message || 'Unknown error'}`);
    lines.push('');
  }

  const publicUrl = config.publicUrl;

  if (screenshots.length > 0) {
    lines.push(`**${screenshots.length} screenshot(s) captured**`);
    lines.push('');

    for (const ss of screenshots) {
      lines.push(`### ${ss.label}`);

      if (publicUrl) {
        const imgUrl = `${publicUrl}/uploads/captures/${captureId}/${ss.filename}`;
        lines.push(`![${ss.name}](${imgUrl})`);
      } else {
        lines.push(`\`${ss.filename}\` (${Math.round(ss.file_size / 1024)}KB)`);
      }

      // Console errors — the self-validation part
      if (ss.console_errors) {
        let errors: string[];
        try {
          errors = JSON.parse(ss.console_errors) as string[];
        } catch {
          errors = [ss.console_errors];
        }
        if (errors.length > 0) {
          lines.push('');
          lines.push(`> \u{26a0}\u{fe0f} **Console errors on ${ss.label}:**`);
          for (const err of errors) {
            lines.push(`> - \`${err.slice(0, 200)}\``);
          }
        }
      }

      lines.push('');
    }
  } else {
    lines.push('No screenshots were captured.');
    lines.push('');
  }

  if (videos.length > 0) {
    const video = videos[0];
    if (publicUrl) {
      const videoUrl = `${publicUrl}/uploads/captures/${captureId}/${video.filename}`;
      lines.push(`**Walkthrough video:** [${video.filename}](${videoUrl})`);
    } else {
      lines.push(
        `**Walkthrough video:** \`${video.filename}\` (${Math.round(video.file_size / 1024)}KB)`,
      );
    }
    lines.push('');
  }

  // Summary
  if (row.duration_ms) {
    lines.push(`---`);
    lines.push(`*Captured in ${Math.round(row.duration_ms / 1000)}s*`);
  }

  const body = lines.join('\n');
  const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${row.pr_number}/comments`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Capture] postPrComment: GitHub API returned ${response.status}: ${errText}`);
      return null;
    }

    const data = (await response.json()) as { html_url?: string };
    const commentUrl = data.html_url || null;

    if (commentUrl) {
      // Update the capture row with the comment URL
      stmts.updatePrCapture.run(
        row.status,
        row.error_message,
        row.build_log,
        row.screenshot_count,
        row.has_video ? 1 : 0,
        row.duration_ms,
        commentUrl,
        captureId,
      );
      console.log(`[Capture] ${captureId} — posted PR comment: ${commentUrl}`);
    }

    return commentUrl;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Capture] postPrComment: failed to post comment: ${message}`);
    return null;
  }
}
