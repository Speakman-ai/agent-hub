/**
 * `hub_instance` singleton — stable UUID for this Hub install.
 *
 * Generated lazily at first read and persisted in `orgs.db`. Used as the
 * left half of the `end_user_id` value Hub-Shared mode forwards to Nango
 * (`${hubInstanceId}:${userId}`) so multi-tenant Cloud installs can scope
 * each user's connections to their originating Hub deployment.
 *
 * The same value is intended to be reusable for future babysit-heartbeat
 * scoping (per the Nango ADR). Today there is no existing babysit
 * instance ID to reuse — this module is the canonical source.
 *
 * Singleton enforced via `CHECK(id = 1)` on the row. Schema is created
 * here so this module is self-contained for tests; production setup also
 * runs `initOrgsDb()` first which will idempotently create the same
 * table.
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getOrgsDb } from '../orgs.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS hub_instance (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    instance_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

let cached: string | null = null;

function ensureSchema(db: Database.Database): void {
  db.exec(SCHEMA);
}

/**
 * Get (or generate-and-persist) the stable hub instance UUID.
 *
 * - On first call ever: inserts a new UUID and returns it.
 * - On subsequent calls: returns the persisted value.
 * - Cached in-memory for the process lifetime; tests should call
 *   `__resetHubInstanceCacheForTests()` between cases.
 */
export function getHubInstanceId(db?: Database.Database): string {
  if (cached) return cached;
  const handle = db ?? getOrgsDb();
  ensureSchema(handle);
  const row = handle.prepare('SELECT instance_id FROM hub_instance WHERE id = 1').get() as
    | { instance_id: string }
    | undefined;
  if (row?.instance_id) {
    cached = row.instance_id;
    return cached;
  }
  const fresh = crypto.randomUUID();
  handle.prepare('INSERT INTO hub_instance (id, instance_id) VALUES (1, ?)').run(fresh);
  cached = fresh;
  return cached;
}

/** Test-only — drop the in-memory cache so a fresh DB regenerates the ID. */
export function __resetHubInstanceCacheForTests(): void {
  cached = null;
}
