/**
 * PR-env wildcard cert renewal (W2).
 *
 * Thin wrapper around an ACME DNS-01 client (acme.sh or certbot — driven
 * by whichever binary the host has on PATH). Exposes two functions:
 *
 *   renewCertsDryRun(deps) — invokes the client with `--dry-run`. Safe to
 *     call from a scheduled heartbeat; does NOT touch live cert state.
 *   renewCerts(deps)       — real renewal. Writes new certs under the
 *     configured live-dir with owner-only permissions on the private key.
 *
 * Wildcard cert issuance uses DNS-01 because HTTP-01 can't prove control
 * of `*.preview.agenthub.dev`. The Route53 credentials come from
 * `config.json → prEnv.route53.{accessKeyId,secretAccessKey,hostedZoneId}`
 * (see `readPrEnvConfig` for how that block is threaded in). We redact
 * the creds from every log line — they're passed to the child process
 * via its env, not its argv.
 *
 * Why the indirection? The actual cert issuance is out-of-scope for W2
 * (see card). What we ship here is the **renewal path**: the first-issue
 * of the wildcard is an ops one-shot, but after that the cert needs to
 * be renewed every ~60 days and we want that renewal wired as a
 * first-class heartbeat so dashboard surfaces a red dot when it starts
 * failing (CTO risk #3).
 */

import { readFileSync } from 'fs';
import { X509Certificate } from 'crypto';
import type { PrEnvRuntimeConfig } from './pr-env-runtime.js';

/** Route53 credentials block required for DNS-01 against AWS. */
export interface Route53Creds {
  accessKeyId: string;
  secretAccessKey: string;
  hostedZoneId: string;
}

/**
 * Minimal child_process surface we need. Takes a command + args + env,
 * returns exit code + captured stderr for error messages. Tests inject
 * a fake; production wires it to `child_process.spawn`.
 */
