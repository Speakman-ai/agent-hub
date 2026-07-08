/**
 * replay-lifecycle-s3.ts — SDK-backed port + boot provisioning for the RUM S3
 * lifecycle policy. The AWS SDK import is confined here (mirrors the
 * SDK-isolation of `artifacts/artifact-store-s3.ts`); the policy math lives in
 * the pure `replay-lifecycle.ts`.
 *
 * The Hub's instance/task role needs `s3:GetLifecycleConfiguration` +
 * `s3:PutLifecycleConfiguration` on the artifacts bucket for provisioning to
 * succeed. It is best-effort at boot: a missing permission logs a warning and is
 * NOT fatal (the segment store keeps working; bytes just won't auto-expire until
 * the policy is applied out of band).
 */
import {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
} from '@aws-sdk/client-s3';
import type { PutBucketLifecycleConfigurationCommandInput } from '@aws-sdk/client-s3';
import type { AppConfig } from '../types.js';
import {
  applyRumLifecyclePolicy,
  type ApplyRumLifecycleResult,
  type LifecycleRule,
  type LifecycleS3Port,
} from './replay-lifecycle.js';

/**
 * Build a `LifecycleS3Port` bound to a bucket. `NoSuchLifecycleConfiguration`
 * (the bucket simply has no policy yet) is normalized to an empty rule set so the
 * first provisioning is an ordinary create. An empty PUT clears the config via
 * DeleteBucketLifecycle (S3 rejects a PUT with zero rules).
 */
export function createS3LifecyclePort(opts: {
  bucket: string;
  region?: string | null;
  client?: S3Client;
}): LifecycleS3Port {
  const client = opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
  const bucket = opts.bucket;

  return {
    async getBucketLifecycleRules(): Promise<LifecycleRule[]> {
      try {
        const res = await client.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
        );
        return (res.Rules ?? []) as LifecycleRule[];
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchLifecycleConfiguration') return [];
        throw err;
      }
    },
    async putBucketLifecycleRules(rules: LifecycleRule[]): Promise<void> {
      if (rules.length === 0) {
        await client.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
        return;
      }
      const LifecycleConfiguration = {
        Rules: rules,
      } as unknown as PutBucketLifecycleConfigurationCommandInput['LifecycleConfiguration'];
      await client.send(
        new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration }),
      );
    },
  };
}

export interface ProvisionRumLifecycleDeps {
  config: AppConfig;
  /** Injectable port for tests; defaults to a real S3 port from config. */
  port?: LifecycleS3Port;
  log?: (msg: string) => void;
}

export interface ProvisionRumLifecycleOutcome {
  /** `false` when there is no S3 bucket (local storage → no lifecycle to apply). */
  applied: boolean;
  /**
   * `true` iff the desired lifecycle policy is CONFIRMED in place on S3 (applied
   * with no error). This is the signal the retention sweeper gates S3 byte
   * delegation on: only when confirmed does it trust lifecycle to expire the
   * bytes and drop just the index row. `false` for local storage and for any
   * failed/partial provisioning.
   */
  provisioned: boolean;
  result?: ApplyRumLifecycleResult;
  error?: string;
}

/**
 * Provision the RUM lifecycle policy from config. No-op (applied:false) on local
 * storage. Best-effort on S3: a failed GET/PUT (e.g. missing IAM permission) is
 * caught, logged, and returned as `error` rather than thrown, so boot never
 * crashes on a lifecycle-permission gap.
 */
export async function provisionRumLifecycle(
  deps: ProvisionRumLifecycleDeps,
): Promise<ProvisionRumLifecycleOutcome> {
  const { config } = deps;
  const log = deps.log ?? ((msg: string) => console.error(msg));

  const bucket = config.artifactsBucket;
  if (!bucket) {
    // Local artifact store: there is no S3 lifecycle. Byte reclamation for local
    // segments stays the app sweeper's job.
    return { applied: false, provisioned: false };
  }

  const port = deps.port ?? createS3LifecyclePort({ bucket, region: config.artifactsBucketRegion });

  try {
    const result = await applyRumLifecyclePolicy(port, {
      retentionDays: config.replayRetentionDays,
    });
    if (result.changed) {
      log(
        `[replay-lifecycle] provisioned RUM lifecycle on ${bucket}: ` +
          `${result.managedRuleCount} managed rule(s), ${result.ruleCount} total`,
      );
    }
    // Success ⇒ the desired policy is confirmed on the bucket, so the sweeper may
    // now delegate S3 byte expiry to lifecycle.
    return { applied: true, provisioned: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `[replay-lifecycle] failed to provision RUM lifecycle on ${bucket} ` +
        `(need s3:Get/PutLifecycleConfiguration): ${message}`,
    );
    // Unconfirmed ⇒ the sweeper must keep deleting S3 bytes itself (no orphans).
    return { applied: true, provisioned: false, error: message };
  }
}
