/**
 * Cert-renewal heartbeat wiring (W2).
 *
 * Glues the pure `cert-renewal.ts` module into the system-level cron
 * scheduler in `server/heartbeat.ts`. Responsibilities:
 *
 *   1. Read the current PR-env runtime config.
 *   2. Decide dry-run vs live based on `certRenewalLive`.
 *   3. Invoke the ACME client.
 *   4. Log the outcome (redacted of any Route53 credentials).
 *
 * The heartbeat itself is scheduled daily at 03:00 UTC — cert expiry
 * alarms don't need sub-day resolution, and running overnight avoids
 * contention with CI's morning wave. Keeping this in its own module
 * lets `scheduleAll` import a single `runCertRenewalHeartbeat()` call
 * without dragging the child_process spawn into the scheduler file.
 */

import { spawn } from 'child_process';
import {
  renewCerts,
  renewCertsDryRun,
  wildcardDomainFromConfig,
  type CertRenewalResult,
  type CertRunner,
} from './cert-renewal.js';
import type { PrEnvRuntimeConfig } from './pr-env-runtime.js';

/**
 * Default timeout for the ACME child process (10 minutes). DNS-01 with
 * Route53 can block for several minutes waiting on TXT propagation, but
 * anything beyond 10m likely means a stuck challenge or broken DNS.
 */
const CERT_RUNNER_TIMEOUT_MS = 10 * 60 * 1000;

/** Default ACME-client runner — spawns the binary with captured output + timeout. */
export const defaultCertRunner: CertRunner = {
  run(command, args, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, Array.from(args), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      let stdout = '';
      let stderr = '';
      let killed = false;

      // Timeout: SIGTERM first, then SIGKILL after 5s grace.
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 5_000);
      }, CERT_RUNNER_TIMEOUT_MS);

      proc.stdout?.on('data', (b) => (stdout += String(b)));
      proc.stderr?.on('data', (b) => (stderr += String(b)));
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({
            code: code ?? -1,
            stdout,
            stderr:
              stderr +
              `\n[agent-hub] process killed after ${CERT_RUNNER_TIMEOUT_MS / 1000}s timeout`,
          });
        } else {
          resolve({ code: code ?? -1, stdout, stderr });
        }
      });
    });
  },
};

export interface CertRenewalHeartbeatDeps {
  /**
   * The lazily-resolved runtime config. Passed by reference (rather than
   * captured at module load time) so a server restart-free config reload
   * picks up new values.
   */
  getConfig: () => PrEnvRuntimeConfig | null;
  /** ACME client runner — injectable for tests. */
  runner?: CertRunner;
  /** Optional logger — defaults to `console`. */
  logger?: {
    log: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Run one cert-renewal tick. Returns the client result on success, or
 * null when the feature is disabled (config not present). Never throws —
 * scheduler callers want a best-effort tick with a logged failure, not
 * an unhandled rejection killing the node-cron callback.
 */
export async function runCertRenewalHeartbeat(
  deps: CertRenewalHeartbeatDeps,
): Promise<CertRenewalResult | null> {
  const config = deps.getConfig();
  const logger = deps.logger ?? {
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  };
  if (!config) {
    logger.log('[cert-renewal] skipped — prEnv feature is disabled');
    return null;
  }

  let wildcardDomain: string;
  try {
    wildcardDomain = wildcardDomainFromConfig(config);
  } catch (err) {
    logger.error(`[cert-renewal] config error: ${(err as Error).message}`);
    return {
      ok: false,
      stdout: '',
      stderr: (err as Error).message,
      exitCode: -1,
      renewed: false,
    };
  }

  const runner = deps.runner ?? defaultCertRunner;
  const certDeps = {
    runner,
    route53: config.route53,
    wildcardDomain,
    certHome: config.nginx.certHome,
  };

  const dryRun = !config.certRenewalLive;
  logger.log(`[cert-renewal] tick (${dryRun ? 'dry-run' : 'live'}) for ${wildcardDomain}`);

  const result = dryRun ? await renewCertsDryRun(certDeps) : await renewCerts(certDeps);

  if (result.ok) {
    logger.log(
      `[cert-renewal] ${dryRun ? 'dry-run' : 'renewal'} succeeded` +
        (result.renewed ? ' — new cert material written' : ''),
    );
  } else {
    logger.error(
      `[cert-renewal] failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

/** Cron expression for the heartbeat — exported for tests. */
export const CERT_RENEWAL_CRON = '0 3 * * *';
