/**
 * Real `PrEnvExecutor` — composes the five phase adapters into the
 * stateful executor the orchestrator drives:
 *
 *   detect-host       → DetectedHost (kept for downstream phases)
 *   write-tier3-config→ certPath + nginx layout (kept for issue-cert / verify)
 *   issue-cert        → certbot subprocess
 *   attach-iam        → IAM SDK + copy-paste fallback (card kept for verify)
 *   verify            → six probe adapters; remediations emitted here only
 *
 * The composer is exposed as `createRealExecutor({...})` so the route
 * layer can still inject `stubExecutor` in tests, while production wires
 * the real adapters from one place.
 */

import type Database from 'better-sqlite3';
import type { DetectedHost } from './detect-host.js';
import { detectHost } from './detect-host.js';
import { writeTier3Config } from './write-tier3-config.js';
import { issueCert } from './issue-cert.js';
import { attachIam, type IamClient } from './attach-iam.js';
import { verifyPhase, type VerifyAdapters } from './verify.js';
import type { ProvisionIO } from './io.js';
import type { ExecutorPhaseResult, PrEnvExecutor, RemediationCard } from './orchestrator.js';

export interface RealExecutorOptions {
  io: ProvisionIO;
  /** Absolute path to `<dataDir>/config.json` — write-tier3-config target. */
  configPath: string;
  /** Dev-fallback nginx stub dir (also under dataDir). */
  devNginxStubDir: string;
  /** SQLite handle for DB-row backfill. Optional. */
  db?: Database.Database;
  /** IAM client. Production: lazy `@aws-sdk/client-iam`. Tests: stub. */
  iam?: IamClient | null;
  /** Whether the operator's saved row carries explicit AWS keys. */
  hasExplicitAwsCreds: boolean;
  /** Verify adapters — production passes the existing `defaultCheck*` set. */
  verifyAdapters: VerifyAdapters;
  /** GitHub Reviewer App — appId/installationId/privateKey or empty strings. */
  githubApp: { appId: string; installationId: string; privateKey: string };
  /** Saved Route 53 keys — empty strings when relying on instance role. */
  route53: { accessKeyId: string; secretAccessKey: string; hostedZoneId: string };
  /** Optional `process.env.NODE_ENV` override for detect-host's dev fallback gate. */
  readNodeEnv?: () => string | undefined;
  /** Optional `EC2_INSTANCE_ID` env reader. */
  readEnv?: (key: string) => string | undefined;
}

export function createRealExecutor(opts: RealExecutorOptions): PrEnvExecutor {
  let detected: DetectedHost | null = null;
  let certPath = '';
  let pendingIamCard: RemediationCard | undefined;

  return {
    async runPhase(phase, ctx): Promise<ExecutorPhaseResult> {
      switch (phase) {
        case 'detect-host': {
          try {
            detected = await detectHost(opts.io, {
              devNginxStubDir: opts.devNginxStubDir,
              readEnv: opts.readEnv,
              readNodeEnv: opts.readNodeEnv,
              log: ctx.log,
            });
            return {
              status: 'ok',
              message: `host class: ${detected.class}`,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              status: 'failed',
              message,
              error: {
                code: 1,
                message,
                hint: 'Run on a supported host (containerized / pm2-on-ec2 / dev).',
              },
            };
          }
        }

        case 'write-tier3-config': {
          if (!detected) {
            return {
              status: 'failed',
              message: 'detect-host did not run',
              error: { code: 1, message: 'detect-host did not run' },
            };
          }
          try {
            const result = await writeTier3Config({
              io: opts.io,
              detected,
              payload: { previewHost: ctx.payload.previewHost },
              configPath: opts.configPath,
              db: opts.db,
              log: ctx.log,
            });
            certPath = result.certPath;
            return {
              status: 'ok',
              message: `merged ${result.changedKeys} key${result.changedKeys === 1 ? '' : 's'} into config.json`,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              status: 'failed',
              message,
              error: { code: 1, message },
            };
          }
        }

        case 'issue-cert': {
          if (!detected) {
            return {
              status: 'failed',
              message: 'detect-host did not run',
              error: { code: 1, message: 'detect-host did not run' },
            };
          }
          // certPath was set by write-tier3-config; if that phase was skipped
          // (dryRun), fall back to the detected default so the skip-when-valid
          // probe still works.
          if (!certPath) certPath = detected.certPathFor(ctx.payload.previewHost);
          return await issueCert({
            io: opts.io,
            previewHost: ctx.payload.previewHost,
            certPath,
            operatorEmail: ctx.payload.operatorEmail,
            hostedZoneId: opts.route53.hostedZoneId || ctx.payload.hostedZoneId,
            log: ctx.log,
          });
        }

        case 'attach-iam': {
          if (!detected) {
            return {
              status: 'failed',
              message: 'detect-host did not run',
              error: { code: 1, message: 'detect-host did not run' },
            };
          }
          const result = await attachIam({
            detected,
            hasExplicitAwsCreds: opts.hasExplicitAwsCreds,
            iam: opts.iam ?? null,
            log: ctx.log,
          });
          if (result.card) pendingIamCard = result.card;
          // attach-iam never `failed`s; copy-paste is also `ok`.
          return { status: result.status, message: result.message };
        }

        case 'verify': {
          if (!detected) {
            return {
              status: 'failed',
              message: 'detect-host did not run',
              error: { code: 1, message: 'detect-host did not run' },
            };
          }
          return await verifyPhase({
            adapters: opts.verifyAdapters,
            nginxPaths: {
              sitesAvailableDir: detected.sitesAvailableDir,
              sitesEnabledDir: detected.sitesEnabledDir,
              baseVhostPath: detected.baseVhostPath,
            },
            certPath: certPath || detected.certPathFor(ctx.payload.previewHost),
            githubApp: opts.githubApp,
            route53: opts.route53,
            pendingRemediations: pendingIamCard ? [pendingIamCard] : undefined,
            log: ctx.log,
          });
        }
      }
    },
  };
}
