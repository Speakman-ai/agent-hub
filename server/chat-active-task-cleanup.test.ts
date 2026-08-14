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

  it('clears active_tasks + drains when staging chat attachments fails', () => {
    // Attachment staging (uploadFile into an env-owned guest, copyFileSync on
    // host) runs AFTER the active_tasks row is inserted and the session is
    // broadcast working. A disk-full / guest-write / unreadable-source failure
    // must run the same cleanup, not leave the session stuck working.
    const uploadIdx = src.indexOf('await sessionEnv.worktreeIo.uploadFile(destRel, srcPath)');
    expect(uploadIdx).toBeGreaterThan(-1);
    const markerIdx = src.indexOf('Failed to stage attachments for this turn:', uploadIdx);
    // The failure handler must sit after the upload call (i.e. it catches it).
    expect(markerIdx).toBeGreaterThan(uploadIdx);
    const window = src.slice(markerIdx, markerIdx + 900);
    expect(window).toContain('saveErrorMessage(sessionId, assistantMsgId, engine, model');
    expect(window).toContain('stmts.deleteActiveTask.run(sessionId)');
    expect(window).toContain('recomputeSessionState');
    expect(window).toContain('drainQueue(sessionId)');
    expect(window).toContain('return;');
  });
});
