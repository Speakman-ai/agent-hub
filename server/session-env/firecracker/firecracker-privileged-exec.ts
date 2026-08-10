/**
 * How the Hub reaches the privileged operations a microVM needs.
 *
 * Booting a VM requires three things an ordinary process inside a container
 * cannot do: create a tap device in the *host* network namespace, loop-mount
 * disk images, and open `/dev/kvm`. Agent Hub normally ships as an
 * unprivileged container that talks to the host Docker daemon, so rather than
 * hand those capabilities to the process that also runs every agent session,
 * the privileged steps execute in short-lived helper containers launched
 * through the Docker socket the Hub already holds.
 *
 * A Hub installed directly on a host skips the indirection: `local` mode runs
 * the same argv under `sudo -n`, which is exactly what the sudoers rule
 * written by `ops/scripts/setup-firecracker-host.sh` permits.
 *
 * Both modes execute the *same* argv — only the wrapper differs — which is
 * why nothing in the VM lifecycle branches on deployment shape.
 *
 * ## The identity-mount rule
 *
 * Helper containers bind-mount host paths at the *same* path inside the
 * container. That is not cosmetic. The argv the Hub builds embeds host paths
 * (`--config-file /var/lib/.../vm-config.json`), and the VMM creates a vsock
 * socket the Hub later dials by that same absolute path. Remapping any of
 * them would mean two different names for one file and a control channel that
 * connects to nothing.
 */

import { execFile, execFileSync, spawn as nodeSpawn } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import type { FirecrackerCapabilityProbeDeps } from './firecracker-capability.js';
import {
  defaultFirecrackerHostIo,
  type FirecrackerHostIo,
  type FirecrackerPaths,
  type FirecrackerRunResult,
  type SpawnVmmFn,
  type StopVmmFn,
  type VmmHandle,
  type VmmLaunchSpec,
  type VmmProcessIdentity,
  vmmIdentityFilePath,
  vmmPidFilePath,
} from './firecracker-session-env.js';
import {
  identitiesMatch,
  parseVmmIdentityFile,
  readLiveProcessIdentity,
} from './vmm-process-identity.js';

export type FirecrackerExecMode = 'local' | 'docker';

export interface FirecrackerMount {
  /** Host path, mounted into helpers at this same path. */
  path: string;
  readOnly?: boolean;
}

export interface FirecrackerExecConfig {
  mode: FirecrackerExecMode;
  /** Helper image. Required for `docker` mode. */
  image?: string;
  dockerBin: string;
  sudoBin: string;
  mounts: FirecrackerMount[];
  /** Per-VM scratch root — local mode scans this for stale `vmm.pid` files. */
  runDir?: string;
}

