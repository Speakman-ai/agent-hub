/**
 * `detect-host` adapter.
 *
 * Probes the runtime environment and classifies it as one of three host
 * classes documented in the V1 wizard spec:
 *
 *   - `containerized` — Docker / containerd / kubepods. nginx layout is
 *     `/etc/nginx/conf.d` (AL2023 / Amazon Linux). No sites-enabled.
 *   - `pm2-on-ec2`    — PM2 process manager + EC2 product UUID.
 *     Debian/Ubuntu nginx layout (`sites-available` + `sites-enabled`).
 *   - `dev`           — Fallback for non-production hosts. The wizard
 *     refuses to mutate `/etc/nginx/*` here and writes a `.dev` stub
 *     vhost into `<dataDir>/nginx-dev/` instead.
 *
 * Probes run in this order; ties resolve toward the more constrained
 * env (containerized > pm2 > dev) so a false-positive on `dev` can't
 * let the wizard write into production paths.
 */

import type { ProvisionIO } from './io.js';

export type HostClass = 'containerized' | 'pm2-on-ec2' | 'dev';

export interface DetectedHost {
  class: HostClass;
  /** nginx vhost include directory (e.g. `/etc/nginx/sites-available`). */
  sitesAvailableDir: string;
  /** nginx active-vhost directory (e.g. `/etc/nginx/sites-enabled`). */
  sitesEnabledDir: string;
  /** Path the wizard expects the base preview vhost to live at. */
  baseVhostPath: string;
  /** Standard certbot live cert path for `previewHost`. */
  certPathFor(previewHost: string): string;
  /** Standard certbot privkey path for `previewHost`. */
  keyPathFor(previewHost: string): string;
  /** EC2 instance role ARN if discoverable via IMDS — null otherwise. */
  instanceRoleArn: string | null;
  /** `iam:GetInstanceProfile`-derivable role name (last `/` segment of arn). */
  instanceRoleName: string | null;
  /** `EC2_INSTANCE_ID` env value or IMDS `instance-id` if reachable. */
  instanceId: string | null;
  /** Diagnostic notes — surfaced via `ctx.log` so operators can trace probes. */
  notes: string[];
}

export interface DetectHostOptions {
  /**
   * Override the dev-mode nginx stub directory. Production resolves it
   * from `config.dataDir` so the dev fallback writes into the install's
   * data dir; tests inject a tmp path.
   */
  devNginxStubDir: string;
  /**
   * Override `EC2_INSTANCE_ID` env lookup. Tests pass `() => null`; prod
   * defaults to `process.env.EC2_INSTANCE_ID`.
   */
  readEnv?: (key: string) => string | undefined;
  /** Override `process.env.NODE_ENV` for the dev-class fallback test. */
  readNodeEnv?: () => string | undefined;
  /**
   * Optional log sink — adapters thread `ctx.log` here so probe outcomes
   * appear in the orchestrator's stream.
   */
  log?: (line: string) => void;
}

/** IMDSv2 endpoints. Centralised so the test can intercept `fetch`. */
const IMDS_TOKEN_URL = 'http://169.254.169.254/latest/api/token';
const IMDS_IAM_INFO_URL = 'http://169.254.169.254/latest/meta-data/iam/info';
const IMDS_INSTANCE_ID_URL = 'http://169.254.169.254/latest/meta-data/instance-id';
const IMDS_TIMEOUT_MS = 1500;

/** Quick AbortSignal helper that doesn't require Node 20.0 `AbortSignal.timeout`. */
function abortAfter(ms: number): AbortSignal {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms).unref?.();
  return ctl.signal;
}

interface ImdsSnapshot {
  token: string | null;
  iamInfo: { InstanceProfileArn?: string } | null;
  instanceId: string | null;
}

