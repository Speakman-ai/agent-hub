/**
 * A fresh boot must produce ZERO schema-drift repairs.
 *
 * The reconciler (server/schema-reconcile.ts) diffs every `CREATE TABLE` body
 * in server/db.ts against the live table. On a brand-new database those tables
 * were just created from those same bodies, so a correct reconciler is a no-op.
 * Any output here means one of:
 *
 *   - the DDL parser mis-read a real column definition (this file is the guard
 *     that exercises it against all ~76 production tables, comments, CHECK
 *     constraints and all — not just the hand-written fixtures in
 *     server/schema-reconcile.test.ts); or
 *   - a CREATE body disagrees with a table-rebuild migration that deliberately
 *     drops a column (e.g. the heartbeat_state rebuild). Left unchecked the
 *     reconciler would re-add that column on every boot, silently reverting the
 *     migration.
 *
 * Console spies are installed before the import because `initDb` runs at module
 * load.
 */
import { describe, it, expect, vi } from 'vitest';

describe('schema reconciliation on a fresh database', () => {
  it('reports no drift when booting against a database it just created', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await import('../db.js');

      const driftLines = [...log.mock.calls, ...warn.mock.calls]
        .map((args) => String(args[0]))
        .filter((line) => line.includes('schema drift'));

      expect(driftLines).toEqual([]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
