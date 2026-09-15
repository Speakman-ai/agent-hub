/**
 * Autopilot containment inspects the worker launch that will actually run
 * (docker argv or Firecracker host disks), not a sample builder configuration.
 * Start checks that a verified isolation adapter is selected and, for Sysbox,
 * that Docker can enforce MemoryLimit, SwapLimit, and CPU CFS. Execution must
 * still call {@link assertAutopilotWorkerLaunch} on that launch, including when
 * a session environment is reused.
 */

import { execFileSync } from 'child_process';
import { AutopilotError } from './errors.js';
import { getSessionEnvSelection } from '../session-env/sysbox-capability.js';
import type {
  SessionEnvAdapterKind,
  SessionEnvSelection,
} from '../session-env/sysbox-capability.js';
import {
  SYSBOX_SESSION_GRAPH_DEST,
  SYSBOX_SESSION_WORKSPACE,
  sysboxGraphVolumeName,
} from '../session-env/sysbox-exec-args.js';
import { resolveHostMountPath } from '../finalize/runner-exec-args.js';

const VERIFIED_ADAPTERS: ReadonlySet<SessionEnvAdapterKind> = new Set(['sysbox', 'firecracker']);

/** Canonical long names after aliasing (`--net` → `--network`). */
const DOCKER_FLAG_ALIASES: ReadonlyMap<string, string> = new Map([
  ['--net', '--network'],
  ['-v', '--volume'],
  ['-p', '--publish'],
  ['-e', '--env'],
  ['-w', '--workdir'],
  ['-u', '--user'],
  ['-h', '--hostname'],
  ['-l', '--label'],
  ['-m', '--memory'],
  ['-d', '--detach'],
]);

const DOCKER_BOOLEAN_FLAGS = new Set([
  '--privileged',
  '--detach',
  '--init',
  '--rm',
  '--tty',
  '--interactive',
  '--read-only',
]);

const DOCKER_VALUE_FLAGS = new Set([
  '--cpus',
  '--memory',
  '--memory-swap',
  '--name',
  '--hostname',
  '--label',
  '--user',
  '--workdir',
  '--env',
  '--publish',
  '--runtime',
  '--volume',
  '--mount',
  '--device',
  '--tmpfs',
  '--volumes-from',
  '--pid',
  '--network',
  '--uts',
  '--ipc',
  '--cgroupns',
  '--userns',
  '--cap-add',
  '--cap-drop',
  '--security-opt',
]);

const HOST_NAMESPACE_FLAGS = new Set([
  '--pid',
  '--network',
  '--uts',
  '--ipc',
  '--cgroupns',
  '--userns',
]);

/** Flags the production sysbox builder may emit without failing the probe. */
const HARMLESS_DOCKER_FLAGS = new Set([
  '--detach',
  '--cpus',
  '--memory',
  '--memory-swap',
  '--name',
  '--hostname',
  '--label',
  '--user',
  '--workdir',
  '--env',
  '--publish',
  '--runtime',
  '--volume',
  '--mount',
]);

export type AutopilotIsolationRuntime = 'sysbox-runc' | 'firecracker' | 'none';

export type ContainmentMountKind = 'bind' | 'volume';

export interface AuthorizedContainmentMount {
  source: string;
  destination: string;
  /** Docker mount type. Source+dest without type is not identity. */
  kind: ContainmentMountKind;
}

export interface AuthorizedFirecrackerDrive {
  drive_id: string;
  path_on_host: string;
}

/**
 * Evidence the host Docker daemon can enforce CPU/memory/swap. Requested
 * `docker run` flags are not this — `--memory-swap` is ignored without SwapLimit.
 */
export interface DockerResourceControllerCapability {
  /** Host can enforce `--memory` (Docker Info `MemoryLimit`). */
  memoryLimit: boolean;
  /** Host can enforce `--memory-swap` (Docker Info `SwapLimit`). */
  swapLimit: boolean;
  /** Host can enforce `--cpus` (Docker Info `CpuCfsQuota` and `CpuCfsPeriod`). */
  cpuQuota: boolean;
}

