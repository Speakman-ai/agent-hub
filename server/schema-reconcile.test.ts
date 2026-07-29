import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  parseCreateTableStatements,
  planSchemaReconciliation,
  readLiveSchema,
  reconcileSchema,
  stripSqlComments,
} from './schema-reconcile.js';

describe('stripSqlComments', () => {
  it('removes line comments but keeps string literals containing --', () => {
    const sql = `CREATE TABLE t (
      a TEXT, -- a trailing note
      b TEXT DEFAULT 'not -- a comment'
    );`;
    const out = stripSqlComments(sql);
    expect(out).not.toContain('a trailing note');
    expect(out).toContain("'not -- a comment'");
  });

  it('removes block comments', () => {
    expect(stripSqlComments('a /* gone */ b')).toBe('a   b');
  });
});

describe('parseCreateTableStatements', () => {
  it('parses columns and ignores table-level constraints', () => {
    const [table] = parseCreateTableStatements(`
      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        PRIMARY KEY (id, owner),
        FOREIGN KEY (owner) REFERENCES users(id),
        UNIQUE (id)
      );
    `);
    expect(table.table).toBe('widgets');
    expect(table.columns.map((c) => c.name)).toEqual(['id', 'owner']);
  });

  it('does not split on commas nested inside CHECK or type parens', () => {
    const [table] = parseCreateTableStatements(`
      CREATE TABLE t (
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','done','wont_do')),
        amount NUMERIC(10,2),
        tail TEXT
      );
    `);
    expect(table.columns.map((c) => c.name)).toEqual(['status', 'amount', 'tail']);
  });

  it('survives comments inside the body (the real db.ts schema style)', () => {
    const [table] = parseCreateTableStatements(`
      CREATE TABLE IF NOT EXISTS finalize_kickoff_claims (
        claim_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        -- JSON array of ci.yaml v2 job ids; NULL = all jobs.
        job_filter TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    expect(table.columns.map((c) => c.name)).toEqual([
      'claim_key',
      'session_id',
      'job_filter',
      'created_at',
    ]);
  });

  it('ignores CREATE VIRTUAL TABLE (FTS5), which ALTER TABLE cannot extend', () => {
    const tables = parseCreateTableStatements(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(title, body);
      CREATE TABLE real_table (id TEXT);
    `);
    expect(tables.map((t) => t.table)).toEqual(['real_table']);
  });

  it('finds every table in a multi-statement DDL blob', () => {
    const tables = parseCreateTableStatements(`
      CREATE TABLE a (id TEXT);
      CREATE INDEX IF NOT EXISTS a_idx ON a(id);
      CREATE TABLE IF NOT EXISTS b (id TEXT, ref TEXT);
    `);
    expect(tables.map((t) => t.table)).toEqual(['a', 'b']);
  });
});

describe('addability assessment', () => {
  const columnsOf = (body: string) =>
    Object.fromEntries(
      parseCreateTableStatements(`CREATE TABLE t (${body});`)[0].columns.map((c) => [c.name, c]),
    );

  it('accepts plain nullable columns and NOT NULL with a constant default', () => {
    const cols = columnsOf(`
      job_filter TEXT,
      mode TEXT NOT NULL DEFAULT 'full',
      count INTEGER NOT NULL DEFAULT 0,
      negative INTEGER NOT NULL DEFAULT -1
    `);
    expect(cols.job_filter.addable).toBe(true);
    expect(cols.mode.addable).toBe(true);
    expect(cols.count.addable).toBe(true);
    expect(cols.negative.addable).toBe(true);
  });

  it('rejects what SQLite refuses to add to an existing table', () => {
    const cols = columnsOf(`
      pk TEXT PRIMARY KEY,
      uniq TEXT UNIQUE,
      required TEXT NOT NULL,
      null_default TEXT NOT NULL DEFAULT NULL,
      stamped TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expr TEXT NOT NULL DEFAULT (datetime('now')),
      gen TEXT GENERATED ALWAYS AS (pk || uniq) STORED
    `);
    expect(cols.pk.addable).toBe(false);
    expect(cols.uniq.addable).toBe(false);
    expect(cols.required.addable).toBe(false);
    expect(cols.required.reason).toMatch(/NOT NULL/);
    expect(cols.null_default.addable).toBe(false);
    expect(cols.stamped.addable).toBe(false);
    expect(cols.expr.addable).toBe(false);
    expect(cols.gen.addable).toBe(false);
  });

  it('allows a nullable REFERENCES column but not a NOT NULL one', () => {
    const cols = columnsOf(`
      soft_ref TEXT REFERENCES parents(id),
      hard_ref TEXT NOT NULL DEFAULT 'x' REFERENCES parents(id)
    `);
    expect(cols.soft_ref.addable).toBe(true);
    expect(cols.hard_ref.addable).toBe(false);
  });
});

