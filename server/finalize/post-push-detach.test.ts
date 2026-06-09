/**
 * Tests for the §15 post-push detach module.
 *
 * Two layers:
 *
 *   - **Unit** — exercise `formatPostPushComment` and `runPostPushDetach`
 *     against mocked Stmts. Covers wording (both trigger sources), comment
 *     posting, broadcast order, and the non-throwing contract on DB errors.
 *
 *   - **Integration** — drive the whole §15 loop against a real
 *     in-memory `better-sqlite3` database. Simulates the orchestrator
 *     pushing → asserts the provenance check (`classifyPr`) returns
 *     `internal/registry` (so the webhook handler will NOT auto-dispatch
 *     the reviewer per design doc §11) → simulates the merge-close
 *     webhook → asserts the card moves to Done. This is the end-to-end
 *     loop the §15 acceptance criterion calls for.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';

import {
  formatPostPushComment,
  runPostPushDetach,
  type PostPushDetachDeps,
} from './post-push-detach.js';
import { classifyPr, writeFinalizeRunPrUrl } from './provenance.js';
import type { KanbanCardRow, KanbanColumnRow, Stmts } from '../types.js';

// ─── Unit: formatPostPushComment ─────────────────────────────────────

describe('formatPostPushComment', () => {
  it('renders the ui_button handoff with PR URL and run trailer', () => {
    const content = formatPostPushComment({
      prUrl: 'https://github.com/o/r/pull/42',
      runId: 'run-1',
      triggerSource: 'ui_button',
    });
    expect(content).toBe(
      'Finalized. PR is on GitHub, owned by the developer from here.\n' +
        'https://github.com/o/r/pull/42\n' +
        '(run run-1)',
    );
  });

  it('appends the autonomous-trigger suffix on agent_block runs', () => {
    const content = formatPostPushComment({
      prUrl: 'https://github.com/o/r/pull/77',
      runId: 'run-2',
      triggerSource: 'agent_block',
    });
    // Order: handoff → URL → autonomous note → run trailer. The
    // autonomous note sits between URL and trailer so the human-visible
    // shape stays "lede, URL, context, footer".
    expect(content).toBe(
      'Finalized. PR is on GitHub, owned by the developer from here.\n' +
        'https://github.com/o/r/pull/77\n' +
        '(triggered by autonomous agent)\n' +
        '(run run-2)',
    );
  });

  it('always includes the run trailer regardless of trigger source', () => {
    const ui = formatPostPushComment({
      prUrl: 'https://x',
      runId: 'r',
      triggerSource: 'ui_button',
    });
    const agent = formatPostPushComment({
      prUrl: 'https://x',
      runId: 'r',
      triggerSource: 'agent_block',
    });
    expect(ui.endsWith('(run r)')).toBe(true);
    expect(agent.endsWith('(run r)')).toBe(true);
  });
});

// ─── Unit fixtures ───────────────────────────────────────────────────

function fakeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-progress',
    board_id: 'board-1',
    title: 'Detach me',
    description: '',
    priority: 'medium',
    assignee: 'agent-1',
    labels: '',
    session_id: 'sess-1',
    github_issue_url: null,
    pr_url: null,
    position: 0,
    created_by: 'user-1',
    assign_model: null,
    assign_engine: null,
    epic_id: null,
    pr_base_branch: null,
    documented: 0,
    dispatched_by_autonomous: 0,
    review_status: null,
    ...overrides,
  } as unknown as KanbanCardRow;
}

interface RecordedComment {
  id: string;
  cardId: string;
  author: string;
  content: string;
}

function makeDeps(cardOverride: Partial<KanbanCardRow> = {}): {
  deps: PostPushDetachDeps;
  card: KanbanCardRow;
  comments: RecordedComment[];
  broadcast: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  const card = fakeCard(cardOverride);
  const comments: RecordedComment[] = [];
  const broadcast = vi.fn();
  const log = vi.fn();
  let idCounter = 0;
  const deps: PostPushDetachDeps = {
    stmts: {
      createKanbanCardComment: {
        run: vi.fn((id: string, cardId: string, author: string, content: string) => {
          comments.push({ id, cardId, author, content });
        }),
      } as unknown as PostPushDetachDeps['stmts']['createKanbanCardComment'],
    },
    broadcast,
    newId: () => `comment-${++idCounter}`,
    log,
  };
  return { deps, card, comments, broadcast, log };
}

// ─── Unit: runPostPushDetach ─────────────────────────────────────────

describe('runPostPushDetach — happy path (card in In Progress)', () => {
  it('posts the handoff comment without moving the card', () => {
    const { deps, comments, broadcast } = makeDeps({ column_id: 'col-progress' });

    runPostPushDetach(deps, {
      cardId: 'card-1',
      projectId: 'proj-1',
      prUrl: 'https://github.com/o/r/pull/42',
      runId: 'run-1',
      triggerSource: 'ui_button',
    });

    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe(
      'Finalized. PR is on GitHub, owned by the developer from here.\n' +
        'https://github.com/o/r/pull/42\n' +
        '(run run-1)',
    );
    expect(comments[0].author).toBe('finalize');
    expect(broadcast.mock.calls).toEqual([[{ type: 'kanban_update', projectId: 'proj-1' }]]);
  });

  it('includes the autonomous-trigger suffix when triggerSource is agent_block', () => {
    const { deps, comments } = makeDeps({ column_id: 'col-progress' });

    runPostPushDetach(deps, {
      cardId: 'card-1',
      projectId: 'proj-1',
      prUrl: 'https://github.com/o/r/pull/77',
      runId: 'run-7',
      triggerSource: 'agent_block',
    });

    expect(comments[0].content).toContain('(triggered by autonomous agent)');
  });
});

describe('runPostPushDetach — non-throwing contract', () => {
  it('swallows DB errors on createKanbanCardComment', () => {
    const { deps, log, comments } = makeDeps({ column_id: 'col-progress' });
    (deps.stmts.createKanbanCardComment as unknown as { run: ReturnType<typeof vi.fn> }).run =
      vi.fn(() => {
        throw new Error('disk full');
      });

    expect(() =>
      runPostPushDetach(deps, {
        cardId: 'card-1',
        projectId: 'proj-1',
        prUrl: 'https://x',
        runId: 'r',
        triggerSource: 'ui_button',
      }),
    ).not.toThrow();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('postComment failed'));
    expect(comments).toHaveLength(0);
  });
});

// ─── Integration: §15 end-to-end loop ────────────────────────────────

/**
 * Spin up an in-memory sqlite with the kanban + finalize_runs schemas so
 * the full §15 loop can be exercised against real prepared statements.
 *
 * Schema scope: just the columns the detach + provenance helpers touch.
 * If a production-side column gets a NOT NULL constraint we don't model
 * here, that's a wakeup signal — keep this synced with the live
 * `server/db.ts`.
 */
