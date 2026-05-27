import { describe, it, expect } from 'vitest';
import {
  ensureLinearKanbanSyncTimeout,
  LINEAR_KANBAN_SYNC_PROMPT,
  buildSyntheticResolvedForLinearSync,
} from './linear-kanban-sync-cron.js';
import { LINEAR_KANBAN_SYNC_DEFAULT_TIMEOUT_MS } from './linear-kanban-sync-config.js';
import { stmts } from './db.js';

const testStmts = stmts!;
import type { CronRow } from './types.js';

describe('buildSyntheticResolvedForLinearSync', () => {
  it('returns claude-code engine metadata without spawning', () => {
    const r = buildSyntheticResolvedForLinearSync(null);
    expect(r.engine).toBe('claude-code');
    expect(r.fallbackUsed).toBe(false);
    expect(r.availability['claude-code'].available).toBe(true);
  });
});

describe('ensureLinearKanbanSyncTimeout', () => {
  it('raises timeout_ms to 45 minutes when null', () => {
    const created = testStmts.createCron.run(
      'linear-kanban-sync-test',
      '0 * * * *',
      'old prompt',
      '/tmp',
      1,
      'surveytracker',
      null,
      0,
      null,
      null,
      null,
    );
    const id = Number(created.lastInsertRowid);
    const row = testStmts.getCron.get(id) as CronRow;
    const ms = ensureLinearKanbanSyncTimeout(testStmts, row);
    expect(ms).toBe(LINEAR_KANBAN_SYNC_DEFAULT_TIMEOUT_MS);
    const updated = testStmts.getCron.get(id) as CronRow;
    expect(updated.timeout_ms).toBe(LINEAR_KANBAN_SYNC_DEFAULT_TIMEOUT_MS);
    expect(updated.prompt).toBe(LINEAR_KANBAN_SYNC_PROMPT);
    testStmts.deleteCron.run(id);
  });
});

describe('buildSyntheticResolvedForLinearSync', () => {
  it('returns a full availability map without spawning a CLI', () => {
    const resolved = buildSyntheticResolvedForLinearSync(null);
    expect(resolved.engine).toBe('claude-code');
    expect(resolved.fallbackUsed).toBe(false);
    expect(resolved.availability['cursor-agent'].available).toBe(false);
    expect(resolved.availability['claude-code'].available).toBe(true);
  });
});