/** Controllers Docker reports as present. Tests inject this; production parses `docker info`. */
export const ENFORCED_DOCKER_RESOURCE_CONTROLLERS: DockerResourceControllerCapability = {
  memoryLimit: true,
  swapLimit: true,
  cpuQuota: true,
};

/**
 * The configuration a worker will execute. Inspection never rebuilds a
 * probe session; callers pass the argv or disks they are about to start.
 */
export type AutopilotWorkerLaunch =
  | {
      kind: 'docker-run';
      argv: readonly string[];
      authorizedMounts: ReadonlyArray<AuthorizedContainmentMount>;
      /**
       * Evidence the host can enforce CPU/memory/swap. Requested argv flags
       * are not enough; omit or a false field fails closed.
       */
      resourceControllers?: DockerResourceControllerCapability | null;
    }
  | {
      kind: 'firecracker';
      drives: ReadonlyArray<AuthorizedFirecrackerDrive>;
      authorizedDrives: ReadonlyArray<AuthorizedFirecrackerDrive>;
      vcpuCount: number;
      memSizeMib: number;
    };

export interface AutopilotContainmentParseOptions {
  /**
   * Exact source→destination→type triples this worker may attach. Every other
   * bind, named volume, tmpfs, or volumes-from is extra. Empty/omitted fails closed.
   */
  authorizedMounts?: ReadonlyArray<AuthorizedContainmentMount>;
  /**
   * Verified host cgroup/Docker resource controllers. Absent or incomplete
   * evidence is not enforcement — a finite `--memory-swap` is not SwapLimit.
   */
  resourceControllers?: DockerResourceControllerCapability | null;
}

export interface AutopilotContainmentProbe {
  adapter: SessionEnvAdapterKind;
  fellBack: boolean;
  inspectable: boolean;
  dockerSocketMounted: boolean;
  extraHostMounts: string[];
  resourceLimitsEnforced: boolean;
  privileged: boolean;
  hostNamespacesShared: boolean;
  isolationRuntime: AutopilotIsolationRuntime;
}

export interface AutopilotContainmentResult {
  ok: boolean;
  reason: string;
}

export interface AutopilotContainmentProbeDeps {
  getSelection?: () => SessionEnvSelection;
  inspectAdapter?: (
    adapter: SessionEnvAdapterKind,
    launch?: AutopilotWorkerLaunch,
  ) => Omit<AutopilotContainmentProbe, 'adapter' | 'fellBack'>;
  /** Exact worker launch. Required to prove mounts/disks/limits; Start omits it. */
  launch?: AutopilotWorkerLaunch;
  /**
   * Docker Info (or injected snapshot) for MemoryLimit / SwapLimit / CPU CFS.
   * Start requires this for Sysbox. Omit or a false field fails closed.
   */
  getResourceControllers?: () => DockerResourceControllerCapability | null;
  /**
   * Operator opt-out of the managed-isolation requirement. When true, the host
   * adapter is accepted instead of failing closed. Only the `host` adapter is
   * relaxed — container/fallback-to-non-host still fail closed.
   */
  allowHostAdapter?: boolean;
}

export interface AutopilotContainmentEvalOptions {
  allowHostAdapter?: boolean;
}

/** The reason surfaced when the operator opted into the unmanaged host adapter. */
export const HOST_ADAPTER_OPT_IN_REASON =
  'using host adapter (operator opted out of managed isolation)';

