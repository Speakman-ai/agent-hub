/**
 * Sysbox capability probe + SessionEnv adapter selection.
 *
 * Per-session dev environments run behind a `SessionEnv` boundary with two
 * backends: the HOST adapter (direct host processes — the local-dev/Mac path)
 * and the SYSBOX adapter (per-session rootless container via sysbox-runc —
 * the default boundary on a self-hosted Linux server). This module decides
 * which backend the Hub uses at boot:
 *
 *   1. `probeSysboxCapability()` checks the host: Linux, kernel >= 5.12
 *      (idmapped-mounts baseline for non-shiftfs distros; >= 5.19 removes the
 *      shiftfs dependency entirely), unprivileged user namespaces enabled,
 *      the `sysbox-runc` binary installed, and the runtime registered with
 *      the Docker daemon.
 *   2. `selectSessionEnvAdapter()` maps the probe + the `sessionEnvAdapter`
 *      config (`auto` | `host` | `sysbox`) to a selection. `auto` picks
 *      sysbox when available, else host. A forced `sysbox` that the probe
 *      rejects falls back to host with a loud warning rather than producing
 *      a runtime that cannot spawn.
 *
 * Host install doc + script: docs/deployment/SYSBOX-HOST-SETUP.md and
 * ops/scripts/setup-sysbox-host.sh.
 */
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import os from 'os';

export type SessionEnvAdapterKind = 'host' | 'sysbox';
/** Operator intent: `auto` probes, `host`/`sysbox` force a backend. */
export type SessionEnvAdapterMode = 'auto' | 'host' | 'sysbox';

export const SESSION_ENV_ADAPTER_MODES: readonly SessionEnvAdapterMode[] = [
  'auto',
  'host',
  'sysbox',
];

export function coerceSessionEnvAdapterMode(raw: unknown): SessionEnvAdapterMode {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  return (SESSION_ENV_ADAPTER_MODES as readonly string[]).includes(v)
    ? (v as SessionEnvAdapterMode)
    : 'auto';
}

/** Non-shiftfs distros (incl. Amazon Linux 2023) need idmapped mounts. */
export const SYSBOX_MIN_KERNEL = { major: 5, minor: 12 } as const;
/** At or above this, sysbox needs neither shiftfs nor any distro patches. */
export const SYSBOX_PREFERRED_KERNEL = { major: 5, minor: 19 } as const;

export interface SysboxCheck {
  name: 'platform' | 'kernel' | 'userns' | 'binary' | 'docker-runtime';
  ok: boolean;
  detail: string;
}

export interface SysboxProbeResult {
  available: boolean;
  checks: SysboxCheck[];
  /** Human-readable failure details, one per failing check. */
  missing: string[];
}

export interface SessionEnvSelection {
  adapter: SessionEnvAdapterKind;
  mode: SessionEnvAdapterMode;
  /** True when the mode forced the adapter regardless of the probe. */
  forced: boolean;
  /** True when a forced/auto sysbox preference degraded to host. */
  fellBack: boolean;
  reason: string;
  probe: SysboxProbeResult;
}

export interface SysboxProbeDeps {
  platform: NodeJS.Platform;
  /** `os.release()` — e.g. "6.1.134-150.224.amzn2023.x86_64". */
  kernelRelease: () => string;
  readTextFile: (path: string) => Promise<string>;
  /** Run a command; must resolve (never reject) with ok=false on any failure. */
  run: (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;
}

const EXEC_TIMEOUT_MS = 10_000;

function defaultRun(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? '') });
    });
  });
}

export function defaultSysboxProbeDeps(): SysboxProbeDeps {
  return {
    platform: process.platform,
    kernelRelease: () => os.release(),
    readTextFile: (p) => readFile(p, 'utf8'),
    run: defaultRun,
  };
}

