/**
 * Firecracker snapshot plumbing: the VMM API client, file names, and the
 * compatibility fingerprint that decides whether a stashed snapshot may be
 * resumed.
 *
 * Snapshots are only taken for jailed VMs. Firecracker resolves the snapshot
 * and disk paths relative to the VMM's root, and the jail gives a fixed root
 * with fixed file names, so a snapshot taken in one boot's jail loads in the
 * next boot's jail unchanged. See fc-jail-manage.sh stash-snapshot /
 * restore-snapshot for where the files live between boots.
 */
import { createHash } from 'crypto';
import { stat } from 'fs/promises';
import http from 'http';

/** Written by /snapshot/create inside the jail root, then stashed. */
export const SNAPSHOT_STATE_FILE = 'snapshot.vmstate';
export const SNAPSHOT_MEM_FILE = 'snapshot.mem';
/**
 * Where restore-snapshot puts the stash. Different names from the create
 * targets: the restored VM keeps restore.mem mapped, and /snapshot/create
 * truncates its target, which would pull guest memory out from under it.
 */
export const RESTORE_STATE_FILE = 'restore.vmstate';
export const RESTORE_MEM_FILE = 'restore.mem';

export interface VmmApiResponse {
  status: number;
  body: string;
}

/** One HTTP request to a VMM's API socket. */
export type VmmApiFn = (req: {
  socketPath: string;
  method: 'GET' | 'PUT' | 'PATCH';
  path: string;
  body?: unknown;
  timeoutMs: number;
}) => Promise<VmmApiResponse>;

export const defaultVmmApi: VmmApiFn = ({ socketPath, method, path, body, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: {
          Accept: 'application/json',
          ...(payload === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`VMM API ${method} ${path} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

export interface SnapshotFileStat {
  size: number;
  mtimeMs: number;
}

export type StatFileFn = (path: string) => Promise<SnapshotFileStat>;

export const defaultStatFile: StatFileFn = async (path) => {
  const st = await stat(path);
  return { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
};

/**
 * Everything a snapshot depends on that can change between a stop and the
 * next start. The kernel and base rootfs are identified by size + mtime, so a
 * rebuilt guest image (build-guest-artifacts.sh rewrites both files) never
 * resumes a snapshot taken under the old one. Machine shape and the guest
 * agent protocol are part of it too, as are the guest resolvers. A Firecracker
 * upgrade is not: an
 * incompatible snapshot format makes /snapshot/load fail, which takes the
 * same cold-boot fallback.
 */
export interface SnapshotFingerprintInput {
  kernelPath: string;
  kernel: SnapshotFileStat;
  rootfsPath: string;
  rootfs: SnapshotFileStat;
  vcpuCount: number;
  memSizeMib: number;
  bootArgsExtra: string[];
  /**
   * Guest resolvers. Baked into the boot cmdline, so a snapshot keeps the
   * ones from its boot; a host DNS change has to cold boot to reach the guest.
   */
  nameservers: string[];
  protocolVersion: number;
}

export function snapshotFingerprint(input: SnapshotFingerprintInput): string {
  const canonical = JSON.stringify({
    format: 1,
    kernel: [input.kernelPath, input.kernel.size, input.kernel.mtimeMs],
    rootfs: [input.rootfsPath, input.rootfs.size, input.rootfs.mtimeMs],
    vcpu: input.vcpuCount,
    mem: input.memSizeMib,
    bootArgs: input.bootArgsExtra,
    nameservers: input.nameservers,
    protocol: input.protocolVersion,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function assertVmmApiOk(res: VmmApiResponse, what: string): void {
  if (res.status >= 200 && res.status < 300) return;
  let detail = res.body.trim();
  try {
    const parsed = JSON.parse(detail) as { fault_message?: unknown };
    if (typeof parsed.fault_message === 'string') detail = parsed.fault_message;
  } catch {
    // Not JSON; keep the raw body.
  }
  throw new Error(`${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
}