export function parseDockerRunContainment(
  argv: string[],
  options: AutopilotContainmentParseOptions = {},
): Omit<AutopilotContainmentProbe, 'adapter' | 'fellBack'> {
  if (argv.length === 0) {
    return unverifiableProbe();
  }
  const authorizedMounts = options.authorizedMounts ?? [];
  const parsed = tokenizeDockerRunArgv(argv);
  const mounts = [
    ...(parsed.options.get('--volume') ?? []).map(parseVolumeSpec),
    ...(parsed.options.get('--mount') ?? []).map(parseMountSpec),
  ];
  const dockerSocketMounted = mounts.some(
    (mount) =>
      mount.source.includes('docker.sock') ||
      mount.destination.includes('docker.sock') ||
      mount.raw.includes('docker.sock'),
  );
  const extraHostMounts = [
    ...mounts
      .filter((mount) => !isAuthorizedMount(mount, authorizedMounts))
      .map((mount) => mount.backingPath || mount.source || mount.raw),
    ...(parsed.options.get('--device') ?? []).map((value) => value.split(':')[0] ?? value),
    ...(parsed.options.get('--volumes-from') ?? []),
    ...(parsed.options.get('--tmpfs') ?? []),
    ...(parsed.options.get('--cap-add') ?? []),
    ...(parsed.options.get('--cap-drop') ?? []),
    ...(parsed.options.get('--security-opt') ?? []),
  ];
  const runtime = lastOptionValue(parsed, '--runtime');
  return {
    inspectable: parsed.unrecognized.length === 0,
    dockerSocketMounted,
    extraHostMounts,
    resourceLimitsEnforced: dockerResourceLimitsEnforced(parsed, options.resourceControllers),
    privileged: dockerBooleanFlag(parsed, '--privileged'),
    hostNamespacesShared: sharesHostNamespaces(parsed),
    isolationRuntime: runtime === 'sysbox-runc' ? 'sysbox-runc' : 'none',
  };
}

/** Exact mounts the production sysbox builder is allowed to attach. */
export function authorizedSysboxContainmentMounts(opts: {
  worktreePath: string;
  containerName: string;
}): AuthorizedContainmentMount[] {
  return [
    {
      source: resolveHostMountPath(opts.worktreePath),
      destination: SYSBOX_SESSION_WORKSPACE,
      kind: 'bind',
    },
    {
      source: sysboxGraphVolumeName(opts.containerName),
      destination: SYSBOX_SESSION_GRAPH_DEST,
      kind: 'volume',
    },
  ];
}

interface ParsedMount {
  source: string;
  destination: string;
  raw: string;
  kind: 'bind' | 'volume' | 'unknown';
  /** Any --mount/-v field other than identity and rw/ro. Nonempty fails closed. */
  extras: string[];
  /** Host path concealed by volume-opt=device=… when present. */
  backingPath: string | null;
}

const MOUNT_SOURCE_ALIASES = new Set(['source', 'src']);
const MOUNT_DEST_ALIASES = new Set(['target', 'dst', 'destination']);
const MOUNT_MODE_ALIASES = new Set(['readonly', 'ro', 'rw']);

const ALLOWED_VOLUME_MODES = new Set(['rw', 'ro']);

interface TokenizedDockerRun {
  options: Map<string, string[]>;
  unrecognized: string[];
}

function tokenizeDockerRunArgv(argv: string[]): TokenizedDockerRun {
  const options = new Map<string, string[]>();
  const unrecognized: string[] = [];
  let i = skipDockerRunPrefix(argv);
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') break;
    if (!arg.startsWith('-')) break;
    const eq = arg.indexOf('=');
    const rawFlag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const canonical = canonicalDockerFlag(rawFlag);
    if (!canonical) {
      unrecognized.push(arg);
      i += 1;
      continue;
    }
    if (DOCKER_BOOLEAN_FLAGS.has(canonical)) {
      pushOption(options, canonical, inlineValue ?? 'true');
      i += 1;
      continue;
    }
    if (inlineValue !== undefined) {
      pushOption(options, canonical, inlineValue);
      i += 1;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('-')) {
      unrecognized.push(arg);
      i += 1;
      continue;
    }
    pushOption(options, canonical, next);
    i += 2;
  }
  for (const name of options.keys()) {
    if (
      !HARMLESS_DOCKER_FLAGS.has(name) &&
      name !== '--privileged' &&
      !HOST_NAMESPACE_FLAGS.has(name) &&
      name !== '--device' &&
      name !== '--tmpfs' &&
      name !== '--volumes-from' &&
      name !== '--cap-add' &&
      name !== '--cap-drop' &&
      name !== '--security-opt'
    ) {
      unrecognized.push(name);
    }
  }
  return { options, unrecognized };
}

