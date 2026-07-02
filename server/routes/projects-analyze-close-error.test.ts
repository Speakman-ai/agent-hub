/**
 * Regression test for the project-analysis "Process exited with code 1" bug.
 *
 * The Claude Code CLI reports fatal conditions (expired login
 * "Not logged in · Please run /login", model-access denied, quota) on
 * stdout as a stream-json `result` event with `is_error: true`, and writes
 * NOTHING to stderr before exiting non-zero. The analyze handler used to
 * surface `stderr || 'Process exited with code N'`, so users only ever saw
 * the useless bare-code message. `resolveAnalyzeCloseErrorDetail` now prefers
 * stderr, then the stream error text, then the bare code.
 */
import { describe, it, expect } from 'vitest';
import { resolveAnalyzeCloseErrorDetail } from './projects.js';

describe('resolveAnalyzeCloseErrorDetail', () => {
  it('surfaces the stream error text when stderr is empty (the auth-failure repro)', () => {
    expect(
      resolveAnalyzeCloseErrorDetail({
        code: 1,
        stderr: '',
        streamErrorText: 'Not logged in · Please run /login',
      }),
    ).toBe('Not logged in · Please run /login');
  });

  it('prefers real stderr over the stream error text', () => {
    expect(
      resolveAnalyzeCloseErrorDetail({
        code: 1,
        stderr: 'ENOENT: claude binary not found\n',
        streamErrorText: 'Not logged in · Please run /login',
      }),
    ).toBe('ENOENT: claude binary not found');
  });

  it('falls back to the bare exit code only when nothing else is available', () => {
    expect(resolveAnalyzeCloseErrorDetail({ code: 1, stderr: '   ', streamErrorText: '' })).toBe(
      'Process exited with code 1',
    );
  });

  it('reports a null exit code without throwing', () => {
    expect(resolveAnalyzeCloseErrorDetail({ code: null, stderr: '', streamErrorText: '' })).toBe(
      'Process exited with code null',
    );
  });
});
