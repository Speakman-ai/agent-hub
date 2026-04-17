import { describe, it, expect } from 'vitest';

/**
 * Smoke test: better-sqlite3's native addon loads against the current Node
 * runtime's ABI. If this fails with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION
 * mismatch, the compiled `.node` binary is stale for the current Node version.
 *
 * Recovery: `npm run rebuild:native` (or `npm rebuild better-sqlite3`).
 *
 * Root cause is usually a Node major-version upgrade without a reinstall, or
 * the binary being built for Electron's ABI via `electron-builder
 * install-app-deps` and then used by system Node (or vice versa).
 *
 * Pairs with the `.nvmrc` + `engines.node` constraint in the repo root.
 */
describe('native module ABI', () => {
  it('loads better-sqlite3 against the current Node runtime', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      expect(row.ok).toBe(1);
    } finally {
      db.close();
    }
  });
});