function skipDockerRunPrefix(argv: string[]): number {
  let i = 0;
  if (argv[i] === 'docker' || argv[i]?.endsWith('/docker')) i += 1;
  if (argv[i] === 'container') i += 1;
  if (argv[i] === 'run') i += 1;
  return i;
}

function canonicalDockerFlag(rawFlag: string): string | null {
  const aliased = DOCKER_FLAG_ALIASES.get(rawFlag) ?? rawFlag;
  if (DOCKER_BOOLEAN_FLAGS.has(aliased) || DOCKER_VALUE_FLAGS.has(aliased)) return aliased;
  return null;
}

function pushOption(options: Map<string, string[]>, name: string, value: string): void {
  const values = options.get(name);
  if (values) values.push(value);
  else options.set(name, [value]);
}

function lastOptionValue(parsed: TokenizedDockerRun, flag: string): string | null {
  const values = parsed.options.get(flag);
  return values && values.length > 0 ? (values[values.length - 1] ?? null) : null;
}

function dockerBooleanFlag(parsed: TokenizedDockerRun, flag: string): boolean {
  const values = parsed.options.get(flag);
  if (!values || values.length === 0) return false;
  return values.some((value) => isDockerTruthy(value));
}

function isDockerTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off'
  );
}

/**
 * Docker's effective memory envelope includes swap. `--memory-swap=-1` is
 * unlimited host swap; `0` or omitted is treated as unset (Docker then allows
 * as much swap as `--memory`). Managed workers must set a finite swap total
 * at least as large as `--memory` (production sets them equal: no extra swap).
 *
 * Requested flags are not enforcement: `--memory-swap` is ignored when the
 * daemon has no SwapLimit support. Require Docker Info (or equivalent)
 * evidence that memory, swap, and CPU quota controllers are actually present.
 */
function dockerResourceLimitsEnforced(
  parsed: TokenizedDockerRun,
  controllers: DockerResourceControllerCapability | null | undefined,
): boolean {
  if (!dockerResourceControllersAvailable(controllers)) return false;
  const cpus = parseDockerPositiveNumber(lastOptionValue(parsed, '--cpus'));
  const memory = parseDockerByteQuantity(lastOptionValue(parsed, '--memory'));
  const swap = parseDockerByteQuantity(lastOptionValue(parsed, '--memory-swap'));
  return (
    cpus != null &&
    memory != null &&
    Number.isFinite(memory) &&
    memory > 0 &&
    swap != null &&
    Number.isFinite(swap) &&
    swap >= memory
  );
}

export function dockerResourceControllersAvailable(
  controllers: DockerResourceControllerCapability | null | undefined,
): boolean {
  return Boolean(controllers?.memoryLimit && controllers?.swapLimit && controllers?.cpuQuota);
}

/** Parse `docker info --format '{{json .}}'` (or a subset object with the same keys). */
export function parseDockerInfoResourceControllers(
  stdout: string,
): DockerResourceControllerCapability | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const info = parsed as Record<string, unknown>;
    return {
      memoryLimit: info.MemoryLimit === true,
      swapLimit: info.SwapLimit === true,
      cpuQuota: info.CpuCfsQuota === true && info.CpuCfsPeriod === true,
    };
  } catch {
    return null;
  }
}

export const DOCKER_INFO_RESOURCE_CONTROLLERS_ARGV = [
  'docker',
  'info',
  '--format',
  '{{json .}}',
] as const;

export async function probeDockerResourceControllers(
  run: (argv: string[]) => Promise<{ ok: boolean; stdout: string }>,
): Promise<DockerResourceControllerCapability | null> {
  const result = await run([...DOCKER_INFO_RESOURCE_CONTROLLERS_ARGV]);
  if (!result.ok) return null;
  return parseDockerInfoResourceControllers(result.stdout);
}

