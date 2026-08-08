/**
 * Boot-time probe: can this host actually run session microVMs?
 *
 * The answer is not "are we on Linux". Firecracker needs `/dev/kvm` open for
 * read/write, the VMM binary on PATH, and the guest artifacts staged. On EC2
 * `/dev/kvm` exists only on bare-metal instances or on a virtual instance
 * launched with `CpuOptions.NestedVirtualization=enabled` — an instance that
 * merely *supports* the flag but was launched without it looks identical from
 * userspace except that the device node is absent.
 *
 * Every failure returns a `reason` written for the operator who has to fix
 * it, because "firecracker unavailable, falling back to container" in a boot
 * log is otherwise indistinguishable from a config typo.
 */

import { accessSync, constants, statSync } from 'fs';
import { execFileSync } from 'child_process';

export interface FirecrackerCapability {
  available: boolean;
  /** Human-readable explanation. Empty when available. */
  reason: string;
  /** Resolved `firecracker --version` output, when found. */
  version?: string;
}

export interface FirecrackerCapabilityProbeDeps {
  /** Throws when the path is not accessible with the requested mode. */
  access?: (path: string, mode: number) => void;
  isCharacterDevice?: (path: string) => boolean;
  /** Returns version output, or throws when the binary is missing. */
  firecrackerVersion?: () => string;
  /** Guest artifacts that must exist before a VM can boot. */
  artifactPaths?: string[];
  fileExists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

export const KVM_DEVICE = '/dev/kvm';

function defaultIsCharacterDevice(path: string): boolean {
  try {
    return statSync(path).isCharacterDevice();
  } catch {
    return false;
  }
}

function defaultFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function probeFirecrackerCapability(
  deps: FirecrackerCapabilityProbeDeps = {},
): FirecrackerCapability {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') {
    return {
      available: false,
      reason: `microVM sessions need KVM, which exists only on Linux (this host reports "${platform}")`,
    };
  }

  const isCharDevice = deps.isCharacterDevice ?? defaultIsCharacterDevice;
  if (!isCharDevice(KVM_DEVICE)) {
    return {
      available: false,
      reason:
        `${KVM_DEVICE} is missing. On EC2 this means the instance was not launched with ` +
        'nested virtualization enabled (stop the instance and set ' +
        'CpuOptions.NestedVirtualization=enabled on a supported type), or the host is not bare metal.',
    };
  }

  const access = deps.access ?? accessSync;
  try {
    access(KVM_DEVICE, constants.R_OK | constants.W_OK);
  } catch {
    return {
      available: false,
      reason:
        `${KVM_DEVICE} exists but is not readable/writable by this process. ` +
        'Add the Hub user to the `kvm` group (or adjust the device mode) and restart.',
    };
  }

  const version = deps.firecrackerVersion ?? defaultFirecrackerVersion;
  let versionOutput: string;
  try {
    versionOutput = version().trim();
  } catch (err) {
    return {
      available: false,
      reason:
        'the `firecracker` binary was not found or failed to run: ' +
        (err instanceof Error ? err.message : String(err)),
    };
  }

  const exists = deps.fileExists ?? defaultFileExists;
  const missing = (deps.artifactPaths ?? []).filter((path) => !exists(path));
  if (missing.length > 0) {
    return {
      available: false,
      reason:
        `guest artifacts are missing: ${missing.join(', ')}. ` +
        'Run the host setup that stages the guest kernel and base rootfs.',
    };
  }

  return { available: true, reason: '', version: versionOutput };
}

function defaultFirecrackerVersion(): string {
  return execFileSync('firecracker', ['--version'], { encoding: 'utf8', timeout: 10_000 });
}
