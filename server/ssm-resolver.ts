/**
 * SSM Parameter Store reference resolver for PR-env project env vars.
 *
 * Operators can put `${ssm:/path/to/param}` in `prEnv.env.<KEY>` (in
 * `projects.json` or via the future Settings UI) instead of pasting
 * plaintext secrets. At PR-env build time the builder calls
 * `resolveSsmRefs` to swap each reference for the parameter's actual
 * (decrypted) value before docker-run pairs are built.
 *
 * Constraints (matched by the validator in `routes/projects.ts`):
 *   - Only full single-token references are accepted: the entire value
 *     must match `^\${ssm:/[A-Za-z0-9_./-]+}$`. Mixed literal + ref
 *     strings (e.g. `prefix-${ssm:/x}`) are out of scope and rejected
 *     by the validator. Resolution mirrors that contract.
 *   - The validator runs first, so if a malformed ref still reaches
 *     here we treat it as a literal value (no replacement attempted),
 *     never as a parameter name. That matches the "resolve only known
 *     refs" intent.
 *
 * Caching: parameter values are cached in-process for 60 s keyed by
 * parameter name to avoid hammering SSM during rapid PR-env rebuilds
 * (e.g. `pull_request.synchronize` storms). The TTL is intentionally
 * short — a parameter rotation surfaces within a minute without a
 * server restart.
 *
 * Errors: any unresolved reference (missing parameter, AccessDenied,
 * etc.) throws a descriptive error. The pr-env-builder funnels that
 * into the existing failure-logging / rollback path.
 */

import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

/** Anchored full-token SSM reference. Mirrors the validator regex. */
const SSM_REF_RE = /^\$\{ssm:(\/[A-Za-z0-9_./-]+)\}$/;

const CACHE_TTL_MS = 60_000;
const SSM_BATCH_SIZE = 10; // GetParameters hard limit.

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

let clientSingleton: SSMClient | null = null;

function getClient(): SSMClient {
  if (clientSingleton) return clientSingleton;
  const region = process.env.AWS_REGION || 'us-east-2';
  clientSingleton = new SSMClient({ region });
  return clientSingleton;
}

/**
 * Test-only escape hatch. Lets the test file inject a fake `SSMClient`
 * (e.g. one whose `.send()` returns hand-rolled responses) without
 * needing a network or real AWS creds. Production code must not call
 * this. Setting `null` reverts to the lazy default.
 */
export function __setSsmClientForTests(client: SSMClient | null): void {
  clientSingleton = client;
}

/** Test-only: clear the in-memory parameter cache between cases. */
export function __clearSsmCacheForTests(): void {
  cache.clear();
}

/**
 * Try to extract the parameter name from a value. Returns the name
 * (with leading `/`) on a match, or `null` if the value is a plain
 * literal that should pass through unchanged.
 */
function parseRef(value: string): string | null {
  const m = SSM_REF_RE.exec(value);
  return m ? m[1] : null;
}

/**
 * Resolve any `${ssm:/...}` references in `env` by fetching their
 * decrypted values from SSM Parameter Store. Returns a NEW object —
 * the input is not mutated.
 *
 * Plain string values pass through unchanged. References are resolved
 * via batched `GetParameters` calls (max 10 names per call) with
 * `WithDecryption: true`. A 60 s in-process cache shields SSM from
 * rapid rebuild loops.
 *
 * Throws when any referenced parameter cannot be resolved (missing,
 * AccessDenied, throttled, malformed response). The error message
 * names the failing parameter so operators can fix the project config.
 */
export async function resolveSsmRefs(env: Record<string, string>): Promise<Record<string, string>> {
  // First pass: figure out which entries are refs and gather the unique
  // set of parameter names we still need to fetch (cache miss / expired).
  const refByEnvKey: Record<string, string> = {};
  const namesToFetch = new Set<string>();
  const now = Date.now();

  for (const [key, value] of Object.entries(env)) {
    const paramName = parseRef(value);
    if (paramName === null) continue;
    refByEnvKey[key] = paramName;
    const cached = cache.get(paramName);
    if (!cached || cached.expiresAt <= now) {
      namesToFetch.add(paramName);
    }
  }

  // Fast path: nothing to resolve, return a shallow copy.
  if (Object.keys(refByEnvKey).length === 0) {
    return { ...env };
  }

  if (namesToFetch.size > 0) {
    await fetchAndCache(Array.from(namesToFetch));
  }

  // Second pass: build the resolved map. Cache must be populated for
  // every ref now (fetch errors would have thrown above).
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const paramName = refByEnvKey[key];
    if (paramName === undefined) {
      out[key] = value;
      continue;
    }
    const cached = cache.get(paramName);
    if (!cached) {
      // Defensive — `fetchAndCache` is supposed to populate or throw.
      throw new Error(`SSM reference for env "${key}" (${paramName}) was not resolved`);
    }
    out[key] = cached.value;
  }
  return out;
}

/**
 * Fetch the given parameter names from SSM in batches of 10, populate
 * the cache, and throw if any name failed to resolve.
 */
async function fetchAndCache(names: string[]): Promise<void> {
  const client = getClient();
  const expiresAt = Date.now() + CACHE_TTL_MS;
  const invalid: string[] = [];

  for (let i = 0; i < names.length; i += SSM_BATCH_SIZE) {
    const batch = names.slice(i, i + SSM_BATCH_SIZE);
    const resp = await client.send(
      new GetParametersCommand({
        Names: batch,
        WithDecryption: true,
      }),
    );
    for (const p of resp.Parameters ?? []) {
      if (typeof p.Name === 'string' && typeof p.Value === 'string') {
        cache.set(p.Name, { value: p.Value, expiresAt });
      }
    }
    for (const n of resp.InvalidParameters ?? []) {
      invalid.push(n);
    }
  }

  if (invalid.length > 0) {
    throw new Error(
      `Failed to resolve SSM parameter(s): ${invalid.join(', ')}. ` +
        `Verify the parameter exists in this region and the EC2 instance ` +
        `role grants ssm:GetParameters (with kms:Decrypt for SecureString).`,
    );
  }

  // Sanity: make sure every requested name is now cached. If SSM
  // silently dropped a name (shouldn't happen — it would be in
  // InvalidParameters) we surface a clear error instead of returning
  // a stale value.
  for (const n of names) {
    const entry = cache.get(n);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new Error(`SSM parameter "${n}" was requested but not returned by GetParameters`);
    }
  }
}