/** Sync Docker Info probe for Autopilot Start. Fail closed on any error. */
export function probeDockerResourceControllersSync(): DockerResourceControllerCapability | null {
  try {
    const stdout = execFileSync(
      DOCKER_INFO_RESOURCE_CONTROLLERS_ARGV[0],
      [...DOCKER_INFO_RESOURCE_CONTROLLERS_ARGV.slice(1)],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseDockerInfoResourceControllers(String(stdout ?? ''));
  } catch {
    return null;
  }
}

function parseDockerPositiveNumber(value: string | null): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Bytes, or +Infinity for Docker's unlimited `--memory-swap=-1`. */
function parseDockerByteQuantity(value: string | null): number | null {
  if (value == null || value === '') return null;
  if (value === '-1') return Number.POSITIVE_INFINITY;
  const match = /^([0-9]+)([kKmMgGtT][bB]?)?$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (match[2] ?? '').slice(0, 1).toLowerCase();
  const mul =
    suffix === 'k'
      ? 1024
      : suffix === 'm'
        ? 1024 * 1024
        : suffix === 'g'
          ? 1024 * 1024 * 1024
          : suffix === 't'
            ? 1024 * 1024 * 1024 * 1024
            : 1;
  return n * mul;
}

function sharesHostNamespaces(parsed: TokenizedDockerRun): boolean {
  for (const flag of HOST_NAMESPACE_FLAGS) {
    for (const value of parsed.options.get(flag) ?? []) {
      if (value === 'host' || value.startsWith('container:')) return true;
    }
  }
  return false;
}

function parseVolumeSpec(spec: string): ParsedMount {
  const parts = spec.split(':');
  if (parts.length < 2) {
    return {
      source: spec,
      destination: '',
      raw: spec,
      kind: 'unknown',
      extras: [],
      backingPath: null,
    };
  }
  const source = parts[0] ?? '';
  const destination = parts[1] ?? '';
  const extras: string[] = [];
  if (parts.length >= 3) {
    for (const option of (parts[2] ?? '').split(',')) {
      if (option && !ALLOWED_VOLUME_MODES.has(option)) extras.push(option);
    }
  }
  if (parts.length > 3) extras.push(parts.slice(3).join(':'));
  const kind = isHostPath(source) ? 'bind' : 'volume';
  return { source, destination, raw: spec, kind, extras, backingPath: null };
}

function parseMountSpec(spec: string): ParsedMount {
  const extras: string[] = [];
  let backingPath: string | null = null;
  const sources: string[] = [];
  const destinations: string[] = [];
  const types: string[] = [];
  const modes: string[] = [];
  for (const part of spec.split(',')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : part.slice(eq + 1);
    if (key === 'volume-opt') {
      extras.push(`${key}=${value}`);
      const optEq = value.indexOf('=');
      const optKey = optEq === -1 ? value : value.slice(0, optEq);
      const optVal = optEq === -1 ? '' : value.slice(optEq + 1);
      if (optKey === 'device' && optVal) backingPath = optVal;
      continue;
    }
    if (MOUNT_SOURCE_ALIASES.has(key)) {
      sources.push(value);
      continue;
    }
    if (MOUNT_DEST_ALIASES.has(key)) {
      destinations.push(value);
      continue;
    }
    if (key === 'type') {
      types.push(value.toLowerCase());
      continue;
    }
    if (MOUNT_MODE_ALIASES.has(key)) {
      modes.push(key);
      continue;
    }
    extras.push(value ? `${key}=${value}` : key);
  }
  if (sources.length > 1) {
    extras.push('duplicate-source');
    const last = sources[sources.length - 1];
    if (last) backingPath = backingPath ?? last;
  }
  if (destinations.length > 1) {
    extras.push('duplicate-destination');
    const last = destinations[destinations.length - 1];
    if (last) backingPath = backingPath ?? last;
  }
  if (types.length > 1) extras.push('duplicate-type');
  if (modes.length > 1) extras.push('duplicate-mode');
  const source = sources[sources.length - 1] ?? '';
  const destination = destinations[destinations.length - 1] ?? '';
  const type = types[types.length - 1] ?? '';
  const kind: ParsedMount['kind'] =
    type === 'bind' ? 'bind' : type === 'volume' ? 'volume' : 'unknown';
  return { source, destination, raw: spec, kind, extras, backingPath };
}

function isHostPath(source: string): boolean {
  return source.startsWith('/') || source.startsWith('.') || source.startsWith('~');
}

/** Docker preserves path bytes, including trailing spaces. Do not rewrite. */
function samePathIdentity(a: string, b: string): boolean {
  return a.length > 0 && a === b;
}

function isAuthorizedMount(
  mount: ParsedMount,
  authorizedMounts: ReadonlyArray<AuthorizedContainmentMount>,
): boolean {
  if (mount.kind === 'unknown' || mount.extras.length > 0 || mount.backingPath) return false;
  return authorizedMounts.some(
    (allowed) =>
      mount.kind === allowed.kind &&
      samePathIdentity(mount.source, allowed.source) &&
      samePathIdentity(mount.destination, allowed.destination),
  );
}

/**
 * Guest disks are authorized only by exact drive_id plus path_on_host.
 * Labels such as rootfs are not a skip; a missing or swapped disk fails closed.
 */
export function extraFirecrackerHostDrives(
  drives: ReadonlyArray<{ drive_id: string; path_on_host: string }>,
  authorizedDrives: ReadonlyArray<{ drive_id: string; path_on_host: string }>,
): string[] {
  const extra: string[] = [];
  const matched = new Set<string>();
  for (const drive of drives) {
    const allowed = authorizedDrives.find((candidate) => candidate.drive_id === drive.drive_id);
    if (
      allowed &&
      !matched.has(drive.drive_id) &&
      samePathIdentity(drive.path_on_host, allowed.path_on_host)
    ) {
      matched.add(drive.drive_id);
      continue;
    }
    extra.push(drive.path_on_host);
  }
  for (const allowed of authorizedDrives) {
    if (!matched.has(allowed.drive_id)) extra.push(allowed.path_on_host);
  }
  return extra;
}

/**
 * Map jailer-relative drive paths back to the host disks that will be staged,
 * and keep any other path_on_host as an extra (unauthorized) exposure.
 */
export function firecrackerEffectiveHostDrives(opts: {
  configDrives: ReadonlyArray<AuthorizedFirecrackerDrive>;
  hostRootfsPath: string;
  hostWorkspacePath: string;
  stagedRootfsPath?: string;
  stagedWorkspacePath?: string;
}): AuthorizedFirecrackerDrive[] {
  return opts.configDrives.map((drive) => {
    if (opts.stagedRootfsPath && drive.path_on_host === opts.stagedRootfsPath) {
      return { drive_id: drive.drive_id, path_on_host: opts.hostRootfsPath };
    }
    if (opts.stagedWorkspacePath && drive.path_on_host === opts.stagedWorkspacePath) {
      return { drive_id: drive.drive_id, path_on_host: opts.hostWorkspacePath };
    }
    return { drive_id: drive.drive_id, path_on_host: drive.path_on_host };
  });
}

export function authorizedFirecrackerContainmentDrives(opts: {
  rootfsPath: string;
  workspacePath: string;
}): AuthorizedFirecrackerDrive[] {
  return [
    { drive_id: 'rootfs', path_on_host: opts.rootfsPath },
    { drive_id: 'workspace', path_on_host: opts.workspacePath },
  ];
}

function unverifiableProbe(): Omit<AutopilotContainmentProbe, 'adapter' | 'fellBack'> {
  return {
    inspectable: false,
    dockerSocketMounted: false,
    extraHostMounts: [],
    resourceLimitsEnforced: false,
    privileged: false,
    hostNamespacesShared: false,
    isolationRuntime: 'none',
  };
}

function hostAdapterProbe(): Omit<AutopilotContainmentProbe, 'adapter' | 'fellBack'> {
  return {
    inspectable: true,
    dockerSocketMounted: false,
    extraHostMounts: ['/'],
    resourceLimitsEnforced: false,
    privileged: true,
    hostNamespacesShared: true,
    isolationRuntime: 'none',
  };
}

function inspectFirecrackerLaunch(
  launch: Extract<AutopilotWorkerLaunch, { kind: 'firecracker' }>,
): Omit<AutopilotContainmentProbe, 'adapter' | 'fellBack'> {
  const extraHostMounts = extraFirecrackerHostDrives(launch.drives, launch.authorizedDrives);
  const resourceLimitsEnforced =
    Number.isFinite(launch.vcpuCount) &&
    launch.vcpuCount >= 1 &&
    Number.isFinite(launch.memSizeMib) &&
    launch.memSizeMib >= 128;
  return {
    inspectable: true,
    dockerSocketMounted: false,
    extraHostMounts,
    resourceLimitsEnforced,
    privileged: false,
    hostNamespacesShared: false,
    isolationRuntime: 'firecracker',
  };
}

/**
 * Inspect the supplied worker launch. An adapter name alone is not evidence:
 * sysbox/firecracker without a launch are uninspectable rather than a
 * self-authorized sample builder configuration.
 */
export function inspectWorkerLaunch(
  adapter: SessionEnvAdapterKind,
  launch?: AutopilotWorkerLaunch,
): Omit<AutopilotContainmentProbe, 'adapter' | 'fellBack'> {
  if (adapter === 'host') return hostAdapterProbe();
  if (!launch) return unverifiableProbe();
  if (launch.kind === 'docker-run') {
    if (adapter !== 'sysbox' && adapter !== 'container') return unverifiableProbe();
    return parseDockerRunContainment([...launch.argv], {
      authorizedMounts: launch.authorizedMounts,
      resourceControllers: launch.resourceControllers,
    });
  }
  if (adapter !== 'firecracker') return unverifiableProbe();
  return inspectFirecrackerLaunch(launch);
}

/** @deprecated Use {@link inspectWorkerLaunch}; kept so existing tests can pass a launch. */
export function inspectIsolatedAdapterRuntime(
  adapter: SessionEnvAdapterKind,
  launch?: AutopilotWorkerLaunch,
): Omit<AutopilotContainmentProbe, 'adapter' | 'fellBack'> {
  return inspectWorkerLaunch(adapter, launch);
}

export function probeAutopilotContainment(
  deps: AutopilotContainmentProbeDeps = {},
): AutopilotContainmentProbe {
  const selection = (deps.getSelection ?? getSessionEnvSelection)();
  const inspect = deps.inspectAdapter ?? inspectWorkerLaunch;
  const inspected = inspect(selection.adapter, deps.launch);
  return {
    adapter: selection.adapter,
    fellBack: selection.fellBack,
    ...inspected,
  };
}

/**
 * Start/resume: a verified adapter is selected. For Sysbox, Docker must also
 * report MemoryLimit, SwapLimit, and CPU CFS. Mounts and disks are proven on
 * the actual worker launch, not here.
 */
export function evaluateAutopilotIsolationCapability(
  selection: SessionEnvSelection,
  resourceControllers?: DockerResourceControllerCapability | null,
  opts?: AutopilotContainmentEvalOptions,
): AutopilotContainmentResult {
  if (opts?.allowHostAdapter && selection.adapter === 'host') {
    return { ok: true, reason: HOST_ADAPTER_OPT_IN_REASON };
  }
  if (selection.fellBack && !VERIFIED_ADAPTERS.has(selection.adapter)) {
    return {
      ok: false,
      reason: 'Autopilot cannot start: required session isolation fell back to the host adapter',
    };
  }
  if (!VERIFIED_ADAPTERS.has(selection.adapter)) {
    return {
      ok: false,
      reason:
        'Autopilot cannot start: managed project runtime isolation is required (sysbox or firecracker)',
    };
  }
  if (selection.adapter === 'sysbox' && !dockerResourceControllersAvailable(resourceControllers)) {
    return {
      ok: false,
      reason: 'Autopilot cannot start: managed worker resource limits are not enforced',
    };
  }
  return { ok: true, reason: `using ${selection.adapter} session isolation` };
}

export function evaluateAutopilotContainment(
  probe: AutopilotContainmentProbe,
  opts?: AutopilotContainmentEvalOptions,
): AutopilotContainmentResult {
  if (opts?.allowHostAdapter && probe.adapter === 'host') {
    return { ok: true, reason: HOST_ADAPTER_OPT_IN_REASON };
  }
  if (!probe.inspectable) {
    return {
      ok: false,
      reason: 'Autopilot cannot start: worker runtime containment is not inspectable',
    };
  }
  if (probe.fellBack && !VERIFIED_ADAPTERS.has(probe.adapter)) {
    return {
      ok: false,
      reason: 'Autopilot cannot start: required session isolation fell back to the host adapter',
    };
  }
  if (!VERIFIED_ADAPTERS.has(probe.adapter)) {
    return {
      ok: false,
      reason:
        'Autopilot cannot start: managed project runtime isolation is required (sysbox or firecracker)',
    };
  }
  if (probe.privileged || probe.hostNamespacesShared) {
    return {
      ok: false,
      reason:
        'Autopilot cannot start: privileged containers and host namespaces are not a verified isolation boundary',
    };
  }
  if (probe.adapter === 'sysbox' && probe.isolationRuntime !== 'sysbox-runc') {
    return {
      ok: false,
      reason: 'Autopilot cannot start: sysbox workers must use the sysbox-runc runtime',
    };
  }
  if (probe.adapter === 'firecracker' && probe.isolationRuntime !== 'firecracker') {
    return {
      ok: false,
      reason: 'Autopilot cannot start: firecracker machine isolation was not verified',
    };
  }
  if (probe.dockerSocketMounted) {
    return {
      ok: false,
      reason: 'Autopilot cannot start: the host Docker socket must not be mounted into workers',
    };
  }
  if (probe.extraHostMounts.length > 0) {
    return {
      ok: false,
      reason: 'Autopilot cannot start: arbitrary host mounts are not allowed',
    };
  }
  if (!probe.resourceLimitsEnforced) {
    return {
      ok: false,
      reason: 'Autopilot cannot start: managed worker resource limits are not enforced',
    };
  }
  return { ok: true, reason: `using ${probe.adapter} session isolation` };
}

export function assertAutopilotWorkerLaunch(
  adapter: SessionEnvAdapterKind,
  launch: AutopilotWorkerLaunch,
  fellBack = false,
  opts?: AutopilotContainmentEvalOptions,
): void {
  const result = evaluateAutopilotContainment(
    {
      adapter,
      fellBack,
      ...inspectWorkerLaunch(adapter, launch),
    },
    opts,
  );
  if (!result.ok) {
    throw new AutopilotError('containment_unavailable', result.reason);
  }
}

export function assertAutopilotContainment(
  probe?: AutopilotContainmentProbe,
  deps?: AutopilotContainmentProbeDeps,
): void {
  const evalOpts: AutopilotContainmentEvalOptions = { allowHostAdapter: deps?.allowHostAdapter };
  if (probe) {
    const result = evaluateAutopilotContainment(probe, evalOpts);
    if (!result.ok) {
      throw new AutopilotError('containment_unavailable', result.reason);
    }
    return;
  }
  if (deps?.launch) {
    const selection = (deps.getSelection ?? getSessionEnvSelection)();
    assertAutopilotWorkerLaunch(selection.adapter, deps.launch, selection.fellBack, evalOpts);
    return;
  }
  const selection = (deps?.getSelection ?? getSessionEnvSelection)();
  const resourceControllers = deps?.getResourceControllers
    ? deps.getResourceControllers()
    : selection.adapter === 'sysbox'
      ? probeDockerResourceControllersSync()
      : null;
  const result = evaluateAutopilotIsolationCapability(selection, resourceControllers, evalOpts);
  if (!result.ok) {
    throw new AutopilotError('containment_unavailable', result.reason);
  }
}