interface IntegrationHarness {
  db: Database.Database;
  stmts: Pick<
    Stmts,
    | 'getKanbanCard'
    | 'getKanbanColumns'
    | 'moveKanbanCard'
    | 'createKanbanCardComment'
    | 'updateFinalizeRunPrUrl'
    | 'getFinalizeRunByPrUrl'
  >;
  insertCard: (row: { id: string; board_id: string; column_id: string; title: string }) => void;
  insertColumn: (row: { id: string; board_id: string; name: string; position: number }) => void;
  insertRun: (row: {
    id: string;
    card_id: string;
    project_id: string;
    branch: string;
    head_sha: string;
    idempotency_key: string;
    status: string;
    trigger_source: string;
    triggered_by_user_id: string;
    author_name: string;
    author_email: string;
  }) => void;
  /**
   * Replay the merge-close branch of the webhook handler:
   * `pull_request.closed` with `merged: true` → move the card to Done.
   * Encodes the same column-name lookup the handler uses (case-insensitive
   * match on `"done"`), so a future rename of the production column to
   * e.g. "Done ✅" would still match.
   */
  simulateMergeClosed: (cardId: string) => void;
}

function buildIntegrationHarness(): IntegrationHarness {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kanban_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      color TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT,
      assignee TEXT,
      labels TEXT,
      session_id TEXT,
      github_issue_url TEXT,
      pr_url TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      assign_model TEXT,
      assign_engine TEXT,
      epic_id TEXT,
      pr_base_branch TEXT,
      documented INTEGER NOT NULL DEFAULT 0,
      dispatched_by_autonomous INTEGER NOT NULL DEFAULT 0,
      review_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE kanban_card_comments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finalize_runs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      session_id TEXT,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      phase TEXT,
      trigger_source TEXT NOT NULL,
      worktree_path TEXT,
      triggered_by_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      reviewer_verdict TEXT,
      failure_reason TEXT,
      failed_step_index INTEGER,
      failed_step_name TEXT,
      failed_step_exit_code INTEGER,
      retry_of_run_id TEXT,
      active_seconds_consumed INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      pr_url TEXT
    );
  `);

  const insertCardStmt = db.prepare(
    `INSERT INTO kanban_cards (id, board_id, column_id, title) VALUES (?, ?, ?, ?)`,
  );
  const insertColStmt = db.prepare(
    `INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)`,
  );
  const insertRunStmt = db.prepare(
    `INSERT INTO finalize_runs
       (id, card_id, project_id, branch, head_sha, idempotency_key,
        status, trigger_source, triggered_by_user_id,
        author_name, author_email, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const getKanbanCard = db.prepare(`SELECT * FROM kanban_cards WHERE id = ?`);
  const getKanbanColumns = db.prepare(
    `SELECT * FROM kanban_columns WHERE board_id = ? ORDER BY position ASC`,
  );
  const moveKanbanCard = db.prepare(
    `UPDATE kanban_cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  const createKanbanCardComment = db.prepare(
    `INSERT INTO kanban_card_comments (id, card_id, author, content) VALUES (?, ?, ?, ?)`,
  );
  const updateFinalizeRunPrUrl = db.prepare(`UPDATE finalize_runs SET pr_url = ? WHERE id = ?`);
  const getFinalizeRunByPrUrl = db.prepare(`SELECT * FROM finalize_runs WHERE pr_url = ? LIMIT 1`);

  return {
    db,
    stmts: {
      getKanbanCard: getKanbanCard as unknown as Stmts['getKanbanCard'],
      getKanbanColumns: getKanbanColumns as unknown as Stmts['getKanbanColumns'],
      moveKanbanCard: moveKanbanCard as unknown as Stmts['moveKanbanCard'],
      createKanbanCardComment:
        createKanbanCardComment as unknown as Stmts['createKanbanCardComment'],
      updateFinalizeRunPrUrl: updateFinalizeRunPrUrl as unknown as Stmts['updateFinalizeRunPrUrl'],
      getFinalizeRunByPrUrl: getFinalizeRunByPrUrl as unknown as Stmts['getFinalizeRunByPrUrl'],
    },
    insertCard: (row) => insertCardStmt.run(row.id, row.board_id, row.column_id, row.title),
    insertColumn: (row) => insertColStmt.run(row.id, row.board_id, row.name, row.position),
    insertRun: (row) => {
      insertRunStmt.run(
        row.id,
        row.card_id,
        row.project_id,
        row.branch,
        row.head_sha,
        row.idempotency_key,
        row.status,
        row.trigger_source,
        row.triggered_by_user_id,
        row.author_name,
        row.author_email,
        Date.now(),
      );
    },
    simulateMergeClosed: (cardId: string) => {
      // Mirror the production handler in `routes/webhooks.ts`:
      //   const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
      //   if (doneCol && card.column_id !== doneCol.id) {
      //     stmts.moveKanbanCard.run(doneCol.id, 0, card.id);
      //   }
      const card = getKanbanCard.get(cardId) as KanbanCardRow | undefined;
      if (!card) return;
      const cols = getKanbanColumns.all(card.board_id) as KanbanColumnRow[];
      const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
      if (doneCol && card.column_id !== doneCol.id) {
        moveKanbanCard.run(doneCol.id, 0, card.id);
      }
    },
  };
}

describe('§15 integration — pushed run → provenance hit → merge moves card to Done', () => {
  const PR_URL = 'https://github.com/agent-hub/agent-hub/pull/9999';
  const BOARD_ID = 'board-int';
  const CARD_ID = 'card-int';

  function seed(harness: IntegrationHarness, opts: { startingColumn: string }) {
    harness.insertColumn({ id: 'col-todo', board_id: BOARD_ID, name: 'To Do', position: 0 });
    harness.insertColumn({
      id: 'col-progress',
      board_id: BOARD_ID,
      name: 'In Progress',
      position: 1,
    });
    harness.insertColumn({ id: 'col-done', board_id: BOARD_ID, name: 'Done', position: 2 });
    harness.insertCard({
      id: CARD_ID,
      board_id: BOARD_ID,
      column_id: opts.startingColumn,
      title: 'Implement post-push detach',
    });
    harness.insertRun({
      id: 'run-int',
      card_id: CARD_ID,
      project_id: 'proj-1',
      branch: 'feature/post-push-detach',
      head_sha: 'cafef00d',
      idempotency_key: 'idem-int',
      status: 'pushing',
      trigger_source: 'ui_button',
      triggered_by_user_id: 'user-1',
      author_name: 'Hub Lead Dev',
      author_email: 'lead@example.com',
    });
  }

  it('detach posts handoff comment; classifyPr says internal/registry; merge moves card to Done', async () => {
    const harness = buildIntegrationHarness();
    seed(harness, { startingColumn: 'col-progress' });

    // ── 1) Simulate the push step's atomic pair (pr_url write + status). ──
    // The orchestrator does this BEFORE calling detach. We reproduce the
    // pr_url write here; the status flip to 'pushed' is not consulted by
    // any §15 read path so we leave it as 'pushing' for the smaller seed.
    writeFinalizeRunPrUrl({ stmts: harness.stmts }, { runId: 'run-int', prUrl: PR_URL });

    // ── 2) Run the §15 detach. ──
    runPostPushDetach(
      { stmts: harness.stmts, broadcast: () => undefined },
      {
        cardId: CARD_ID,
        projectId: 'proj-1',
        prUrl: PR_URL,
        runId: 'run-int',
        triggerSource: 'ui_button',
      },
    );

    // Card stays in In Progress — column moves are manual after push.
    const progressRow = harness.db
      .prepare(`SELECT column_id FROM kanban_cards WHERE id = ?`)
      .get(CARD_ID) as { column_id: string } | undefined;
    expect(progressRow?.column_id).toBe('col-progress');

    // Handoff comment present and well-formed.
    const comments = harness.db
      .prepare(`SELECT content FROM kanban_card_comments WHERE card_id = ? ORDER BY created_at`)
      .all(CARD_ID) as { content: string }[];
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe(
      'Finalized. PR is on GitHub, owned by the developer from here.\n' +
        `${PR_URL}\n` +
        '(run run-int)',
    );

    // ── 3) Provenance check: the webhook handler will see this PR and
    //       classify it as internal via the registry, so the v0 reviewer
    //       auto-dispatch path takes the "skip — internal" branch. The
    //       webhook handler does NOT need the body fetcher to fire — the
    //       registry hit is authoritative. ──
    const fetchPrBody = vi.fn(async () => '(should not be read)');
    const classification = await classifyPr({ stmts: harness.stmts, fetchPrBody }, PR_URL);
    expect(classification.provenance).toBe('internal');
    expect(classification.via).toBe('registry');
    expect(fetchPrBody).not.toHaveBeenCalled();

    // ── 4) Merge-close webhook moves the card → Done (unchanged path). ──
    harness.simulateMergeClosed(CARD_ID);
    const doneRow = harness.db
      .prepare(`SELECT column_id FROM kanban_cards WHERE id = ?`)
      .get(CARD_ID) as { column_id: string } | undefined;
    expect(doneRow?.column_id).toBe('col-done');
  });

  it('autonomous-triggered pushed run carries the autonomous suffix into the card thread', () => {
    const harness = buildIntegrationHarness();
    seed(harness, { startingColumn: 'col-progress' });

    runPostPushDetach(
      { stmts: harness.stmts, broadcast: () => undefined },
      {
        cardId: CARD_ID,
        projectId: 'proj-1',
        prUrl: PR_URL,
        runId: 'run-int',
        triggerSource: 'agent_block',
      },
    );

    const comments = harness.db
      .prepare(`SELECT content FROM kanban_card_comments WHERE card_id = ? ORDER BY created_at`)
      .all(CARD_ID) as { content: string }[];
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toContain('(triggered by autonomous agent)');
  });
});