async function readImds(io: ProvisionIO, log: (l: string) => void): Promise<ImdsSnapshot> {
  let token: string | null = null;
  try {
    const res = await io.fetch(IMDS_TOKEN_URL, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
      signal: abortAfter(IMDS_TIMEOUT_MS),
    });
    if (res.ok) token = (await res.text()).trim();
  } catch (err) {
    log(`imds: token fetch failed (${(err as Error).message})`);
    return { token: null, iamInfo: null, instanceId: null };
  }
  if (!token) {
    log('imds: token endpoint returned non-OK; treating as non-EC2');
    return { token: null, iamInfo: null, instanceId: null };
  }

  let iamInfo: { InstanceProfileArn?: string } | null = null;
  try {
    const res = await io.fetch(IMDS_IAM_INFO_URL, {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: abortAfter(IMDS_TIMEOUT_MS),
    });
    if (res.ok) iamInfo = (await res.json()) as { InstanceProfileArn?: string };
  } catch (err) {
    log(`imds: iam/info fetch failed (${(err as Error).message})`);
  }

  let instanceId: string | null = null;
  try {
    const res = await io.fetch(IMDS_INSTANCE_ID_URL, {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: abortAfter(IMDS_TIMEOUT_MS),
    });
    if (res.ok) instanceId = (await res.text()).trim();
  } catch (err) {
    log(`imds: instance-id fetch failed (${(err as Error).message})`);
  }

  return { token, iamInfo, instanceId };
}

/**
 * The InstanceProfile ARN is `arn:aws:iam::<acct>:instance-profile/<name>`.
 * The role attached to the instance profile commonly shares the profile's
 * name in operator-managed boxes (Terraform default), and IAM only ties
 * one role to a profile. We surface both — `attach-iam` falls back to a
 * `iam:GetInstanceProfile` call when the names diverge.
 */
function deriveRoleNameFromInstanceProfileArn(arn: string | undefined): string | null {
  if (!arn) return null;
  const slash = arn.lastIndexOf('/');
  if (slash < 0 || slash === arn.length - 1) return null;
  return arn.slice(slash + 1);
}

async function isContainerized(
  io: ProvisionIO,
  log: (l: string) => void,
): Promise<{ hit: boolean; reason: string }> {
  if (await io.fs.exists('/.dockerenv')) {
    log('detect: /.dockerenv present → containerized');
    return { hit: true, reason: '/.dockerenv present' };
  }
  if (await io.fs.exists('/proc/1/cgroup')) {
    try {
      const cg = await io.fs.readFile('/proc/1/cgroup');
      if (/docker|containerd|kubepods/i.test(cg)) {
        log('detect: /proc/1/cgroup mentions container runtime → containerized');
        return { hit: true, reason: '/proc/1/cgroup container marker' };
      }
    } catch (err) {
      log(`detect: /proc/1/cgroup read failed (${(err as Error).message})`);
    }
  }
  return { hit: false, reason: '' };
}

async function isPm2OnEc2(
  io: ProvisionIO,
  log: (l: string) => void,
  imds: ImdsSnapshot,
): Promise<{ hit: boolean; reason: string }> {
  // pm2 list — exit 0 means PM2 is installed and responsive.
  const pm2 = await io.spawn('pm2', ['list']).catch((err: Error) => ({
    code: -1,
    stdout: '',
    stderr: err.message,
  }));
  if (pm2.code !== 0) {
    log(`detect: \`pm2 list\` exit ${pm2.code} — not pm2-on-ec2`);
    return { hit: false, reason: '' };
  }
  // EC2 confirmation: prefer IMDS, fall back to product_uuid prefix `EC2`.
  if (imds.instanceId) {
    log(`detect: pm2 + IMDS instance ${imds.instanceId} → pm2-on-ec2`);
    return { hit: true, reason: `pm2 + IMDS ${imds.instanceId}` };
  }
  try {
    const productUuid = (await io.fs.readFile('/sys/devices/virtual/dmi/id/product_uuid')).trim();
    if (/^EC2/i.test(productUuid)) {
      log(`detect: pm2 + product_uuid ${productUuid.slice(0, 8)}… → pm2-on-ec2`);
      return { hit: true, reason: `pm2 + product_uuid prefix EC2` };
    }
    log(`detect: pm2 ok but product_uuid (${productUuid.slice(0, 8)}…) lacks EC2 prefix`);
  } catch (err) {
    log(`detect: product_uuid unreadable (${(err as Error).message})`);
  }
  return { hit: false, reason: '' };
}

