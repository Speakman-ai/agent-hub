import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Env-owned turns insert `active_tasks` before auth / Cursor chat creation.
 * Early returns on those paths must clear the row or `isSessionChatBusy`
 * parks the session forever. Contract test keeps the cleanup next to the
 * failure returns without standing up the full chat harness.
 */
describe('chat.ts active_tasks cleanup on pre-spawn failures', () => {
  const src = readFileSync(path.join(import.meta.dirname, 'chat.ts'), 'utf8');

  it('clears active_tasks + drains on EngineAuthRequiredError', () => {
    const idx = src.indexOf('if (err instanceof EngineAuthRequiredError)');
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(idx, idx + 1200);
    expect(window).toContain('stmts.deleteActiveTask.run(sessionId)');
    expect(window).toContain('drainQueue(sessionId)');
    expect(window).toContain('recomputeSessionState');
  });

  it('clears active_tasks + drains on Cursor chat create failure', () => {
    const idx = src.indexOf('Failed to create cursor chat:');
    expect(idx).toBeGreaterThan(-1);
    // Look backward for the catch that owns this message, then forward.
    const start = Math.max(0, idx - 400);
    const window = src.slice(start, idx + 800);
    expect(window).toContain('stmts.deleteActiveTask.run(sessionId)');
    expect(window).toContain('drainQueue(sessionId)');
    expect(window).toContain('recomputeSessionState');
  });
});
