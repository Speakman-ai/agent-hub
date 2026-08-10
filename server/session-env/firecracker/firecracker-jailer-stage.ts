/**
 * Jailer chroot layout helpers.
 *
 * Firecracker's jailer pivots into `<chrootBase>/firecracker/<vmId>/root` and
 * only sees paths relative to that root. The operator (us) must stage the
 * kernel, disks, and config there before launch — see jailer.md Observations.
 */

/** Installed by `ops/scripts/setup-firecracker-host.sh`; override via env. */
export const FC_JAIL_MANAGE_HELPER_DEFAULT = '/usr/local/lib/agent-hub/fc-jail-manage.sh';

export function resolveFcJailManageHelper(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_HUB_FIRECRACKER_JAIL_HELPER?.trim() || FC_JAIL_MANAGE_HELPER_DEFAULT;
}

export const JAILER_STAGED_KERNEL = 'vmlinux';
export const JAILER_STAGED_ROOTFS = 'rootfs.ext4';
export const JAILER_STAGED_WORKSPACE = 'workspace.ext4';
export const JAILER_STAGED_CONFIG = 'vm-config.json';
export const JAILER_STAGED_API_SOCK = 'api.sock';
export const JAILER_STAGED_VSOCK = 'vsock.sock';

export function jailerChrootRoot(chrootBaseDir: string, vmId: string): string {
  return `${chrootBaseDir.replace(/\/+$/, '')}/firecracker/${vmId}/root`;
}

export function jailerVmTree(chrootBaseDir: string, vmId: string): string {
  return `${chrootBaseDir.replace(/\/+$/, '')}/firecracker/${vmId}`;
}

export interface JailerStagePlan {
  /** Host path of the jail root (jailed `/`). */
  chrootRoot: string;
  /** Host paths of resources to copy/reflink into the jail (never hard-link). */
  links: Array<{ hostPath: string; jailName: string }>;
  /** Relative paths passed to Firecracker after `--`. */
  apiSockPath: string;
  configPath: string;
  vsockHostPath: string;
}

export function planJailerStage(opts: {
  chrootBaseDir: string;
  vmId: string;
  kernelPath: string;
  rootfsPath: string;
  workspacePath: string;
}): JailerStagePlan {
  const chrootRoot = jailerChrootRoot(opts.chrootBaseDir, opts.vmId);
  return {
    chrootRoot,
    links: [
      { hostPath: opts.kernelPath, jailName: JAILER_STAGED_KERNEL },
      { hostPath: opts.rootfsPath, jailName: JAILER_STAGED_ROOTFS },
      { hostPath: opts.workspacePath, jailName: JAILER_STAGED_WORKSPACE },
    ],
    apiSockPath: JAILER_STAGED_API_SOCK,
    configPath: JAILER_STAGED_CONFIG,
    vsockHostPath: `${chrootRoot}/${JAILER_STAGED_VSOCK}`,
  };
}
