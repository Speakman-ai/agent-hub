/**
 * `write-tier3-config` adapter.
 *
 * Persists the host-class-derived `prEnv.nginx.*` block into
 * `<dataDir>/config.json` using a partial-preserving deep merge, plus
 * back-fills the same Tier-1 / Tier-2 fields on the singleton DB row
 * (`pr_env_config`) so the `validate` adapters see the same values.
 *
 * Two underlying bugs are closed by this adapter:
 *
 *   1. `pr-env-settings.ts` `validate` previously hardcoded
 *      `/etc/nginx/sites-available` / `sites-enabled`. The wizard now
 *      writes the *detected* paths into the file block, and the
 *      validate route reads them from the same block — see
 *      `routes/pr-env-settings.ts`'s `resolveNginxPaths`.
 *   2. `migrateFileConfigToDb` only fired on first launch, so manually-
 *      edited `prEnv.nginx.*` keys never reached the DB row consumed by
 *      the validator. The adapter unconditionally upserts the same row
 *      after every successful run.
 *
 * Writes are atomic per file (tmp + rename via `FsIO.writeFileAtomic`).
 * If the wizard crashes mid-phase the operator either has the old file
 * or the new one, never a half-written merge.
 */

import type Database from 'better-sqlite3';
import { writePrEnvConfig } from '../pr-env-store.js';
import type { DetectedHost } from './detect-host.js';
import type { ProvisionIO } from './io.js';
import type { PrEnvProvisionPayload } from './orchestrator.js';

export interface WriteTier3ConfigOptions {
  io: ProvisionIO;
  /** Detected host class — supplies nginx layout + cert path defaults. */
  detected: DetectedHost;
  /** Wizard input. Only `previewHost` is used here. */
  payload: Pick<PrEnvProvisionPayload, 'previewHost'>;
  /** Absolute path to `<dataDir>/config.json`. */
  configPath: string;
  /**
   * Optional DB handle for the Tier-1/Tier-2 backfill. Production wires
   * `getDb()`; tests can pass a tmp better-sqlite3 instance or omit
   * entirely to skip the DB write (file-only mode).
   */
  db?: Database.Database;
  /**
   * Optional log sink so the orchestrator can stream `merged 8 keys…`
   * progress lines into the event buffer.
   */
  log?: (line: string) => void;
}

export interface WriteTier3ConfigResult {
  /** Result key set written into `prEnv.nginx`. */
  nginxBlock: NginxBlock;
  /** Resolved cert path the next phase (`issue-cert`) needs. */
  certPath: string;
  /** Number of keys whose value changed compared to the previous file. */
  changedKeys: number;
  /** True when the DB row was upserted; false in file-only mode. */
  dbBackfilled: boolean;
}

interface NginxBlock {
  previewHost: string;
  previewBaseUrl: string;
  baseVhostPath: string;
  sitesAvailableDir: string;
  sitesEnabledDir: string;
  certPath: string;
  keyPath: string;
  certHome: string;
}

function previewBaseUrlFor(host: string): string {
  // V1 URL pattern is fixed: `pr-<number>.preview.<previewHost>`. Documented
  // in the wizard spec § "Lessons borrowed from Vercel".
  return `https://pr-{{number}}.${host}`;
}

/** Deep-merge `next` into `prev` for plain object trees. Arrays are replaced wholesale. */
function deepMerge(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    const cur = out[k];
    if (
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function countChangedKeys(before: Record<string, unknown> | undefined, after: NginxBlock): number {
  let n = 0;
  for (const k of Object.keys(after) as Array<keyof NginxBlock>) {
    if (!before || before[k] !== after[k]) n += 1;
  }
  return n;
}

export async function writeTier3Config(
  opts: WriteTier3ConfigOptions,
): Promise<WriteTier3ConfigResult> {
  const log = opts.log ?? (() => {});
  const { io, detected, payload, configPath, db } = opts;
  const previewHost = payload.previewHost.trim();
  if (!previewHost) {
    throw new Error('write-tier3-config: previewHost is required');
  }

  const certPath = detected.certPathFor(previewHost);
  const keyPath = detected.keyPathFor(previewHost);

  const nginxBlock: NginxBlock = {
    previewHost,
    previewBaseUrl: previewBaseUrlFor(previewHost),
    baseVhostPath: detected.baseVhostPath,
    sitesAvailableDir: detected.sitesAvailableDir,
    sitesEnabledDir: detected.sitesEnabledDir,
    certPath,
    keyPath,
    certHome: '/etc/letsencrypt',
  };

  // ── File block merge ────────────────────────────────────────────────
  let existing: Record<string, unknown> = {};
  if (await io.fs.exists(configPath)) {
    try {
      const raw = await io.fs.readFile(configPath);
      existing = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (err) {
      // The wizard refuses to silently overwrite a corrupt config — surfacing
      // the parse error here lets the operator inspect / fix before re-run.
      throw new Error(
        `write-tier3-config: existing ${configPath} is not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  const previousNginx = ((existing.prEnv as Record<string, unknown> | undefined)?.nginx ??
    {}) as Record<string, unknown>;
  const merged = deepMerge(existing, {
    prEnv: {
      nginx: nginxBlock,
    },
  });

  const next = `${JSON.stringify(merged, null, 2)}\n`;
  await io.fs.writeFileAtomic(configPath, next, 0o600);
  const changedKeys = countChangedKeys(previousNginx, nginxBlock);
  log(
    `write-tier3-config: wrote ${configPath} (${changedKeys} key change${changedKeys === 1 ? '' : 's'})`,
  );

  // ── DB row back-fill ────────────────────────────────────────────────
  let dbBackfilled = false;
  if (db) {
    // Match `migrateFileConfigToDb`'s shape: only Tier-1/Tier-2 keys live
    // in the DB row; Tier-3 (the nginx block above) stays in config.json.
    // `previewHost` is the only nginx field that is also stored in DB
    // for legacy reasons — the validator reads it from there.
    writePrEnvConfig({ previewHost, previewBaseUrl: nginxBlock.previewBaseUrl }, db);
    dbBackfilled = true;
    log('write-tier3-config: backfilled pr_env_config row');
  }

  return { nginxBlock, certPath, changedKeys, dbBackfilled };
}
