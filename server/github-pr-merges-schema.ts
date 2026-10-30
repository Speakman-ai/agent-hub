/** DDL for `github_pr_merges` (see github-pr-merges.ts). */
export const GITHUB_PR_MERGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS github_pr_merges (
    project_id TEXT NOT NULL,
    pr_url     TEXT NOT NULL,
    pr_number  INTEGER,
    head_ref   TEXT,
    merged_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, pr_url)
  );
  CREATE INDEX IF NOT EXISTS idx_github_pr_merges_head
    ON github_pr_merges(project_id, head_ref) WHERE head_ref IS NOT NULL;
`;