/** Run host detection and return the resolved `DetectedHost`. */
export async function detectHost(io: ProvisionIO, opts: DetectHostOptions): Promise<DetectedHost> {
  const log = opts.log ?? (() => {});
  const readEnv = opts.readEnv ?? ((k: string): string | undefined => process.env[k]);
  const readNodeEnv = opts.readNodeEnv ?? ((): string | undefined => process.env.NODE_ENV);
  const notes: string[] = [];

  // IMDS lookup is shared across pm2-on-ec2 detection AND attach-iam, so we
  // probe it once up front. Reachability == EC2; un-reachability is treated
  // as "not on AWS" (containerized hosts behind a NAT may also fail IMDS,
  // and that's fine — they classify on /.dockerenv).
  const imds = await readImds(io, (l) => {
    notes.push(l);
    log(l);
  });

  // 1) containerized
  const cont = await isContainerized(io, (l) => {
    notes.push(l);
    log(l);
  });
  if (cont.hit) {
    return {
      class: 'containerized',
      sitesAvailableDir: '/etc/nginx/conf.d',
      sitesEnabledDir: '/etc/nginx/conf.d',
      baseVhostPath: '/etc/nginx/conf.d/agent-hub-pr-env.conf',
      certPathFor: (h) => `/etc/letsencrypt/live/${h}/fullchain.pem`,
      keyPathFor: (h) => `/etc/letsencrypt/live/${h}/privkey.pem`,
      instanceRoleArn: imds.iamInfo?.InstanceProfileArn ?? null,
      instanceRoleName: deriveRoleNameFromInstanceProfileArn(imds.iamInfo?.InstanceProfileArn),
      instanceId: imds.instanceId ?? readEnv('EC2_INSTANCE_ID') ?? null,
      notes,
    };
  }

  // 2) pm2-on-ec2
  const pm2 = await isPm2OnEc2(
    io,
    (l) => {
      notes.push(l);
      log(l);
    },
    imds,
  );
  if (pm2.hit) {
    return {
      class: 'pm2-on-ec2',
      sitesAvailableDir: '/etc/nginx/sites-available',
      sitesEnabledDir: '/etc/nginx/sites-enabled',
      baseVhostPath: '/etc/nginx/sites-available/agent-hub-pr-env',
      certPathFor: (h) => `/etc/letsencrypt/live/${h}/fullchain.pem`,
      keyPathFor: (h) => `/etc/letsencrypt/live/${h}/privkey.pem`,
      instanceRoleArn: imds.iamInfo?.InstanceProfileArn ?? null,
      instanceRoleName: deriveRoleNameFromInstanceProfileArn(imds.iamInfo?.InstanceProfileArn),
      instanceId: imds.instanceId ?? readEnv('EC2_INSTANCE_ID') ?? null,
      notes,
    };
  }

  // 3) dev — only acceptable when NODE_ENV !== 'production'.
  const nodeEnv = readNodeEnv();
  if (nodeEnv === 'production') {
    notes.push(`detect: classification falls through to dev but NODE_ENV=production — refusing`);
    log(notes[notes.length - 1]!);
    throw new Error(
      'detect-host: could not classify host (no /.dockerenv, no pm2, no EC2 markers) and NODE_ENV=production',
    );
  }
  notes.push(`detect: dev fallback — nginx stubs under ${opts.devNginxStubDir}`);
  log(notes[notes.length - 1]!);
  return {
    class: 'dev',
    sitesAvailableDir: opts.devNginxStubDir,
    sitesEnabledDir: opts.devNginxStubDir,
    baseVhostPath: `${opts.devNginxStubDir}/agent-hub-pr-env.conf`,
    certPathFor: (h) => `${opts.devNginxStubDir}/${h}/fullchain.pem`,
    keyPathFor: (h) => `${opts.devNginxStubDir}/${h}/privkey.pem`,
    instanceRoleArn: imds.iamInfo?.InstanceProfileArn ?? null,
    instanceRoleName: deriveRoleNameFromInstanceProfileArn(imds.iamInfo?.InstanceProfileArn),
    instanceId: imds.instanceId ?? readEnv('EC2_INSTANCE_ID') ?? null,
    notes,
  };
}
