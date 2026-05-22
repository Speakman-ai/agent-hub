/**
 * Setup-time recovery for spawn-env staleness.
 *
 * When `/api/auth/setup` runs against a server that was previously
 * wide-open (`!apiKey && !authRecord` branch in `authMiddleware`), every
 * in-flight session keeps running with the empty `AGENT_HUB_API_KEY` env
 * it inherited at spawn time. The gate flips immediately though, so the
 * agents' next tool call returns 401.
 *
 * This module is the runtime-recovery side: after the Owner is created,
 * we mint one `ahub_*` token per in-flight session and write it into the
 * session's spawn-creds file. The agent-side shell helpers
 * (`ah-api.sh:ah_resolve_key`) consult that file on every invocation, so
 * the next tool call after this runs picks up working credentials
 * without a session restart.
 *
 * ## What counts as "in-flight"
 *
 * The sessions table has no live-process column. We approximate
 * "in-flight" with `updated_at` within the last 24 hours — a long
 * enough window to cover normal idle agents, short enough to skip the
 * archived backlog of every session ever spawned.
 *
 * ## Failure handling
 *
 * Best-effort everywhere. Per-session failures are logged with
 * `TOOL_ERROR`-style breadcrumbs but never abort the setup endpoint —
 * the user creation must succeed regardless. The setup endpoint logs a
 * single INFO line with the count for operator visibility.
 */
import type Database from 'better-sqlite3';
import { createApiKey } from './api-keys-store.js';
import { writeSpawnCredsFile } from './spawn-creds-file.js';

/** Window for "recently active" sessions. Long enough for idle agents. */
const ACTIVE_WINDOW_HOURS = 24;

export interface RecoveryDeps {
  /** Server sessions DB handle (`server/db.ts`). */
  db: Database.Database;
  /** Data dir where `spawn-creds/` lives (writer side mirrors reader). */
  dataDir: string;
  /** New Owner user id (the row freshly created during /api/auth/setup). */
  ownerUserId: string;
  /** Optional logger (defaults to console). Two levels keep test assertions easy. */
  log?: (level: 'info' | 'warn', msg: string) => void;
  /** Optional now-override for tests. */
  now?: () => Date;
}

export interface RecoveryResult {
  /** Total candidate sessions inspected. */
  candidates: number;
  /** Sessions for which a creds file was successfully written. */
  recovered: number;
  /** Per-session failure count (each is logged). */
  failed: number;
}

interface SessionRow {
  id: string;
  updated_at: string;
}

/**
 * Mint spawn-creds for active sessions so they can recover from the
 * mid-flight auth flip. Idempotent — running twice just rotates each
 * file to a fresh token.
 *
 * Returns counts so the caller (setup endpoint) can log a structured
 * summary line.
 */
export function recoverActiveSessionsAfterSetup(deps: RecoveryDeps): RecoveryResult {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());

  let rows: SessionRow[];
  try {
    const cutoffMs = now().getTime() - ACTIVE_WINDOW_HOURS * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    // sqlite stores `updated_at` as `datetime('now')` (UTC, no timezone
    // suffix). Compare lexically — both sides are ISO-ish and string
    // ordering matches chronological for that format.
    const cutoffSqlite = cutoffIso.replace('T', ' ').replace(/\.\d+Z$/, '');
    rows = deps.db
      .prepare('SELECT id, updated_at FROM sessions WHERE updated_at >= ? ORDER BY updated_at DESC')
      .all(cutoffSqlite) as SessionRow[];
  } catch (err) {
    log('warn', `[spawn-creds-recovery] sessions query failed: ${(err as Error).message}`);
    return { candidates: 0, recovered: 0, failed: 0 };
  }

  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const minted = createApiKey(
        deps.ownerUserId,
        `spawn-recovery (${row.id.slice(0, 8)})`,
        // 7-day TTL matches spawn-creds-mint's SPAWN_KEY_TTL_DAYS.
        // Prevents unbounded key accumulation if setup is re-run; the
        // session purge / next-spawn rotation revoke the row in normal
        // operation, but the TTL self-cleans if both miss.
        7,
      );
      writeSpawnCredsFile(row.id, minted.token, deps.dataDir);
      recovered += 1;
    } catch (err) {
      failed += 1;
      log('warn', `[spawn-creds-recovery] session=${row.id} failed: ${(err as Error).message}`);
    }
  }

  return { candidates: rows.length, recovered, failed };
}

function defaultLog(level: 'info' | 'warn', msg: string): void {
  if (level === 'warn') console.warn(msg);
  else console.log(msg);
}