function readPidFile(path: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadStoredIdentity(identityFile?: string): VmmProcessIdentity | null {
  if (!identityFile) return null;
  try {
    return parseVmmIdentityFile(readFileSync(identityFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Kill a local VMM only after proving the PID still refers to the same process
 * we recorded at spawn (cmdline + starttime [+ exe]). A bare PID is reusable.
 */
async function killLocalVmmProcess(
  pid: number,
  vmId: string,
  expected: VmmProcessIdentity | null,
): Promise<void> {
  const live = readLiveProcessIdentity(pid);
  if (!live) {
    // Already gone — nothing to kill.
    return;
  }
  if (!expected) {
    throw new Error(
      `refusing to signal local VMM pid ${pid} (vm ${vmId}): no durable identity file ` +
        `(vmm.identity.json) — cannot prove this PID is still our Firecracker/jailer`,
    );
  }
  if (!identitiesMatch(expected, live)) {
    throw new Error(
      `refusing to signal pid ${pid} (vm ${vmId}): process identity mismatch ` +
        `(PID was reused or identity file is stale)`,
    );
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code !== 'ESRCH') throw err2;
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    if (!processAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (processAlive(pid)) {
    throw new Error(`local VMM pid ${pid} (vm ${vmId}) still alive after SIGKILL`);
  }
}

const RUN_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 30_000;

/** Container name for a VM's VMM, so teardown can find it without a pid. */
export function vmmContainerName(vmId: string): string {
  return `ah-vmm-${vmId}`;
}

function mountFlags(mounts: FirecrackerMount[]): string[] {
  return mounts.flatMap((m) => ['-v', `${m.path}:${m.path}${m.readOnly ? ':ro' : ''}`]);
}

/**
 * Wrap argv so it runs with the privileges Firecracker needs.
 *
 * `--network host` is what makes the tap land in the host namespace and lets
 * the VMM attach to the shared bridge; without it the tap would be created in
 * a namespace that disappears with the helper.
 */
export function buildPrivilegedArgv(
  cfg: FirecrackerExecConfig,
  argv: string[],
  opts: { containerName?: string; detached?: boolean } = {},
): string[] {
  if (cfg.mode === 'local') return [cfg.sudoBin, '-n', ...argv];
  if (!cfg.image) {
    throw new Error(
      'Firecracker exec mode is "docker" but no helper image is configured ' +
        '(set AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE).',
    );
  }
  const [executable, ...args] = argv;
  if (executable === undefined) {
    throw new Error('buildPrivilegedArgv requires a command to run.');
  }
  return [
    cfg.dockerBin,
    'run',
    '--rm',
    ...(opts.containerName ? ['--name', opts.containerName] : []),
    // The helper image is the Finalize CI runner, whose entrypoint bootstraps
    // an inner dockerd. None of that belongs in a one-shot `ip` or `firecracker`
    // invocation, and routing through it turns a missing binary into a shell
    // error attributed to the entrypoint's line number.
    '--entrypoint',
    executable,
    '--privileged',
    // The helper image defaults to an unprivileged user, and --privileged does
    // not change *who* the process is. /dev/kvm is crw-rw---- root:kvm, so a
    // uid-1000 process sees the device node and cannot open it — which the
    // capability probe reports as "KVM not readable/writable" on a host that
    // boots VMs perfectly well. Everything this helper exists to do (create
    // taps, loop-mount images, open /dev/kvm) requires root anyway.
    '--user',
    '0:0',
    '--network',
    'host',
    ...mountFlags(cfg.mounts),
    '-w',
    '/',
    cfg.image,
    ...args,
  ];
}

export function buildStopVmmArgv(cfg: FirecrackerExecConfig, vmId: string): string[] {
  return [cfg.dockerBin, 'rm', '-f', vmmContainerName(vmId)];
}

function execArgv(argv: string[], timeoutMs: number): Promise<FirecrackerRunResult> {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * Host IO for a given exec mode.
 *
 * Only `run` is wrapped. The filesystem helpers stay direct calls because the
 * paths they touch live under the run directory, which the Hub bind-mounts and
 * owns — routing a `mkdir` through a container would cost ~300ms per VM to
 * buy nothing.
 */
export function createFirecrackerHostIo(cfg: FirecrackerExecConfig): FirecrackerHostIo {
  return {
    ...defaultFirecrackerHostIo,
    run: (argv) => execArgv(buildPrivilegedArgv(cfg, argv), RUN_TIMEOUT_MS),
  };
}

/**
 * Runs the VMM, then hands its vsock socket to the Hub.
 *
 * Firecracker creates the vsock UDS itself, as whatever user the VMM runs as
 * — root, in both exec modes (a sudo'd binary locally, a privileged container
 * otherwise). The Hub is not root, so it could see the socket appear and got
 * EACCES on connect, which surfaced only as "guest agent did not answer within
 * 120s": a boot that looked like a guest hang but was a host permission
 * problem. chown'ing to the Hub's own uid grants exactly the one process that
 * needs it, where a permissive mode would open the guest's control channel to
 * every local user.
 *
 * The socket path and owner arrive as positional arguments rather than
 * interpolated into the script, so no value here is ever parsed as shell.
 * Failing to appear is not fatal — the Hub's own readiness wait still reports
 * the timeout, exactly as it did before.
 */
export const VMM_LAUNCH_SCRIPT = [
  'sock=$1; owner=$2; shift 2',
  '"$@" &',
  'vmm=$!',
  'i=0',
  'while [ $i -lt 200 ]; do',
  '  if [ -S "$sock" ]; then chown "$owner" "$sock"; break; fi',
  '  i=$((i+1)); sleep 0.1',
  'done',
  'wait $vmm',
].join('\n');

export function buildVmmLaunchArgv(spec: VmmLaunchSpec): string[] {
  const { vsockPath, ownerUid, ownerGid, argv } = spec;
  if (vsockPath === undefined || ownerUid === undefined || ownerGid === undefined) {
    return argv;
  }
  return ['sh', '-c', VMM_LAUNCH_SCRIPT, 'sh', vsockPath, `${ownerUid}:${ownerGid}`, ...argv];
}

/**
 * Long-lived VMM container: KVM + tun devices and NET_ADMIN only.
 *
 * One-shot helpers (`ip`, disk prepare) still use {@link buildPrivilegedArgv}
 * because losetup/mount need broader capabilities. A VMM escape must not
 * inherit full `--privileged` host device access — see Firecracker prod host
 * setup and Docker runtime privilege docs.
 */
export function buildVmmDockerArgv(
  cfg: FirecrackerExecConfig,
  argv: string[],
  opts: { containerName?: string } = {},
): string[] {
  if (cfg.mode === 'local') return [cfg.sudoBin, '-n', ...argv];
  if (!cfg.image) {
    throw new Error(
      'Firecracker exec mode is "docker" but no helper image is configured ' +
        '(set AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE).',
    );
  }
  const [executable, ...args] = argv;
  if (executable === undefined) {
    throw new Error('buildVmmDockerArgv requires a command to run.');
  }
  return [
    cfg.dockerBin,
    'run',
    '--rm',
    ...(opts.containerName ? ['--name', opts.containerName] : []),
    '--entrypoint',
    executable,
    '--user',
    '0:0',
    '--network',
    'host',
    '--device',
    '/dev/kvm',
    '--device',
    '/dev/net/tun',
    '--cap-add',
    'NET_ADMIN',
    '--security-opt',
    'no-new-privileges:true',
    ...mountFlags(cfg.mounts),
    '-w',
    '/',
    cfg.image,
    ...args,
  ];
}

export function createSpawnVmm(cfg: FirecrackerExecConfig): SpawnVmmFn {
  return (spec) => {
    const { vmId, cwd } = spec;
    const wrapped = buildVmmDockerArgv(cfg, buildVmmLaunchArgv(spec), {
      containerName: vmmContainerName(vmId),
    });
    return nodeSpawn(wrapped[0], wrapped.slice(1), {
      cwd,
      env: process.env,
      // Own process group: in local mode this is the VMM itself, and in docker
      // mode it is the client whose exit should not depend on the Hub's.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as VmmHandle;
  };
}

export function createStopVmm(cfg: FirecrackerExecConfig): StopVmmFn {
  return async ({ vmId, pid, pidFile, identityFile }) => {
    if (cfg.mode === 'local') {
      const expected = loadStoredIdentity(identityFile);
      const target = expected?.pid ?? pid ?? (pidFile ? readPidFile(pidFile) : undefined);
      if (target === undefined) return;
      await killLocalVmmProcess(target, vmId, expected);
      return;
    }
    // `docker rm -f` is the authoritative stop; killing the local client would
    // orphan the container and leak the VM's memory for the host's lifetime.
    const res = await execArgv(buildStopVmmArgv(cfg, vmId), STOP_TIMEOUT_MS);
    if (!res.ok && !/No such container/i.test(res.stderr)) {
      throw new Error(`docker rm -f ${vmmContainerName(vmId)} failed: ${res.stderr.trim()}`);
    }
  };
}

/** Remove every orphaned VMM before a boot tap / disk sweep. Fail closed. */
export async function stopStaleFirecrackerVmms(cfg: FirecrackerExecConfig): Promise<void> {
  if (cfg.mode === 'docker') {
    const listed = await execArgv(
      [cfg.dockerBin, 'ps', '-aq', '--filter', 'name=^ah-vmm-'],
      STOP_TIMEOUT_MS,
    );
    if (!listed.ok) {
      throw new Error(`docker ps for stale VMM containers failed: ${listed.stderr.trim()}`);
    }
    const ids = listed.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    await Promise.all(
      ids.map(async (id) => {
        const res = await execArgv([cfg.dockerBin, 'rm', '-f', id], STOP_TIMEOUT_MS);
        if (!res.ok && !/No such container/i.test(res.stderr)) {
          throw new Error(`docker rm -f ${id} failed: ${res.stderr.trim()}`);
        }
      }),
    );
    return;
  }

  const runDir = cfg.runDir;
  if (!runDir) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(runDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw err;
  }
  const stop = createStopVmm(cfg);
  for (const name of entries) {
    const vmDir = `${runDir}/${name}`;
    const pidFile = vmmPidFilePath(vmDir);
    const identityFile = vmmIdentityFilePath(vmDir);
    const pid = readPidFile(pidFile);
    if (pid === undefined && !loadStoredIdentity(identityFile)) continue;
    await stop({ vmId: name, pid, pidFile, identityFile });
  }
}

/**
 * Shell run inside the helper to answer the capability probe.
 *
 * One container answers all three questions because each `docker run` costs
 * roughly a second, and this is on the boot path. Output is `key=value` lines
 * so a partial or garbled result fails closed rather than parsing as success.
 */
export const HELPER_PROBE_SCRIPT = [
  'if [ -c /dev/kvm ]; then echo kvm_char=1; else echo kvm_char=0; fi',
  'if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then echo kvm_rw=1; else echo kvm_rw=0; fi',
  // Actually open the device in the helper — the Hub container has no /dev/kvm,
  // so a host-side openSync would false-negative a working Firecracker host.
  'if exec 3<>/dev/kvm 2>/dev/null; then echo kvm_open=1; exec 3>&-; else echo kvm_open=0; fi',
  'echo "version=$(firecracker --version 2>&1 | head -1)"',
].join('; ');

export function parseHelperProbeOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Capability-probe dependencies that answer for the *helper's* view of the
 * host rather than the Hub's own container.
 *
 * Probing locally would be actively misleading here: the Hub container has no
 * `/dev/kvm` and no VMM binary, so a direct probe reports "unavailable" on a
 * host that boots VMs perfectly well. What matters is whether the environment
 * that will actually run Firecracker can see them.
 */
export function createHelperCapabilityDeps(
  cfg: FirecrackerExecConfig,
  runProbe: (argv: string[]) => string = defaultSyncRun,
): FirecrackerCapabilityProbeDeps {
  let parsed: Record<string, string> = {};
  let failure = '';
  try {
    parsed = parseHelperProbeOutput(
      runProbe(buildPrivilegedArgv(cfg, ['sh', '-c', HELPER_PROBE_SCRIPT])),
    );
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  return {
    isCharacterDevice: () => parsed.kvm_char === '1',
    access: () => {
      if (parsed.kvm_rw !== '1') throw new Error('not readable/writable in the helper container');
    },
    openKvm: () => {
      if (failure) throw new Error(`helper container ${cfg.image ?? ''} failed to run: ${failure}`);
      if (parsed.kvm_open !== '1') {
        throw new Error('KVM device could not be opened inside the helper container');
      }
    },
    firecrackerVersion: () => {
      if (failure) throw new Error(`helper container ${cfg.image ?? ''} failed to run: ${failure}`);
      if (!parsed.version) throw new Error('helper container reported no firecracker version');
      return parsed.version;
    },
  };
}

function defaultSyncRun(argv: string[]): string {
  return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60_000 });
}

/**
 * Resolve the exec configuration from the environment.
 *
 * Defaults to `docker` whenever a helper image is configured, because that is
 * the only mode that works for the containerized deployment and a Hub on the
 * host can always be pointed back at `local` explicitly.
 */
export function resolveFirecrackerExecConfig(
  paths: FirecrackerPaths,
  env: NodeJS.ProcessEnv = process.env,
): FirecrackerExecConfig {
  const image = env.AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE?.trim() || undefined;
  const configured = env.AGENT_HUB_FIRECRACKER_EXEC_MODE?.trim();
  const mode: FirecrackerExecMode =
    configured === 'local' || configured === 'docker' ? configured : image ? 'docker' : 'local';

  return {
    mode,
    image,
    dockerBin: env.AGENT_HUB_DOCKER_BIN?.trim() || 'docker',
    sudoBin: env.AGENT_HUB_SUDO_BIN?.trim() || 'sudo',
    mounts: resolveHelperMounts(paths, env),
    runDir: paths.runDir,
  };
}
/**
 * Everything a helper container must see, at its host path.
 *
 * The worktrees directory is included because disk preparation copies the
 * session worktree into the guest's workspace image, and the firecracker
 * binary because the helper image is the CI runner image, which has the disk
 * and network tooling but no VMM.
 */
export function resolveHelperMounts(
  paths: FirecrackerPaths,
  env: NodeJS.ProcessEnv = process.env,
): FirecrackerMount[] {
  const mounts: FirecrackerMount[] = [
    { path: dirOf(paths.kernelPath) },
    { path: paths.runDir },
    { path: env.AGENT_HUB_FIRECRACKER_BIN?.trim() || '/usr/bin/firecracker', readOnly: true },
    { path: env.AGENT_HUB_JAILER_BIN?.trim() || '/usr/bin/jailer', readOnly: true },
  ];
  if (paths.jailerChrootBase) mounts.push({ path: paths.jailerChrootBase });
  if (paths.diskHelper) mounts.push({ path: paths.diskHelper, readOnly: true });
  const worktrees = env.AGENT_HUB_HOST_WORKSPACES_DIR?.trim();
  if (worktrees) mounts.push({ path: worktrees });
  for (const extra of (env.AGENT_HUB_FIRECRACKER_EXTRA_MOUNTS ?? '').split(',')) {
    const path = extra.trim();
    if (path) mounts.push({ path });
  }
  return dedupeMounts(mounts);
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : path;
}

/**
 * Drop paths already covered by an ancestor mount. Docker rejects a mount
 * nested inside another with the same source, and the artifact directory is
 * usually the parent of the run directory.
 */
function dedupeMounts(mounts: FirecrackerMount[]): FirecrackerMount[] {
  const out: FirecrackerMount[] = [];
  for (const mount of mounts) {
    const covered = mounts.some(
      (other) =>
        other !== mount &&
        !other.readOnly &&
        mount.path.startsWith(`${other.path}/`) &&
        // A read-only child of a read-write parent still needs its own entry;
        // otherwise it would silently become writable.
        !mount.readOnly,
    );
    if (covered) continue;
    if (out.some((existing) => existing.path === mount.path)) continue;
    out.push(mount);
  }
  return out;
}
