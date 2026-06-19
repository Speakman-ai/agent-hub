import { describe, it, expect } from 'vitest';
import { supportTicketsStatusCheckNeedsRebuild } from './db.js';

// The support_tickets status CHECK is widened (duplicate / wont_do) by a
// table-rebuild migration that only fires when an existing install's DDL
// predates those states. The detection has a subtle trap: the `wont_do_reason`
// column added by an earlier migration step ALSO contains the substring
// "wont_do", so a naive substring test would mask a stale CHECK and skip the
// rebuild — leaving inserts of 'duplicate'/'wont_do' to fail a CHECK constraint.
describe('supportTicketsStatusCheckNeedsRebuild', () => {
  const OLD_CHECK = "CHECK(status IN ('new','investigating','converted','closed'))";
  const NEW_CHECK =
    "CHECK(status IN ('new','investigating','converted','closed','duplicate','wont_do'))";

  it('needs a rebuild for a legacy DDL (old CHECK, no new states)', () => {
    const ddl = `CREATE TABLE support_tickets (id TEXT, status TEXT NOT NULL ${OLD_CHECK})`;
    expect(supportTicketsStatusCheckNeedsRebuild(ddl)).toBe(true);
  });

  it('STILL needs a rebuild when wont_do_reason was added but the CHECK is stale', () => {
    // This is the regression: the column name contains "wont_do" but the CHECK
    // literal `'wont_do'` is absent, so the rebuild must still fire.
    const ddl = `CREATE TABLE support_tickets (id TEXT, status TEXT NOT NULL ${OLD_CHECK}, wont_do_reason TEXT)`;
    expect(ddl.includes('wont_do')).toBe(true); // bare substring is present…
    expect(supportTicketsStatusCheckNeedsRebuild(ddl)).toBe(true); // …but a rebuild is still required
  });

  it('does not rebuild a current DDL whose CHECK already allows the new states', () => {
    const ddl = `CREATE TABLE support_tickets (id TEXT, status TEXT NOT NULL ${NEW_CHECK}, wont_do_reason TEXT)`;
    expect(supportTicketsStatusCheckNeedsRebuild(ddl)).toBe(false);
  });

  it('does not rebuild when there is no table yet (empty DDL)', () => {
    expect(supportTicketsStatusCheckNeedsRebuild('')).toBe(false);
  });
});