export interface CertRunner {
  run(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface CertRenewalDeps {
  runner: CertRunner;
  /**
   * Which client to invoke. Default `'acme.sh'` — has first-class Route53
   * support without a separate python plugin. If the operator prefers
   * certbot, pass `'certbot'` and the runner will be invoked with the
   * `certbot-dns-route53` plugin instead.
   */
  client?: 'acme.sh' | 'certbot';
  /**
   * Absolute path to the client binary. Defaults to plain `acme.sh` or
   * `certbot` and relies on $PATH — tests override with a stub script.
   */
  binaryPath?: string;
  route53: Route53Creds;
  /**
   * Wildcard domain to renew, e.g. `*.preview.agenthub.dev`. Derived from
   * `previewBaseUrl` when called via the heartbeat wrapper.
   */
  wildcardDomain: string;
  /**
   * Where the client should place (or update) the renewed cert. We never
   * look inside this dir from Node — it's passed straight through to the
   * ACME client's `--cert-home` / `--config-dir` analog.
   */
  certHome: string;
}

export interface CertRenewalResult {
  ok: boolean;
  stdout: string;
  /**
   * Stderr with the raw creds masked. Always safe to log / write to the
   * heartbeat log table.
   */
  stderr: string;
  exitCode: number;
  /**
   * True iff the renewal produced new cert material. Dry-run never flips
   * this. We surface it to the heartbeat so an operator can tell a
   * "renewal not needed — cert still valid" from "cert was renewed".
   */
  renewed: boolean;
}

/**
 * Dry-run renewal. For certbot this uses the real `--dry-run` flag. For
 * acme.sh (which has no `--dry-run`) this uses `--staging` which issues a
 * real staging-CA cert — it validates the full DNS-01 flow but writes to
 * an isolated `<certHome>/staging` directory so production certs are not
 * affected. Exits 0 when the client is happy with its config (DNS
 * credentials valid, zone present, etc.). Safe to run as a heartbeat on
 * prod.
 */
export async function renewCertsDryRun(deps: CertRenewalDeps): Promise<CertRenewalResult> {
  return invokeClient(deps, { dryRun: true });
}

/**
 * Real renewal. Should only be called from the heartbeat after a dry-run
 * has been green for a while; we feature-flag the live call behind
 * `prEnv.certRenewalLive` so the first production rollout can ship with
 * dry-run only and flip later.
 */
export async function renewCerts(deps: CertRenewalDeps): Promise<CertRenewalResult> {
  return invokeClient(deps, { dryRun: false });
}

async function invokeClient(
  deps: CertRenewalDeps,
  opts: { dryRun: boolean },
): Promise<CertRenewalResult> {
  const client = deps.client ?? 'acme.sh';
  const binary = deps.binaryPath ?? client;
  const args = buildArgs(client, deps, opts);
  const env = buildEnv(client, deps);

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await deps.runner.run(binary, args, env);
  } catch (err) {
    // Binary missing / spawn failure — surface as a normal failure.
    const msg = (err as Error).message || String(err);
    return {
      ok: false,
      stdout: '',
      stderr: redact(deps.route53, `spawn failed: ${msg}`),
      exitCode: -1,
      renewed: false,
    };
  }

  const stderr = redact(deps.route53, result.stderr);
  const stdout = redact(deps.route53, result.stdout);
  // Client-specific positive markers only — avoid false positives from
  // messages like "cert not renewed because it is not due".
  // acme.sh: "Cert success!" / certbot: "Successfully received certificate"
  const renewed = !opts.dryRun && /Cert success!|Successfully received certificate/i.test(stdout);
  return {
    ok: result.code === 0,
    stdout,
    stderr,
    exitCode: result.code,
    renewed,
  };
}

function buildArgs(
  client: 'acme.sh' | 'certbot',
  deps: CertRenewalDeps,
  opts: { dryRun: boolean },
): string[] {
  if (client === 'acme.sh') {
    // acme.sh has no `--dry-run`; `--staging` issues a real cert from the
    // LE staging CA. We use a separate cert-home so staging material never
    // mixes with production certs.
    const certHome = opts.dryRun ? `${deps.certHome}/staging` : deps.certHome;
    const base = [
      '--renew',
      '-d',
      deps.wildcardDomain,
      '--dns',
      'dns_aws',
      '--server',
      'letsencrypt',
      '--cert-home',
      certHome,
    ];
    if (opts.dryRun) base.push('--staging');
    return base;
  }
  // certbot with the certbot-dns-route53 plugin. `certonly` + `--keep-until-expiring`
  // is a no-op when the cert is still valid, which makes this safe to
  // run on a daily heartbeat.
  const base = [
    'certonly',
    '--dns-route53',
    '-d',
    deps.wildcardDomain,
    '--non-interactive',
    '--agree-tos',
    '--keep-until-expiring',
    '--config-dir',
    deps.certHome,
  ];
  if (opts.dryRun) base.push('--dry-run');
  return base;
}

function buildEnv(client: 'acme.sh' | 'certbot', deps: CertRenewalDeps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Clear ambient AWS session/profile vars that could conflict with the
  // explicit creds we're about to set — e.g. an IAM role on the host
  // may have AWS_SESSION_TOKEN which the SDK would prefer over our keys.
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  // Both clients read AWS creds from env vars. Keep them here rather
  // than on argv so `ps auxe` doesn't leak them.
  env.AWS_ACCESS_KEY_ID = deps.route53.accessKeyId;
  env.AWS_SECRET_ACCESS_KEY = deps.route53.secretAccessKey;
  if (client === 'acme.sh') {
    env.AWS_HOSTED_ZONE_ID = deps.route53.hostedZoneId;
  }
  return env;
}

/**
 * Scrub AWS creds + hosted zone id from a string so the result is safe
 * to log. We redact the values (not the names) so an operator can still
 * tell *which* field was referenced in an error.
 */
function redact(route53: Route53Creds, text: string): string {
  if (!text) return '';
  let out = text;
  for (const secret of [route53.accessKeyId, route53.secretAccessKey, route53.hostedZoneId]) {
    if (!secret) continue;
    // Escape regex metachars — hosted zone ids can contain `/hostedzone/<id>` slashes.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '***REDACTED***');
  }
  return out;
}

/**
 * Derive the wildcard domain from the config's preview base URL.
 * `https://preview.agenthub.dev/pr-123/` → `*.preview.agenthub.dev`.
 * Exported for testability.
 */
export function wildcardDomainFromConfig(
  config: Pick<PrEnvRuntimeConfig, 'previewBaseUrl'>,
): string {
  try {
    const u = new URL(config.previewBaseUrl);
    const host = u.hostname.replace(/^\*\./, '');
    if (!host || host === 'localhost') {
      throw new Error(`previewBaseUrl "${config.previewBaseUrl}" is not a real host`);
    }
    return `*.${host}`;
  } catch (err) {
    throw new Error(
      `wildcardDomainFromConfig: could not parse previewBaseUrl "${config.previewBaseUrl}": ${(err as Error).message}`,
    );
  }
}

/**
 * Read a PEM cert file and return the number of days until it expires.
 * Returns `null` on any error (missing file, unparseable cert, etc.)
 * so callers can safely pass the result to `writeMetrics`.
 */
export function readCertDaysRemaining(certPath: string): number | null {
  try {
    const pem = readFileSync(certPath, 'utf-8');
    const cert = new X509Certificate(pem);
    const expiresMs = new Date(cert.validTo).getTime();
    const nowMs = Date.now();
    return (expiresMs - nowMs) / (1000 * 60 * 60 * 24);
  } catch {
    return null;
  }
}
