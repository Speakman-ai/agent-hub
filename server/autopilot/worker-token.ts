/**
 * Persist Autopilot worker tokens and session→run bindings under dataDir so
 * the shared chat spawn path can inject the scoped worker credential without
 * holding plaintext in SQLite. Pattern matches spawn-creds-file.ts (0600
 * files, 0700 dir, atomic rename).
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';

const TOKEN_SUBDIR = 'autopilot-workers';
const SESSION_SUBDIR = 'autopilot-sessions';
const ID_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;

function assertSafeId(id: string, label: string): void {
  if (!ID_REGEX.test(id)) {
    throw new Error(`autopilot-worker-token: invalid ${label} ${JSON.stringify(id)}`);
  }
}

function atomicWrite(filePath: string, dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600, encoding: 'utf8' });
  renameSync(tmp, filePath);
}

function readOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function removeIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function autopilotWorkerTokenPath(runId: string, dataDir: string): string {
  assertSafeId(runId, 'runId');
  return path.join(dataDir, TOKEN_SUBDIR, `${runId}.token`);
}

export function writeAutopilotWorkerToken(runId: string, token: string, dataDir: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('autopilot-worker-token: token must be a non-empty string');
  }
  const dir = path.join(dataDir, TOKEN_SUBDIR);
  const filePath = autopilotWorkerTokenPath(runId, dataDir);
  atomicWrite(filePath, dir, token);
  return filePath;
}

export function readAutopilotWorkerToken(runId: string, dataDir: string): string | null {
  return readOrNull(autopilotWorkerTokenPath(runId, dataDir));
}

export function removeAutopilotWorkerToken(runId: string, dataDir: string): void {
  removeIfPresent(autopilotWorkerTokenPath(runId, dataDir));
}

export interface AutopilotSessionWorkerBinding {
  projectId: string;
  runId: string;
}

export function autopilotSessionBindingPath(sessionId: string, dataDir: string): string {
  assertSafeId(sessionId, 'sessionId');
  return path.join(dataDir, SESSION_SUBDIR, `${sessionId}.json`);
}

export function bindAutopilotWorkerSession(
  sessionId: string,
  binding: AutopilotSessionWorkerBinding,
  dataDir: string,
): string {
  if (!binding.projectId?.trim() || !binding.runId?.trim()) {
    throw new Error('autopilot-worker-token: projectId and runId are required');
  }
  const dir = path.join(dataDir, SESSION_SUBDIR);
  const filePath = autopilotSessionBindingPath(sessionId, dataDir);
  atomicWrite(
    filePath,
    dir,
    JSON.stringify({ projectId: binding.projectId, runId: binding.runId }),
  );
  return filePath;
}

/**
 * Read a session→run binding.
 * Returns null only when the binding file is absent (ordinary session).
 * An existing empty, malformed, or incomplete file is a bound worker with
 * a broken identity and throws {@link AutopilotWorkerCredentialError}.
 */
export function readAutopilotSessionBinding(
  sessionId: string,
  dataDir: string,
): AutopilotSessionWorkerBinding | null {
  const filePath = autopilotSessionBindingPath(sessionId, dataDir);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = parseBindingOrThrow(sessionId, raw);
  return { projectId: parsed.projectId, runId: parsed.runId };
}

function parseBindingOrThrow(sessionId: string, raw: string): AutopilotSessionWorkerBinding {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AutopilotWorkerCredentialError(sessionId, {});
  }
  let parsed: Partial<AutopilotSessionWorkerBinding>;
  try {
    parsed = JSON.parse(trimmed) as Partial<AutopilotSessionWorkerBinding>;
  } catch {
    throw new AutopilotWorkerCredentialError(sessionId, {});
  }
  const projectId = typeof parsed.projectId === 'string' ? parsed.projectId.trim() : '';
  const runId = typeof parsed.runId === 'string' ? parsed.runId.trim() : '';
  if (!projectId || !runId) {
    throw new AutopilotWorkerCredentialError(sessionId, { projectId, runId });
  }
  return { projectId, runId };
}

export function unbindAutopilotWorkerSession(sessionId: string, dataDir: string): void {
  removeIfPresent(autopilotSessionBindingPath(sessionId, dataDir));
}

/**
 * Thrown when a session is bound to an Autopilot run but the worker token is
 * gone (revoked, never minted, or unreadable), or the binding file exists but
 * is empty, malformed, or incomplete. Callers must refuse to spawn rather than
 * fall through to the Hub break-glass key.
 */
export class AutopilotWorkerCredentialError extends Error {
  readonly sessionId: string;
  readonly runId: string;
  readonly projectId: string;
  constructor(sessionId: string, binding: Partial<AutopilotSessionWorkerBinding> = {}) {
    const runId = binding.runId?.trim() || 'unknown';
    const projectId = binding.projectId?.trim() || 'unknown';
    super(
      `Autopilot worker credential for run ${runId} is unavailable; refusing to spawn session ${sessionId} with the Hub break-glass key`,
    );
    this.name = 'AutopilotWorkerCredentialError';
    this.sessionId = sessionId;
    this.runId = runId;
    this.projectId = projectId;
  }
}

/**
 * Resolve the scoped worker spawn identity for a session.
 * Returns null for ordinary (unbound) sessions. Throws
 * {@link AutopilotWorkerCredentialError} when the session is bound to a run
 * whose token is missing, so spawn cannot silently elevate to break-glass.
 */
export function resolveAutopilotWorkerSpawn(
  sessionId: string,
  dataDir: string,
): { token: string; projectId: string; runId: string } | null {
  const binding = readAutopilotSessionBinding(sessionId, dataDir);
  if (!binding) return null;
  const token = readAutopilotWorkerToken(binding.runId, dataDir);
  if (!token) throw new AutopilotWorkerCredentialError(sessionId, binding);
  return { token, projectId: binding.projectId, runId: binding.runId };
}
