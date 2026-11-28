/**
 * Whether the Firecracker desktop rootfs is staged on this host. Session VMs
 * only need vmlinux + rootfs.ext4, so a registered Firecracker backend does
 * not imply desktops can boot: they need rootfs-desktop.ext4 as well.
 */
import fs from 'fs';
import { firecrackerHostPaths } from '../session-env/firecracker/register-firecracker-backend.js';
import type { DesktopRootfsStatus } from './desktop-runtime-selection.js';

export function firecrackerDesktopRootfsStatus(
  opts: { env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {},
): DesktopRootfsStatus {
  const { desktopRootfsPath, baseRootfsPath } = firecrackerHostPaths(opts.env ?? process.env);
  const path = desktopRootfsPath ?? baseRootfsPath;
  const exists = opts.exists ?? fs.existsSync;
  let present = false;
  try {
    present = exists(path);
  } catch {
    present = false;
  }
  return { path, present };
}