describe('planSchemaReconciliation', () => {
  it('plans an ALTER only for columns missing from the live table', () => {
    const expected = parseCreateTableStatements(
      `CREATE TABLE claims (a TEXT, b TEXT, job_filter TEXT);`,
    );
    const plan = planSchemaReconciliation(expected, new Map([['claims', ['a', 'b']]]));
    expect(plan.blocked).toEqual([]);
    expect(plan.alters).toHaveLength(1);
    expect(plan.alters[0]).toMatchObject({ table: 'claims', column: 'job_filter' });
    expect(plan.alters[0].sql).toBe('ALTER TABLE "claims" ADD COLUMN "job_filter" TEXT');
  });

  it('skips expected tables that do not exist in the live database', () => {
    // A rebuild migration may CREATE a scratch table and rename it away. The
    // reconciler must not resurrect it.
    const expected = parseCreateTableStatements(`CREATE TABLE scratch_new (a TEXT);`);
    expect(planSchemaReconciliation(expected, new Map()).alters).toEqual([]);
  });

  it('reports un-addable drift as blocked instead of planning an ALTER', () => {
    const expected = parseCreateTableStatements(`CREATE TABLE t (a TEXT, later TEXT NOT NULL);`);
    const plan = planSchemaReconciliation(expected, new Map([['t', ['a']]]));
    expect(plan.alters).toEqual([]);
    expect(plan.blocked).toEqual([
      { table: 't', column: 'later', reason: 'NOT NULL without a DEFAULT' },
    ]);
  });

  it('matches table and column names case-insensitively, as SQLite does', () => {
    const expected = parseCreateTableStatements(`CREATE TABLE Claims (Job_Filter TEXT);`);
    const plan = planSchemaReconciliation(expected, new Map([['claims', ['job_filter']]]));
    expect(plan.alters).toEqual([]);
  });
});

describe('reconcileSchema', () => {
  it('adds a column that CREATE TABLE IF NOT EXISTS could never have added', () => {
    // This is the 2026-07-29 outage in miniature: the live table predates
    // `job_filter`, so re-running the CREATE is a no-op, and the eagerly
    // prepared INSERT that names the column throws at boot.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE finalize_kickoff_claims (
        claim_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    const currentDdl = `
      CREATE TABLE IF NOT EXISTS finalize_kickoff_claims (
        claim_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        mode TEXT NOT NULL,
        job_filter TEXT,
        created_at INTEGER NOT NULL
      );
    `;

    // Re-running the CREATE changes nothing — that is the whole trap.
    db.exec(currentDdl);
    expect(readLiveSchema(db).get('finalize_kickoff_claims')).not.toContain('job_filter');
    expect(() =>
      db.prepare(
        `INSERT OR IGNORE INTO finalize_kickoff_claims
           (claim_key, session_id, branch, mode, job_filter, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
    ).toThrow(/job_filter/);

    const { alters, blocked } = reconcileSchema(db, [currentDdl]);

    expect(blocked).toEqual([]);
    expect(alters).toHaveLength(1);
    expect(alters[0]).toMatchObject({ table: 'finalize_kickoff_claims', column: 'job_filter' });
    expect(readLiveSchema(db).get('finalize_kickoff_claims')).toContain('job_filter');

    // The statement that crash-looped prod now prepares and runs.
    const insert = db.prepare(
      `INSERT OR IGNORE INTO finalize_kickoff_claims
         (claim_key, session_id, branch, mode, job_filter, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('k', 's', 'b', 'full', null, 1);
    expect(db.prepare('SELECT job_filter FROM finalize_kickoff_claims').get()).toEqual({
      job_filter: null,
    });

    db.close();
  });

  it('preserves existing rows and backfills the new column with its default', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY);`);
    db.prepare('INSERT INTO runs (id) VALUES (?)').run('run-1');

    reconcileSchema(db, [
      `CREATE TABLE IF NOT EXISTS runs (
         id TEXT PRIMARY KEY,
         mode TEXT NOT NULL DEFAULT 'full',
         job_filter TEXT
       );`,
    ]);

    expect(db.prepare('SELECT id, mode, job_filter FROM runs').get()).toEqual({
      id: 'run-1',
      mode: 'full',
      job_filter: null,
    });
    db.close();
  });

  it('is a no-op when the live schema already matches', () => {
    const db = new Database(':memory:');
    const ddl = `CREATE TABLE IF NOT EXISTS t (a TEXT, b INTEGER NOT NULL DEFAULT 0);`;
    db.exec(ddl);
    expect(reconcileSchema(db, [ddl])).toEqual({ alters: [], blocked: [] });
    db.close();
  });

  it('reports rather than throws when drift cannot be repaired automatically', () => {
    // Fail-open is deliberate: throwing here would turn latent, harmless drift
    // on an existing install into a hard boot failure on its next deploy — the
    // outage class this module exists to prevent.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE t (a TEXT);`);
    const plan = reconcileSchema(db, [`CREATE TABLE IF NOT EXISTS t (a TEXT, b TEXT NOT NULL);`]);
    expect(plan.alters).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0].column).toBe('b');
    db.close();
  });

  it('repairs several tables in one pass, ignoring non-CREATE DDL', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE a (id TEXT);
      CREATE TABLE b (id TEXT);
      ALTER TABLE b ADD COLUMN unrelated TEXT;
    `);
    const plan = reconcileSchema(db, [
      `CREATE TABLE IF NOT EXISTS a (id TEXT, added_a TEXT);`,
      `CREATE INDEX IF NOT EXISTS a_idx ON a(id);`,
      `ALTER TABLE b ADD COLUMN unrelated TEXT;`,
      `CREATE TABLE IF NOT EXISTS b (id TEXT, unrelated TEXT, added_b INTEGER NOT NULL DEFAULT 7);`,
    ]);
    expect(plan.blocked).toEqual([]);
    expect(plan.alters.map((a) => `${a.table}.${a.column}`)).toEqual(['a.added_a', 'b.added_b']);
    db.close();
  });
});
