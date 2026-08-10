import { describe, expect, it } from 'vitest';
import {
  JAILER_STAGED_API_SOCK,
  JAILER_STAGED_CONFIG,
  JAILER_STAGED_KERNEL,
  jailerChrootRoot,
  jailerVmTree,
  planJailerStage,
} from './firecracker-jailer-stage.js';

describe('jailer stage plan', () => {
  it('builds the Firecracker jailer chroot layout under the base', () => {
    expect(jailerChrootRoot('/srv/jailer', 'ahvm-1')).toBe('/srv/jailer/firecracker/ahvm-1/root');
    expect(jailerVmTree('/srv/jailer/', 'ahvm-1')).toBe('/srv/jailer/firecracker/ahvm-1');
  });

  it('stages kernel/disks under the jail root with jailed-relative Firecracker paths', () => {
    const plan = planJailerStage({
      chrootBaseDir: '/var/lib/agent-hub/firecracker/jailer',
      vmId: 'ahvm-sess',
      kernelPath: '/var/lib/agent-hub/firecracker/vmlinux',
      rootfsPath: '/run/vms/ahvm-sess/rootfs.ext4',
      workspacePath: '/run/vms/ahvm-sess/workspace.ext4',
    });
    expect(plan.chrootRoot).toBe(
      '/var/lib/agent-hub/firecracker/jailer/firecracker/ahvm-sess/root',
    );
    expect(plan.links.map((l) => l.jailName)).toEqual([
      JAILER_STAGED_KERNEL,
      'rootfs.ext4',
      'workspace.ext4',
    ]);
    expect(plan.apiSockPath).toBe(JAILER_STAGED_API_SOCK);
    expect(plan.configPath).toBe(JAILER_STAGED_CONFIG);
    expect(plan.vsockHostPath).toBe(`${plan.chrootRoot}/vsock.sock`);
  });
});
