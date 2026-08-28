import { describe, expect, it } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { normalizeKanbanTitle } from '../kanban-title.js';

// Regression guard for the hot-path scans that stalled the event loop:
// getKanbanCardBySession (every chat message / session-state recompute) and the
// epic/phase recompute queries (every card move) fell back to full-table scans
// because kanban_cards had no index on session_id / epic_id / phase_id. Importing
// ../db.js runs migrations against the scratch DB set up by test/setup.ts.
describe('kanban_cards hot-path indexes', () => {
  it('indexes session_id, epic_id, and phase_id, and the session lookup uses its index', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }

    await expect(import('../db.js')).resolves.toBeDefined();

    const dbPath = path.join(dataDir, 'agent-hub.db');
    const verify = new Database(dbPath, { readonly: true });
    // The dedup expression index references the app-defined kanban_title_norm
    // function, so any connection preparing a query against it must register it.
    verify.function('kanban_title_norm', { deterministic: true }, (value: unknown) =>
      normalizeKanbanTitle(value),
    );
    try {
      const indexes = (verify.pragma('index_list(kanban_cards)') as { name: string }[]).map(
        (i) => i.name,
      );
      expect(indexes).toContain('idx_kanban_cards_session');
      expect(indexes).toContain('idx_kanban_cards_epic');
      expect(indexes).toContain('idx_kanban_cards_phase');
      // Expression index backing the Unicode-normalized title dedup lookup.
      expect(indexes).toContain('idx_kanban_cards_board_title_ci');

      // The planner must actually use the session index rather than scan the
      // whole table — an index that exists but is bypassed would not fix the hang.
      const plan = verify
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM kanban_cards WHERE session_id = ? LIMIT 1')
        .all('some-session') as { detail: string }[];
      const planText = plan.map((r) => r.detail).join(' ');
      expect(planText).toMatch(/idx_kanban_cards_session/);
      expect(planText).not.toMatch(/SCAN kanban_cards\b(?!.*USING INDEX)/);

      // The dedup lookup must SEARCH via the expression index, not SCAN + normalize
      // every title on the board (the event-loop-blocking behavior being removed).
      const dedupPlan = verify
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM kanban_cards WHERE board_id = ? AND kanban_title_norm(title) = ? ORDER BY position ASC LIMIT 1',
        )
        .all('some-board', 'some title') as { detail: string }[];
      const dedupPlanText = dedupPlan.map((r) => r.detail).join(' ');
      expect(dedupPlanText).toMatch(/idx_kanban_cards_board_title_ci/);
      expect(dedupPlanText).not.toMatch(/SCAN kanban_cards\b(?!.*USING INDEX)/);
    } finally {
      verify.close();
    }
  });
});
