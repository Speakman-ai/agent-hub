/**
 * AWS Secrets Manager helpers for Agent Hub.
 *
 * Currently surfaces a single named secret — the per-user `ahub_*` API key
 * provisioned on the dev hub (`agenthub.dev.surveytracker.io`) and stored at
 * `agent-hub/dev-hub/api-key`.  Extend this module if more per-environment
 * secrets are provisioned in the future.
 *
 * ## Caching
 * Secret values are cached in-process for `CACHE_TTL_MS` (default 5 minutes).
 * A `PutSecretValue` rotation therefore surfaces within one TTL window without
 * a server restart.  The TTL is intentionally longer than SSM's 60 s window
 * because Secrets Manager imposes per-second API quotas; a minute-level cache
 * would hammer the endpoint on a busy server.
 *
 * ## Credentials
 * The helper uses the default AWS credential chain (environment variables →
 * ECS task role → EC2 instance profile).  On the dev EC2 host the instance
 * role must carry `secretsmanager:GetSecretValue` on the ARN
 * `arn:aws:secretsmanager:us-east-2:120569607241:secret:agent-hub/dev-hub/api-key-*`
 * (wildcard suffix because AWS appends a 6-char rotation ID to secret ARNs).
 * See `ops/terraform/ssm-iam.tf` for the Terraform resource.
 *
 * ## Label gate
 * The server reads this secret ONLY for sessions whose kanban card carries one
 * of the opt-in labels `cross-hub:dev` or `survey-tracker`.  Sessions without
 * those labels never trigger a `GetSecretValue` call and never receive
 * `DEV_HUB_API_KEY` in their spawn environment.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// ─── Configuration ────────────────────────────────────────────────────────────

const SECRET_NAME = 'agent-hub/dev-hub/api-key';
const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

// ─── In-process cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  /** `null` when negatively cached (AWS error / empty secret). */
  value: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// ─── Client singleton ─────────────────────────────────────────────────────────

let clientSingleton: SecretsManagerClient | null = null;

function getClient(): SecretsManagerClient {
  if (clientSingleton) return clientSingleton;
  const region = process.env.AWS_REGION || 'us-east-2';
  clientSingleton = new SecretsManagerClient({ region });
  return clientSingleton;
}

// ─── Test-only escape hatches ─────────────────────────────────────────────────

/**
 * Inject a fake `SecretsManagerClient` for unit tests.
 * Pass `null` to revert to the lazy production singleton.
 * Production code must not call this.
 */
export function __setSecretsClientForTests(client: SecretsManagerClient | null): void {
  clientSingleton = client;
}

/** Clear the in-process cache between test cases. */
export function __clearSecretsCacheForTests(): void {
  cache.clear();
}

// ─── Label gate ───────────────────────────────────────────────────────────────

/**
 * Labels (comma-separated card `labels` string) that opt a session into
 * receiving `DEV_HUB_API_KEY` in its spawn env.
 */
const CROSS_HUB_LABELS = new Set(['cross-hub:dev', 'survey-tracker']);

/**
 * Return true when the card's label string contains at least one of the
 * registered cross-hub opt-in labels.  Comparison is case-insensitive so
 * `Cross-Hub:Dev` and `cross-hub:dev` both match.
 */
export function cardNeedsDevHubKey(labels: string | null | undefined): boolean {
  if (!labels) return false;
  return labels
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .some((l) => CROSS_HUB_LABELS.has(l));
}

// ─── Secret fetch ─────────────────────────────────────────────────────────────

/** TTL for negative-cache entries (AWS errors / empty secret). Shorter than
 *  the success TTL so recovery after IAM fixes surfaces quickly, but still
 *  long enough to absorb a burst of labelled cards in one dispatch loop. */
const NEGATIVE_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Fetch the dev-hub API key from AWS Secrets Manager, returning a cached
 * value when available.
 *
 * Returns `null` when:
 *   - The secret value is empty or non-string.
 *   - AWS returns an error (AccessDenied, ResourceNotFound, throttle, etc.).
 *     The error is logged but NOT re-thrown so callers can proceed
 *     unauthenticated rather than crashing the dispatch loop.
 *
 * Both success and failure results are cached: success for `CACHE_TTL_MS`
 * (5 min), failure for `NEGATIVE_CACHE_TTL_MS` (30 s). The negative cache
 * prevents a thundering-herd of AWS calls when the IAM grant or secret is
 * broken — a burst of N labelled cards in one dispatch loop issues at most
 * one `GetSecretValue` call during the negative-TTL window.
 */
export async function getDevHubApiKey(): Promise<string | null> {
  const now = Date.now();
  const cached = cache.get(SECRET_NAME);
  if (cached && cached.expiresAt > now) {
    return cached.value; // may be null when negatively cached
  }

  try {
    const client = getClient();
    const resp = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const raw = resp.SecretString ?? '';
    if (!raw) {
      console.warn(`[secrets] ${SECRET_NAME}: returned empty SecretString; skipping injection`);
      // Negative-cache so repeated dispatches don't each hit AWS.
      cache.set(SECRET_NAME, { value: null, expiresAt: now + NEGATIVE_CACHE_TTL_MS });
      return null;
    }
    const value = raw.trim();
    cache.set(SECRET_NAME, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Negative-cache so a burst of labelled cards on a broken IAM/secret
    // doesn't spray N identical GetSecretValue calls to AWS.
    cache.set(SECRET_NAME, { value: null, expiresAt: now + NEGATIVE_CACHE_TTL_MS });
    // v2 structured TOOL_ERROR log (minable by Session Health tooling).
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | secrets | GetSecretValue ${SECRET_NAME} | aws-error | ${errMsg.replace(/[\r\n|]+/g, ' ').slice(0, 200)} | ${JSON.stringify({ v: 2, sev: 'soft', resolution: 'unresolved', tags: ['secrets-manager', 'aws'] })}`,
    );
    return null;
  }
}
