/**
 * Regression: native-PR author attribution must be resolved BEFORE the push
 * side effect in autoCommitAndPR. Resolving it after the push (the previous
 * behavior) would, on an auth-enabled deployment with no attributed Hub user,
 * return `pr_failed` only after the remote branch was already created/updated —
 * leaving a dangling pushed branch with no PR.
 *
 * autoCommitAndPR is a large monolith that mocks `fs`/`child_process` wholesale
 * in auto-git.test.ts, so this isolated source-structure check (mirroring the
 * precedent in process-termination.test.ts) is the cheapest way to lock the
 * ordering invariant without standing up the full hosted push pipeline.
 */
import './test/setup.js';
import { describe, it, expect } from 'vitest';

describe('auto-git hosted attribution ordering', () => {
  it('resolves the native-PR author before building the push args', async () => {
    const { readFile } = await import('fs/promises');
    const src = await readFile(new URL('./auto-git.ts', import.meta.url), 'utf8');

    const resolveIdx = src.indexOf(
      'hostedAuthorUserId = resolveNativePrAuthorUserId({ sessionId })',
    );
    const pushIdx = src.indexOf('const pushArgs = buildPushArgs(');

    expect(resolveIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    // Attribution must be resolved strictly before the push is assembled/run.
    expect(resolveIdx).toBeLessThan(pushIdx);

    // And the resolution must be guarded so it only runs for hosted projects.
    const guardIdx = src.lastIndexOf('if (hosted) {', resolveIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(resolveIdx);
  });
});
