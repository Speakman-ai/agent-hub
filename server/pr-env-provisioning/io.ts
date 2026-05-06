/**
 * Provisioning IO — the single seam between adapter logic and the
 * outside world (filesystem, subprocess, fetch, AWS SDK clients).
 *
 * Every real adapter takes a `ProvisionIO` so unit tests can inject
 * deterministic doubles and exercise branch coverage without spawning
 * real `certbot`, hitting IMDS, or mutating `<dataDir>/config.json`.
 *
 * The defaults exported as `defaultProvisionIO` are the production
 * wiring — `fs/promises`, `child_process.spawn`, `globalThis.fetch`,
 * and the official `@aws-sdk/*` clients constructed lazily.
 */

import { spawn } from 'child_process';
import { access, readFile, readdir, writeFile, rename, mkdir, stat } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import type { Mode } from 'fs';

/** Result of a one-shot subprocess run, with stdout/stderr buffered. */
export interface SpawnResult {
  /** Process exit code. -1 when the process failed to spawn. */
  code: number;
  /** Captured stdout (may be empty). */
  stdout: string;
  /** Captured stderr (may be empty). */
  stderr: string;
}

export interface SpawnOptions {
  /** Override env. Production: inherit `process.env` when unset. */
  env?: Record<string, string | undefined>;
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Optional per-line stdout sink. Adapters use this to forward certbot /
   * AWS CLI output into the orchestrator's `log` stream.
   */
  onStdoutLine?: (line: string) => void;
  /** Optional per-line stderr sink. Same shape as `onStdoutLine`. */
  onStderrLine?: (line: string) => void;
}

/**
 * Filesystem operations the adapters use. Intentionally narrow — every
 * call here goes through the IO surface so tests don't have to monkey-
 * patch global `fs/promises`.
 */
export interface FsIO {
  exists(p: string): Promise<boolean>;
  readFile(p: string, encoding?: BufferEncoding): Promise<string>;
  readdir(p: string): Promise<string[]>;
  /** Atomic-ish: writes to `<p>.tmp.<rand>` and renames over `p`. */
  writeFileAtomic(p: string, body: string, mode?: Mode): Promise<void>;
  mkdirp(p: string): Promise<void>;
  /** True when `path` exists and is a directory writable by the process. */
  isWritableDir(p: string): Promise<boolean>;
}

export interface ProvisionIO {
  fs: FsIO;
  spawn(command: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult>;
  /** Generic HTTP fetch, used for IMDSv2. */
  fetch: typeof globalThis.fetch;
}

// ─── Production defaults ───────────────────────────────────────────────────

async function fsExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fsIsWritableDir(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    if (!st.isDirectory()) return false;
    await access(p, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function fsWriteFileAtomic(p: string, body: string, mode?: Mode): Promise<void> {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, mode !== undefined ? { mode } : undefined);
  await rename(tmp, p);
}

async function fsReadFile(p: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
  return await readFile(p, encoding);
}

async function fsReaddir(p: string): Promise<string[]> {
  return await readdir(p);
}

async function fsMkdirp(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export const defaultFsIO: FsIO = {
  exists: fsExists,
  readFile: fsReadFile,
  readdir: fsReaddir,
  writeFileAtomic: fsWriteFileAtomic,
  mkdirp: fsMkdirp,
  isWritableDir: fsIsWritableDir,
};

/**
 * Production spawn — buffers stdout/stderr fully, with optional per-line
 * callbacks for streaming. The `code: -1` shape mirrors the existing
 * `spawnOnce` helper in `pr-env-settings.ts` (failed-to-spawn = -1) so
 * adapters can keep one error contract.
 */
export function defaultSpawn(
  command: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutTail = '';
    let stderrTail = '';
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env as NodeJS.ProcessEnv | undefined,
      cwd: opts.cwd,
    });
    const drain = (chunk: string, isErr: boolean): void => {
      if (isErr) stderrBuf += chunk;
      else stdoutBuf += chunk;
      const sink = isErr ? opts.onStderrLine : opts.onStdoutLine;
      if (!sink) return;
      const tail = isErr ? stderrTail + chunk : stdoutTail + chunk;
      const lines = tail.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      if (isErr) stderrTail = remainder;
      else stdoutTail = remainder;
      for (const line of lines) sink(line);
    };
    proc.stdout?.on('data', (b) => drain(String(b), false));
    proc.stderr?.on('data', (b) => drain(String(b), true));
    proc.on('error', (err) => {
      resolve({ code: -1, stdout: stdoutBuf, stderr: stderrBuf || err.message });
    });
    proc.on('close', (code) => {
      // Flush any trailing fragment (no newline at EOF).
      if (stdoutTail && opts.onStdoutLine) opts.onStdoutLine(stdoutTail);
      if (stderrTail && opts.onStderrLine) opts.onStderrLine(stderrTail);
      resolve({ code: code ?? -1, stdout: stdoutBuf, stderr: stderrBuf });
    });
  });
}

export const defaultProvisionIO: ProvisionIO = {
  fs: defaultFsIO,
  spawn: defaultSpawn,
  fetch: globalThis.fetch.bind(globalThis),
};
