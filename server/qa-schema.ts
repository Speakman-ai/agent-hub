/**
 * QA Validation DDL (primary DB, beside the kanban tables the plans link to).
 *
 * qa_plans: one validation plan per target. `status` is stored for cheap list
 * filtering but is written only through `qa-status.ts`:
 *   new          draft or approved, never run
 *   in_progress  any run started (also a reopened Done plan)
 *   done         latest run all-pass AND a human signed off
 * `approved_at` NULL means draft. `approval_seq` increments on every approval;
 * each run copies it, so a run from before a re-approval cannot back a sign-off.
 * `auto_rerun_trigger` picks what the auto-rerun waits on once every fix is
 * Done: `deployment` waits for a successful deploy to `deploy_environment`;
 * `merge` waits for a pull request merged into `auto_rerun_branch`, then
 * `auto_rerun_delay_minutes` more; `fixes_merged` reruns
 * `auto_rerun_delay_minutes` after the last finding card reached Done (a card
 * reaches Done when its session, ticket, or epic work merges). A deployment or
 * merge trigger with no environment or branch set sends an inbox notice
 * instead of rerunning.
 *
 * qa_cases: the ordered case list. `version` bumps when an approved case is
 * edited, which also clears plan approval.
 *
 * qa_runs: one row per execution. `iteration` is 1-based and unique per plan.
 * `case_ids` is the JSON array of case ids in scope, fixed when the run is
 * queued; NULL on rows from before scope was recorded. `preview_session_id`
 * is the session whose preview the run drives when the target is a Hub
 * session preview (or a loopback port one serves). `auto_rerun_state` records
 * what the auto-rerun trigger already did about this run (see qa-auto-rerun.ts)
 * so each notice or rerun happens once.
 *
 * qa_results: one verdict per (run, case). `case_version` is the case version
 * that was tested, so a verdict stops counting once the case is edited.
 * `screenshot_artifact_ids` is a JSON
 * array of artifact ids. `finding_card_id` is the kanban card filed for a
 * failing verdict.
 *
 * qa_environments: project-level servers QA tests against (base URL plus
 * free-form notes about the server) and the test accounts for each. `accounts`
 * is a JSON array of { id, label, username, password_enc, notes }; passwords
 * are AES-GCM blobs from secret-crypto.ts and never leave the server except
 * through the `{{qa-password:<accountId>}}` substitution in QA sessions.
 *
 * Kanban / session links are ON DELETE SET NULL: deleting a card or session
 * must not erase QA history. Timestamps use `datetime('now')` like the kanban
 * tables so deploy/merge comparisons stay in one format.
 */
export const QA_PLAN_STATUSES = ['new', 'in_progress', 'done'] as const;
export const QA_RUN_SCOPES = ['full', 'failed_only'] as const;
export const QA_RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export const QA_VERDICTS = ['pass', 'fail', 'needs_change', 'blocked'] as const;
export const QA_AUTO_RERUN_TRIGGERS = ['deployment', 'merge', 'fixes_merged'] as const;
export type QaAutoRerunTrigger = (typeof QA_AUTO_RERUN_TRIGGERS)[number];
/** Merge / fixes-merged delay bounds in minutes; 0 means rerun as soon as the trigger fires. */
export const QA_AUTO_RERUN_DELAY_MIN = 5;
export const QA_AUTO_RERUN_DELAY_MAX = 60;

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
    auto_rerun_trigger TEXT NOT NULL DEFAULT 'deployment'
                       CHECK (auto_rerun_trigger IN (${inList(QA_AUTO_RERUN_TRIGGERS)})),
    auto_rerun_branch  TEXT,
    auto_rerun_delay_minutes INTEGER NOT NULL DEFAULT 0
                       CHECK (auto_rerun_delay_minutes BETWEEN 0 AND 60),
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
    auto_rerun_state TEXT,
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

  CREATE TABLE IF NOT EXISTS qa_environments (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name       TEXT NOT NULL,
    base_url   TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    accounts   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accounts)),
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_qa_environments_project
    ON qa_environments(project_id, position, id);
`;
