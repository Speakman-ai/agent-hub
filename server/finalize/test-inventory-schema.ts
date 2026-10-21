/**
 * Tables behind the Finalize test inventory (see test-inventory.ts). Kept
 * dependency-free so db.ts can import it without pulling in runner code.
 *
 * `finalize_test_inventory` holds one snapshot per project: the test files
 * each job instance ran in the last full default-branch CI run.
 * `finalize_test_inventory_state` records which sha that snapshot is from.
 */
export const TEST_INVENTORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS finalize_test_inventory (
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    matrix_key TEXT NOT NULL DEFAULT '',
    test_file TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (project_id, job_id, matrix_key, test_file)
  );
  CREATE TABLE IF NOT EXISTS finalize_test_inventory_state (
    project_id TEXT PRIMARY KEY,
    branch TEXT NOT NULL,
    sha TEXT NOT NULL,
    run_id TEXT,
    recorded_at INTEGER NOT NULL
  );
`;
