import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_TASK_STARTUP_GRACE_MS,
  isBackgroundTaskLive,
} from './background-task-liveness.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const stmtsWith = (row: unknown) => ({ getActiveTask: { get: () => row } }) as any;

describe('isBackgroundTaskLive', () => {
  it('is live when the session has an in-flight active_tasks row', () => {
    expect(
      isBackgroundTaskLive(
        stmtsWith({}),
        { session_id: 's', created_at: '2026-01-01 00:00:00' },
        NOW,
      ),
    ).toBe(true);
  });

  it('is live inside the startup grace window even before active_tasks exists', () => {
    expect(
      isBackgroundTaskLive(
        stmtsWith(undefined),
        { session_id: 's', created_at: '2026-10-23 11:59:30' },
        NOW,
      ),
    ).toBe(true);
  });

  it('is stale once past the grace window with no active_tasks row', () => {
    const old = new Date(NOW - BACKGROUND_TASK_STARTUP_GRACE_MS - 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    expect(
      isBackgroundTaskLive(stmtsWith(undefined), { session_id: 's', created_at: old }, NOW),
    ).toBe(false);
  });

  it('is stale when created_at is missing or unparseable', () => {
    expect(isBackgroundTaskLive(stmtsWith(undefined), { session_id: 's' }, NOW)).toBe(false);
    expect(
      isBackgroundTaskLive(stmtsWith(undefined), { session_id: 's', created_at: 'nope' }, NOW),
    ).toBe(false);
  });
});
