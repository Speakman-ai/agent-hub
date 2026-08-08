/**
 * Sysbox capability probe + SessionEnv adapter selection.
 *
 * Per-session dev environments run behind a `SessionEnv` boundary with three
 * backends: HOST (direct host processes — the local-dev/Mac path), SYSBOX
 * (per-session container via sysbox-runc, the strongest boundary), and
 * CONTAINER (per-session privileged DinD container, the boundary available on
 * any Docker host). This module decides which backend the Hub uses at boot:
 *
 *   1. `probeSysboxCapability()` checks the host: Linux, kernel >= 5.12
 *      (idmapped-mounts baseline for non-shiftfs distros; >= 5.19 removes the
 *      shiftfs dependency entirely), unprivileged user namespaces enabled,
 *      the `sysbox-runc` binary installed, and the runtime registered with
 *      the Docker daemon.
 *   2. `selectSessionEnvAdapter()` maps the probes + the `sessionEnvAdapter`
 *      config (`auto` | `host` | `sysbox` | `container`) to a selection.
 *      `auto` walks the backends strongest-first: sysbox, then container,
 *      then host. A forced backend the probe rejects falls back to host with
 *      a loud warning rather than producing a runtime that cannot spawn.
 *
 * Ordering matters because falling through to `host` means sessions have no
 * boundary at all — they share the Hub's filesystem, ports, and process
 * table. That used to be the outcome on every machine without sysbox, which
 * is most of them. The container backend exists so the fallback is a weaker
 * boundary rather than none.
 *
 * Host install doc + script: docs/deployment/SYSBOX-HOST-SETUP.md and
 * ops/scripts/setup-sysbox-host.sh.
 */
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import os from 'os';
import type { SessionEnvPortRouting } from './container-routing.js';

export type SessionEnvAdapterKind = 'host' | 'sysbox' | 'container' | 'firecracker';
/** Operator intent: `auto` probes, the rest force a backend. */
export type SessionEnvAdapterMode = 'auto' | 'host' | 'sysbox' | 'container' | 'firecracker';

export const SESSION_ENV_ADAPTER_MODES: readonly SessionEnvAdapterMode[] = [
  'auto',
  'host',
  'sysbox',
  'container',
  'firecracker',
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

/**
 * What the `container` backend needs: a docker daemon, and a route from the
 * Hub to container IPs. Without the latter a container env has to publish
 * ports, which drags back the shared host pool and the declare-before-start
 * rule — so `auto` skips it and only an explicit request honors it.
 */
export interface ContainerCapability {
  dockerAvailable: boolean;
  routing: SessionEnvPortRouting;
  /** Human-readable detail for the boot log when the backend is skipped. */
  detail?: string;
}

/**
 * What the `firecracker` backend needs, as reported by
 * `firecracker/firecracker-capability.ts`: KVM, the VMM binary, and staged
 * guest artifacts.
 */
export interface FirecrackerCapabilitySummary {
  available: boolean;
  /** Why it is unavailable, for the boot log. Empty when available. */
  reason: string;
}

export function selectSessionEnvAdapter(
  mode: SessionEnvAdapterMode,
  probe: SysboxProbeResult,
  container: ContainerCapability = { dockerAvailable: false, routing: 'published-ports' },
  firecracker: FirecrackerCapabilitySummary = { available: false, reason: 'not probed' },
): SessionEnvSelection {
  const containerUsable = container.dockerAvailable && container.routing === 'container-ip';
  const containerDetail =
    container.detail ??
    (!container.dockerAvailable
      ? 'no usable docker daemon'
      : 'container IPs are not routable from the Hub');

  if (mode === 'firecracker') {
    if (firecracker.available) {
      return {
        adapter: 'firecracker',
        mode,
        forced: true,
        fellBack: false,
        reason: 'forced by config (sessionEnvAdapter=firecracker); probe passed',
        probe,
      };
    }
    // Same principle as a forced sysbox: the operator asked for isolation, so
    // degrade to the next-strongest boundary rather than all the way to host.
    if (probe.available) {
      return {
        adapter: 'sysbox',
        mode,
        forced: false,
        fellBack: true,
        reason: `microVM backend forced by config but unavailable — using sysbox instead: ${firecracker.reason}`,
        probe,
      };
    }
    if (containerUsable) {
      return {
        adapter: 'container',
        mode,
        forced: false,
        fellBack: true,
        reason: `microVM backend forced by config but unavailable — using the container backend instead: ${firecracker.reason}`,
        probe,
      };
    }
    return {
      adapter: 'host',
      mode,
      forced: false,
      fellBack: true,
      reason: `microVM backend forced by config but unavailable — falling back to host adapter: ${firecracker.reason}`,
      probe,
    };
  }

  if (mode === 'container') {
    if (container.dockerAvailable) {
      return {
        adapter: 'container',
        mode,
        forced: true,
        fellBack: false,
        reason: 'forced by config (sessionEnvAdapter=container)',
        probe,
      };
    }
    return {
      adapter: 'host',
      mode,
      forced: false,
      fellBack: true,
      reason: `container backend forced by config but unavailable — falling back to host adapter: ${containerDetail}`,
      probe,
    };
  }
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
    // A forced sysbox that the probe rejects prefers the container backend
    // over host: the operator asked for isolation, so a weaker boundary is
    // closer to the intent than no boundary.
    if (containerUsable) {
      return {
        adapter: 'container',
        mode,
        forced: false,
        fellBack: true,
        reason: `sysbox forced by config but unavailable — using the container backend instead: ${probe.missing.join('; ')}`,
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
  // `auto`, strongest boundary first. A microVM leads because it is the only
  // tier where the session gets its own kernel rather than a namespaced view
  // of the host's.
  if (firecracker.available) {
    return {
      adapter: 'firecracker',
      mode,
      forced: false,
      fellBack: false,
      reason: 'microVM backend available (auto)',
      probe,
    };
  }
  if (probe.available) {
    return {
      adapter: 'sysbox',
      mode,
      forced: false,
      fellBack: false,
      reason: `sysbox available (auto); microVM backend skipped: ${firecracker.reason}`,
      probe,
    };
  }
  if (containerUsable) {
    return {
      adapter: 'container',
      mode,
      forced: false,
      fellBack: false,
      reason: `sysbox unavailable (auto) — using the container backend: ${probe.missing.join('; ')}`,
      probe,
    };
  }
  return {
    adapter: 'host',
    mode,
    forced: false,
    fellBack: false,
    reason: `sysbox unavailable (${probe.missing.join('; ')}) and container backend unusable (${containerDetail}) — using host adapter`,
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
  container?: ContainerCapability,
  firecracker?: FirecrackerCapabilitySummary,
): Promise<SessionEnvSelection> {
  const probe = await probeSysboxCapability(deps);
  cachedSelection = selectSessionEnvAdapter(mode, probe, container, firecracker);
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
