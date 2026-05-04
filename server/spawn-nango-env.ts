/**
 * spawn-nango-env.ts — Resolve the per-user Nango override that
 * `buildSpawnEnv` injects into agent spawn environments.
 *
 * Lives outside `chat.ts` so it can be unit-tested without spinning up
 * a full chat session. Mirrors the structure of the per-user Claude
 * credential resolver (`buildSpawnEnv` in `config.ts` + the chat.ts
 * `userOverride` lookup). See:
 *   - server/integrations/nango-adapter.ts
 *   - server/integration-provider-runtime.ts
 *   - server/user-integrations-store.ts
 *
 * The resolver is owner-scoped: the connection map only ever contains
 * rows belonging to `ownerUserId`. Cross-user leakage is therefore
 * structurally impossible — the only knobs are "what does the owner
 * have connected" and "is the IntegrationProvider configured".
 */

import type { NangoSpawnOverride } from './config.js';
import { getIntegrationProviderConfig } from './integration-provider-runtime.js';
import { listForUser as listUserIntegrations } from './user-integrations-store.js';

/**
 * Build the per-spawn Nango override for a session owner, or `null`
 * when the env vars should be omitted entirely.
 *
 * Returns `null` when:
 *   - `ownerUserId` is empty / null (anonymous / system spawn).
 *   - The IntegrationProvider isn't configured (no shared key, no BYO
 *     secret, or `enabled = false`).
 *   - The provider config has no usable secret key.
 *
 * Returns a populated override (with possibly empty `connections`)
 * when the provider IS configured but the user has no connections —
 * downstream callers can still hit `proxyCall` for any future
 * connections without rebuilding the spawn env.
 */
export function resolveNangoSpawnOverride(ownerUserId: string | null): NangoSpawnOverride | null {
  if (!ownerUserId) return null;
  const resolved = getIntegrationProviderConfig();
  if (!resolved.ok || !resolved.secretKey) return null;
  const rows = listUserIntegrations(ownerUserId);
  const connections: Record<string, string> = {};
  for (const row of rows) {
    // Only surface connections that completed OAuth — PENDING /
    // ERROR / REVOKED would hand the agent a connection_id Nango
    // would reject and produce a confusing spawn-time auth error.
    if (row.status === 'CONNECTED') {
      connections[row.app] = row.connectionId;
    }
  }
  return {
    secretKey: resolved.secretKey,
    providerBaseUrl: resolved.baseUrl,
    connections,
  };
}