/** Parse "6.1.134-150.224.amzn2023.x86_64" / "5.15.0-91-generic" → {6,1}. */
export function parseKernelRelease(release: string): { major: number; minor: number } | null {
  const m = /^(\d+)\.(\d+)/.exec(release.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function kernelAtLeast(
  v: { major: number; minor: number },
  min: { major: number; minor: number },
): boolean {
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor);
}

const USERNS_SYSCTL_PATH = '/proc/sys/user/max_user_namespaces';

export async function probeSysboxCapability(
  deps: SysboxProbeDeps = defaultSysboxProbeDeps(),
): Promise<SysboxProbeResult> {
  const checks: SysboxCheck[] = [];

  const isLinux = deps.platform === 'linux';
  checks.push({
    name: 'platform',
    ok: isLinux,
    detail: isLinux ? 'linux' : `sysbox requires Linux (platform=${deps.platform})`,
  });

  if (!isLinux) {
    // Nothing else is meaningful off-Linux; report the one hard failure.
    return finalize(checks);
  }

  const release = deps.kernelRelease();
  const kernel = parseKernelRelease(release);
  if (!kernel) {
    checks.push({ name: 'kernel', ok: false, detail: `unparseable kernel release "${release}"` });
  } else if (!kernelAtLeast(kernel, SYSBOX_MIN_KERNEL)) {
    checks.push({
      name: 'kernel',
      ok: false,
      detail: `kernel ${kernel.major}.${kernel.minor} < ${SYSBOX_MIN_KERNEL.major}.${SYSBOX_MIN_KERNEL.minor} (idmapped-mounts baseline; "${release}")`,
    });
  } else {
    const note = kernelAtLeast(kernel, SYSBOX_PREFERRED_KERNEL)
      ? ''
      : ` (>= ${SYSBOX_PREFERRED_KERNEL.major}.${SYSBOX_PREFERRED_KERNEL.minor} recommended)`;
    checks.push({
      name: 'kernel',
      ok: true,
      detail: `kernel ${kernel.major}.${kernel.minor}${note}`,
    });
  }

  let usernsDetail: string;
  let usernsOk = false;
  try {
    const raw = (await deps.readTextFile(USERNS_SYSCTL_PATH)).trim();
    const max = Number.parseInt(raw, 10);
    usernsOk = Number.isFinite(max) && max > 0;
    usernsDetail = usernsOk
      ? `max_user_namespaces=${max}`
      : `user namespaces disabled (${USERNS_SYSCTL_PATH}=${raw})`;
  } catch {
    usernsDetail = `cannot read ${USERNS_SYSCTL_PATH} (user namespaces unavailable?)`;
  }
  checks.push({ name: 'userns', ok: usernsOk, detail: usernsDetail });

  const bin = await deps.run('sysbox-runc', ['--version']);
  checks.push({
    name: 'binary',
    ok: bin.ok,
    detail: bin.ok
      ? (bin.stdout.split('\n')[0]?.trim() ?? 'sysbox-runc present')
      : 'sysbox-runc not found on PATH (run ops/scripts/setup-sysbox-host.sh)',
  });

  const info = await deps.run('docker', ['info', '--format', '{{json .Runtimes}}']);
  let runtimeOk = false;
  let runtimeDetail: string;
  if (!info.ok) {
    runtimeDetail = 'docker info failed (daemon unreachable?)';
  } else {
    try {
      const runtimes = JSON.parse(info.stdout.trim() || '{}') as Record<string, unknown>;
      runtimeOk = Object.prototype.hasOwnProperty.call(runtimes, 'sysbox-runc');
      runtimeDetail = runtimeOk
        ? 'docker runtime "sysbox-runc" registered'
        : `docker daemon has no "sysbox-runc" runtime (found: ${Object.keys(runtimes).join(', ') || 'none'})`;
    } catch {
      runtimeDetail = 'could not parse docker runtimes output';
    }
  }
  checks.push({ name: 'docker-runtime', ok: runtimeOk, detail: runtimeDetail });

  return finalize(checks);
}

function finalize(checks: SysboxCheck[]): SysboxProbeResult {
  const missing = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return { available: missing.length === 0, checks, missing };
}

export function selectSessionEnvAdapter(
  mode: SessionEnvAdapterMode,
  probe: SysboxProbeResult,
): SessionEnvSelection {
  if (mode === 'host') {
    return {
      adapter: 'host',
      mode,
      forced: true,
      fellBack: false,
      reason: 'forced by config (sessionEnvAdapter=host)',
      probe,
    };
  }
  if (mode === 'sysbox') {
    if (probe.available) {
      return {
        adapter: 'sysbox',
        mode,
        forced: true,
        fellBack: false,
        reason: 'forced by config (sessionEnvAdapter=sysbox); probe passed',
        probe,
      };
    }
    return {
      adapter: 'host',
      mode,
      forced: false,
      fellBack: true,
      reason: `sysbox forced by config but unavailable — falling back to host adapter: ${probe.missing.join('; ')}`,
      probe,
    };
  }
  if (probe.available) {
    return {
      adapter: 'sysbox',
      mode,
      forced: false,
      fellBack: false,
      reason: 'sysbox available (auto)',
      probe,
    };
  }
  return {
    adapter: 'host',
    mode,
    forced: false,
    fellBack: false,
    reason: `sysbox unavailable (auto) — using host adapter: ${probe.missing.join('; ')}`,
    probe,
  };
}

export interface SessionEnvLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * One boot log line stating the selected adapter. Warns when a Linux host
 * degraded to the host adapter (missing isolation boundary on a server) or
 * when a forced sysbox could not be honored; plain info otherwise (host
 * adapter on Mac/Windows is the expected local-dev path).
 */
export function logSessionEnvSelection(
  selection: SessionEnvSelection,
  logger: SessionEnvLogger = console,
  platform: NodeJS.Platform = process.platform,
): void {
  const line = `[session-env] adapter=${selection.adapter} (mode=${selection.mode}) — ${selection.reason}`;
  const degradedOnLinux =
    platform === 'linux' && selection.adapter === 'host' && selection.mode !== 'host';
  if (selection.fellBack || degradedOnLinux) {
    logger.warn(line);
  } else {
    logger.log(line);
  }
}

let cachedSelection: SessionEnvSelection | null = null;

/** Probe the host and cache the adapter selection. Called once at boot. */
export async function initSessionEnvSelection(
  mode: SessionEnvAdapterMode,
  deps?: SysboxProbeDeps,
): Promise<SessionEnvSelection> {
  const probe = await probeSysboxCapability(deps);
  cachedSelection = selectSessionEnvAdapter(mode, probe);
  return cachedSelection;
}

/**
 * The boot-time selection. Before `initSessionEnvSelection` resolves (or in
 * tests that never run it) this reports the safe host default so callers
 * never observe a sysbox selection the probe did not confirm.
 */
export function getSessionEnvSelection(): SessionEnvSelection {
  return (
    cachedSelection ?? {
      adapter: 'host',
      mode: 'auto',
      forced: false,
      fellBack: false,
      reason: 'capability probe has not run — defaulting to host adapter',
      probe: { available: false, checks: [], missing: ['probe not run'] },
    }
  );
}

/** Test-only: clear the cached boot selection. */
export function resetSessionEnvSelectionForTest(): void {
  cachedSelection = null;
}
