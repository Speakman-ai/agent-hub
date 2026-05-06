/**
 * `issue-cert` adapter.
 *
 * Wraps the certbot subprocess invocation:
 *
 *   certbot certonly --dns-route53 \
 *     --dns-route53-propagation-seconds 30 \
 *     -d "*.<previewHost>" -d "<previewHost>" \
 *     --non-interactive --agree-tos \
 *     --email <operatorEmail | admin@<previewHost>>
 *
 * Idempotency: when `certPath` already exists and parses as an X.509 with
 * `validTo` more than 30 days out, the adapter returns
 * `status: 'skipped'` per the wizard spec — `skipped` counts as a green
 * outcome.
 *
 * Failures emit `status: 'failed'` with the full last-50 lines of stderr
 * surfaced as `error.message` so the remediation card the orchestrator
 * downstream renders has actionable copy. The phase contract in the
 * spec requires this to look identical to a manual operator run.
 */

import { X509Certificate } from 'crypto';
import type { ProvisionIO } from './io.js';
import type { ExecutorPhaseResult } from './orchestrator.js';

export interface IssueCertOptions {
  io: ProvisionIO;
  /** Wildcard cert target host. */
  previewHost: string;
  /** Resolved cert path from `write-tier3-config`. */
  certPath: string;
  /** ACME contact email — wizard payload override or default. */
  operatorEmail?: string;
  /** Hosted zone id (currently informational; certbot reads creds from env). */
  hostedZoneId: string;
  /** Optional certbot-binary override. Tests pass a script path. */
  certbotBin?: string;
  /** Passes through to ctx.log so progress shows up live. */
  log?: (line: string) => void;
}

const SKIP_THRESHOLD_DAYS = 30;
const KEEP_LAST_STDERR_LINES = 50;

/** Derive the LE contact when the operator didn't override. */
function defaultEmailFor(host: string): string {
  return `admin@${host}`;
}

function tail(buffer: string, n: number): string {
  const lines = buffer.split(/\r?\n/);
  return lines.slice(-n).join('\n').trim();
}

export async function issueCert(opts: IssueCertOptions): Promise<ExecutorPhaseResult> {
  const log = opts.log ?? (() => {});
  const certbot = opts.certbotBin ?? 'certbot';
  const previewHost = opts.previewHost.trim();
  if (!previewHost) {
    return {
      status: 'failed',
      message: 'previewHost is required',
      error: { code: 1, message: 'issue-cert: previewHost is required' },
    };
  }
  const email = opts.operatorEmail?.trim() || defaultEmailFor(previewHost);

  // Skip-when-already-valid guard.
  if (await opts.io.fs.exists(opts.certPath)) {
    try {
      const pem = await opts.io.fs.readFile(opts.certPath);
      const cert = new X509Certificate(pem);
      const validTo = Date.parse(cert.validTo);
      if (!Number.isNaN(validTo)) {
        const daysLeft = Math.floor((validTo - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft > SKIP_THRESHOLD_DAYS) {
          const message = `cert valid for ${daysLeft} more days; nothing to do`;
          log(`issue-cert: ${message}`);
          return { status: 'skipped', message };
        }
        log(
          `issue-cert: existing cert expires in ${daysLeft}d (≤${SKIP_THRESHOLD_DAYS}d) — re-issuing`,
        );
      } else {
        log('issue-cert: existing cert has unparseable expiry — re-issuing');
      }
    } catch (err) {
      log(
        `issue-cert: existing cert at ${opts.certPath} unreadable (${(err as Error).message}) — re-issuing`,
      );
    }
  } else {
    log(`issue-cert: no cert at ${opts.certPath}; running certbot`);
  }

  const args = [
    'certonly',
    '--dns-route53',
    '--dns-route53-propagation-seconds',
    '30',
    '-d',
    `*.${previewHost}`,
    '-d',
    previewHost,
    '--non-interactive',
    '--agree-tos',
    '--email',
    email,
  ];
  log(`issue-cert: ${certbot} ${args.join(' ')}`);

  const env = { ...process.env };
  // Hosted zone id is implicit from the AWS creds; certbot resolves the
  // zone via Route 53 List/Get itself. We only thread it through for log
  // breadcrumbs ("running against zone <id>").
  env.AGENT_HUB_PR_ENV_HOSTED_ZONE_ID = opts.hostedZoneId;

  const result = await opts.io.spawn(certbot, args, {
    env,
    onStdoutLine: (line) => log(`certbot: ${line}`),
    onStderrLine: (line) => log(`certbot[err]: ${line}`),
  });

  if (result.code === 0) {
    return { status: 'ok', message: 'certbot issued cert' };
  }

  // -1 (failed-to-spawn) is the canonical "binary missing" signal — give
  // the operator the actionable hint surface here so the remediation card
  // can stay short.
  if (result.code === -1 && /not found|ENOENT/i.test(result.stderr)) {
    return {
      status: 'failed',
      message: `certbot binary not found at ${certbot}`,
      error: {
        code: 127,
        message: `certbot binary not found at ${certbot}`,
        hint: 'Install certbot + the route53 plugin (`yum install -y certbot python3-certbot-route53` on AL2023).',
      },
    };
  }

  const stderrTail = tail(result.stderr, KEEP_LAST_STDERR_LINES);
  return {
    status: 'failed',
    message: `certbot exited ${result.code}`,
    error: {
      code: result.code === -1 ? 1 : result.code,
      message: stderrTail || `certbot exited ${result.code} with no stderr`,
      hint: 'Most common cause: missing route53:GetHostedZone / ListHostedZones on the EC2 instance role. attach-iam will surface a fix; run the wizard again after that lands.',
    },
  };
}
