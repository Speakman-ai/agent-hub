/**
 * QA Validation DDL (primary DB, beside the kanban tables the plans link to).
 *
 * qa_plans: one validation plan per target. `status` is stored for cheap list
 * filtering but is written only through `qa-status.ts`:
 *   new          draft or approved, never run
 *   in_progress  any run started (also a reopened Done plan)
 *   done         latest run all-pass AND a human signed off
 * `approved_at` NULL means draft. `approval_seq` increments on every approval;
 * each run copies it, so a run from before a re-approval cannot back a sign-off. `deploy_environment` names a
 * `deployments.environment` the auto-rerun waits on; NULL means no auto-rerun.
 *
 * qa_cases: the ordered case list. `version` bumps when an approved case is
 * edited, which also clears plan approval.
 *
 * qa_runs: one row per execution. `iteration` is 1-based and unique per plan.
 * `case_ids` is the JSON array of case ids in scope, fixed when the run is
 * queued; NULL on rows from before scope was recorded. `preview_session_id`
 * is the session whose preview the run drives when the target is a Hub
 * session preview (or a loopback port one serves).
 *
 * qa_results: one verdict per (run, case). `case_version` is the case version
 * that was tested, so a verdict stops counting once the case is edited.
 * `screenshot_artifact_ids` is a JSON
 * array of artifact ids. `finding_card_id` is the kanban card filed for a
 * failing verdict.
 *
 * Kanban / session links are ON DELETE SET NULL: deleting a card or session
 * must not erase QA history. Timestamps use `datetime('now')` like the kanban
 * tables so deploy/merge comparisons stay in one format.
 */
export const QA_PLAN_STATUSES = ['new', 'in_progress', 'done'] as const;
export const QA_RUN_SCOPES = ['full', 'failed_only'] as const;
export const QA_RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export const QA_VERDICTS = ['pass', 'fail', 'needs_change', 'blocked'] as const;

const inList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

export const QA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS qa_plans (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL,
    title              TEXT NOT NULL,
    goal               TEXT NOT NULL DEFAULT '',
    target_url         TEXT NOT NULL,
    epic_id            TEXT REFERENCES kanban_epics(id) ON DELETE SET NULL,
    card_id            TEXT REFERENCES kanban_cards(id) ON DELETE SET NULL,
    deploy_environment TEXT,
    status             TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN (${inList(QA_PLAN_STATUSES)})),
    approved_at        TEXT,
    approved_by        TEXT,
    approval_seq       INTEGER NOT NULL DEFAULT 0,
    signed_off_at      TEXT,
    signed_off_by      TEXT,
    auto_rerun         INTEGER NOT NULL DEFAULT 1 CHECK (auto_rerun IN (0, 1)),
    max_iterations     INTEGER NOT NULL DEFAULT 5 CHECK (max_iterations >= 1),
    created_by         TEXT,
    authoring_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_qa_plans_project_status ON qa_plans(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_qa_plans_epic ON qa_plans(epic_id) WHERE epic_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_qa_plans_card ON qa_plans(card_id) WHERE card_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS qa_cases (
    id         TEXT PRIMARY KEY,
    plan_id    TEXT NOT NULL REFERENCES qa_plans(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL DEFAULT 0,
    title      TEXT NOT NULL,
    steps      TEXT NOT NULL DEFAULT '',
    expected   TEXT NOT NULL DEFAULT '',
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_qa_cases_plan_position ON qa_cases(plan_id, position, id);

  CREATE TABLE IF NOT EXISTS qa_runs (
    id          TEXT PRIMARY KEY,
    plan_id     TEXT NOT NULL REFERENCES qa_plans(id) ON DELETE CASCADE,
    iteration   INTEGER NOT NULL CHECK (iteration >= 1),
    scope       TEXT NOT NULL DEFAULT 'full' CHECK (scope IN (${inList(QA_RUN_SCOPES)})),
    status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (${inList(QA_RUN_STATUSES)})),
    session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    approval_seq INTEGER NOT NULL,
    case_ids    TEXT CHECK (case_ids IS NULL OR json_valid(case_ids)),
    preview_session_id TEXT,
    started_by  TEXT,
    started_at  TEXT,
    finished_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (plan_id, iteration)
  );
  CREATE INDEX IF NOT EXISTS idx_qa_runs_session ON qa_runs(session_id) WHERE session_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS qa_results (
    id                      TEXT PRIMARY KEY,
    run_id                  TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE,
    case_id                 TEXT NOT NULL REFERENCES qa_cases(id) ON DELETE CASCADE,
    case_version            INTEGER NOT NULL,
    verdict                 TEXT NOT NULL CHECK (verdict IN (${inList(QA_VERDICTS)})),
    actual                  TEXT NOT NULL DEFAULT '',
    notes                   TEXT NOT NULL DEFAULT '',
    screenshot_artifact_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(screenshot_artifact_ids)),
    finding_card_id         TEXT REFERENCES kanban_cards(id) ON DELETE SET NULL,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (run_id, case_id)
  );
  CREATE INDEX IF NOT EXISTS idx_qa_results_case ON qa_results(case_id);
  CREATE INDEX IF NOT EXISTS idx_qa_results_finding_card
    ON qa_results(finding_card_id) WHERE finding_card_id IS NOT NULL;
`;
