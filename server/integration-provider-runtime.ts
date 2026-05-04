/**
 * Runtime resolver for the active integration-provider configuration.
 *
 * Callers that need to *use* Nango (Slack/Google/GitHub OAuth, agent
 * spawn-time env injection, webhook verification) ask this module for
 * the concrete config. It merges three layers:
 *
 *   1. **`integration_providers` DB row** (canonical for `mode`, `provider`,
 *      `providerBaseUrl`, BYO secrets and the `enabled` flag).
 *   2. **Process env**: `HUB_SHARED_NANGO_KEY` substitutes the secret
 *      when `mode = 'shared'`. The DB never holds the shared key — the
 *      substitution happens *here*, on read. An exfiltrated `orgs.db`
 *      therefore carries no shared credentials.
 *   3. **`config.json` fallback**: legacy `nango.secretKey` /
 *      `nango.baseUrl` blocks are still honoured when the DB row is
 *      empty / unconfigured. This keeps existing dev installs working
 *      without a forced migration step.
 *
 * Returned shape is intentionally narrow — only what callers actually
 * need. The masked metadata used by the Settings UI is *not* exposed
 * here; that lives in `readIntegrationProviderMasked`.
 *
 * If the resolver can't produce a usable secret it returns
 * `{ ok: false, reason }` rather than throwing — callers can render a
 * "Connect Slack disabled — operator hasn't configured Nango" notice
 * instead of crashing.
 */

import { fileConfig } from './config.js';
import {
  readIntegrationProviderRow,
  sharedNangoKeyAvailable,
  type IntegrationProviderId,
  type IntegrationProviderMode,
} from './integration-provider-store.js';

export interface ResolvedIntegrationProvider {
  ok: true;
  mode: IntegrationProviderMode;
  provider: IntegrationProviderId;
  /** Plaintext Nango secret key, ready to use as `Authorization: Bearer …`. */
  secretKey: string;
  /** Provider API base URL (defaults to `https://api.nango.dev`). */
  baseUrl: string;
  /** Webhook signing secret. Empty string when none configured. */
  webhookSecret: string;
  enabled: boolean;
  source: 'db' | 'config-file' | 'env';
}

export interface UnresolvedIntegrationProvider {
  ok: false;
  reason: 'shared-mode-missing-env' | 'byo-mode-missing-secret' | 'disabled' | 'no-config';
  mode: IntegrationProviderMode;
  provider: IntegrationProviderId;
  baseUrl: string;
}

export type IntegrationProviderResolution =
  | ResolvedIntegrationProvider
  | UnresolvedIntegrationProvider;

const DEFAULT_NANGO_BASE_URL = 'https://api.nango.dev';

interface FileNangoBlock {
  secretKey?: string;
  baseUrl?: string;
  webhookSecret?: string;
}

/**
 * Read `config.json`'s legacy `nango` block. Returns `{}` when absent
 * or malformed — callers fall through to the empty-default behaviour.
 */
function readFileNangoBlock(): FileNangoBlock {
  // `config.ts` parses `~/.agent-hub/data/config.json` once at boot and
  // exports the parsed JSON as the named binding `fileConfig`. We
  // re-resolve on every call because `config.ts` reassigns the binding
  // at startup (let, not const) and tests mutate it directly.
  const fileBlock = fileConfig?.nango;
  if (!fileBlock || typeof fileBlock !== 'object') return {};
  const block = fileBlock as FileNangoBlock;
  return {
    secretKey: typeof block.secretKey === 'string' ? block.secretKey : undefined,
    baseUrl: typeof block.baseUrl === 'string' ? block.baseUrl : undefined,
    webhookSecret: typeof block.webhookSecret === 'string' ? block.webhookSecret : undefined,
  };
}

/**
 * Resolve the active integration-provider configuration.
 *
 * Priority for the secret:
 *   - `mode = shared` → `process.env.HUB_SHARED_NANGO_KEY`
 *   - `mode = byo`    → DB row's `secretKey` (decrypted)
 *                       └─ falls back to `config.json` `nango.secretKey`
 *                          when the DB row is empty (legacy dev installs)
 *
 * The `source` tag lets callers log *where* the secret came from
 * without exposing it to the response payload.
 */
export function getIntegrationProviderConfig(): IntegrationProviderResolution {
  let row;
  try {
    row = readIntegrationProviderRow();
  } catch {
    // orgs.db not initialized (test harness, mid-boot). Fall through
    // to a synthetic row so the resolver still produces a sensible
    // shape — `config.json` may still carry a usable secret.
    row = null;
  }

  const mode: IntegrationProviderMode = row?.mode ?? 'shared';
  const provider: IntegrationProviderId = row?.provider ?? 'nango-cloud';
  const fileBlock = readFileNangoBlock();
  const baseUrl =
    (row?.providerBaseUrl && row.providerBaseUrl.length > 0 ? row.providerBaseUrl : null) ||
    fileBlock.baseUrl ||
    DEFAULT_NANGO_BASE_URL;
  const enabled = row?.enabled ?? true;

  if (!enabled) {
    return { ok: false, reason: 'disabled', mode, provider, baseUrl };
  }

  if (mode === 'shared') {
    const sharedKey = process.env.HUB_SHARED_NANGO_KEY ?? '';
    if (!sharedKey) {
      return { ok: false, reason: 'shared-mode-missing-env', mode, provider, baseUrl };
    }
    return {
      ok: true,
      mode,
      provider,
      secretKey: sharedKey,
      baseUrl,
      // Shared installs may pin a webhook secret in env too — kept
      // separate from the BYO ciphertext path so neither bleeds into
      // the other.
      webhookSecret: process.env.HUB_SHARED_NANGO_WEBHOOK_SECRET ?? '',
      enabled,
      source: 'env',
    };
  }

  // BYO mode
  const dbSecret = row?.secretKey ?? '';
  if (dbSecret) {
    return {
      ok: true,
      mode,
      provider,
      secretKey: dbSecret,
      baseUrl,
      webhookSecret: row?.webhookSecret ?? '',
      enabled,
      source: 'db',
    };
  }

  if (fileBlock.secretKey) {
    return {
      ok: true,
      mode,
      provider,
      secretKey: fileBlock.secretKey,
      baseUrl,
      webhookSecret: fileBlock.webhookSecret ?? '',
      enabled,
      source: 'config-file',
    };
  }

  return { ok: false, reason: 'byo-mode-missing-secret', mode, provider, baseUrl };
}

/**
 * Convenience: returns true when the resolver would succeed today. UI
 * surfaces use this to gate "Connect Slack" / "Connect Google" buttons.
 */
export function isIntegrationProviderReady(): boolean {
  return getIntegrationProviderConfig().ok;
}

/**
 * Surface metadata that's safe to expose to callers without
 * impersonation risk. Used by the per-user Settings → Integrations
 * page (NOT the admin route) so users see *that* connect is possible
 * without seeing the secret or the operator's mode toggle.
 */
export function getIntegrationProviderPublicInfo(): {
  ready: boolean;
  mode: IntegrationProviderMode;
  provider: IntegrationProviderId;
  baseUrl: string;
  sharedAvailable: boolean;
} {
  const r = getIntegrationProviderConfig();
  return {
    ready: r.ok,
    mode: r.mode,
    provider: r.provider,
    baseUrl: r.baseUrl,
    sharedAvailable: sharedNangoKeyAvailable(),
  };
}
