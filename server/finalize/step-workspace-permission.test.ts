import { describe, it, expect } from 'vitest';
import { isRunnerWorkspacePermissionError } from './step-workspace-permission.js';

describe('isRunnerWorkspacePermissionError', () => {
  // The exact npm shape from the reported Finalize failure (support ticket
  // 63e1aace): every install step died with EACCES mkdir on the workspace mount.
  const NPM_EACCES_TAIL = [
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error path /github/workspace/node_modules',
    'npm error errno -13',
    "npm error Error: EACCES: permission denied, mkdir '/github/workspace/node_modules'",
    'npm error The operation was rejected by your operating system.',
  ];

  it('matches the canonical npm EACCES-on-workspace install failure', () => {
    expect(isRunnerWorkspacePermissionError({ tail: NPM_EACCES_TAIL })).toBe(true);
  });

  it('matches an npm error record whose code and workspace path are on separate field lines', () => {
    // Rule 2: npm's structured fields form one error record — the workspace-rooted
    // `npm error path` associates with the `npm error code EACCES` field even
    // without the combined `Error:` line (e.g. a truncated tail).
    expect(
      isRunnerWorkspacePermissionError({
        tail: ['npm error code EACCES', 'npm error path /github/workspace/node_modules'],
      }),
    ).toBe(true);
  });

  it('matches a bare shell mkdir permission-denied under the workspace', () => {
    expect(
      isRunnerWorkspacePermissionError({
        tail: ["mkdir: cannot create directory '/github/workspace/.cache': Permission denied"],
      }),
    ).toBe(true);
  });

  it('matches a Python venv PermissionError under the workspace', () => {
    expect(
      isRunnerWorkspacePermissionError({
        tail: ["PermissionError: [Errno 13] Permission denied: '/github/workspace/.venv/bin'"],
      }),
    ).toBe(true);
  });

  it('matches when the signal is in the excerpt rather than the tail', () => {
    expect(
      isRunnerWorkspacePermissionError({
        tail: ['some later unrelated line'],
        excerpt: ['npm error code EACCES', 'npm error path /github/workspace/server/node_modules'],
      }),
    ).toBe(true);
  });

  it('matches EACCES on a bare workspace-root path (no trailing subdir)', () => {
    expect(
      isRunnerWorkspacePermissionError({
        tail: ["Error: EACCES: permission denied, open '/github/workspace'"],
      }),
    ).toBe(true);
  });

  it('sees through ANSI colour codes around EACCES', () => {
    expect(
      isRunnerWorkspacePermissionError({
        tail: ['[31mnpm error code EACCES[0m', 'npm error path /github/workspace/node_modules'],
      }),
    ).toBe(true);
  });

  it('does NOT match a permission error outside the workspace mount', () => {
    // A permission fault elsewhere (a global/home path) is not the workspace
    // bind-mount fault this detector reclassifies.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'npm error code EACCES',
          "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
        ],
      }),
    ).toBe(false);
  });

  it('does NOT match a workspace path with no permission-denied signal', () => {
    expect(
      isRunnerWorkspacePermissionError({
        tail: ['Running tests in /github/workspace/server', 'FAIL src/foo.test.ts', '1 failed'],
      }),
    ).toBe(false);
  });

  it('does NOT match a sibling path that only shares the workspace prefix', () => {
    // `/github/workspace-backup` must not be read as the `/github/workspace` mount.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'npm error code EACCES',
          "npm error permission denied, mkdir '/github/workspace-backup/node_modules'",
        ],
      }),
    ).toBe(false);
  });

  it('does NOT match when a workspace cwd log co-occurs with an EACCES on an unrelated path (mixed output)', () => {
    // The reviewer's scenario: the workspace path appears only as a working-dir
    // log line, and the actual permission failure is on an unrelated path. The
    // two must NOT be associated across lines, or a genuine failure is masked and
    // a pointless infra retry fires.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'entering directory /github/workspace/server',
          'running postinstall...',
          "Error: EACCES: permission denied, open '/usr/local/share/.config/x'",
        ],
      }),
    ).toBe(false);
  });

  it('does NOT match an npm record whose path field is unrelated, even beside a workspace cwd line', () => {
    // Rule 2 must key off the npm `path` field, not any stray workspace mention.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'building in /github/workspace',
          'npm error code EACCES',
          'npm error syscall mkdir',
          'npm error path /home/runner/.npm/_cacache',
          'npm error errno -13',
        ],
      }),
    ).toBe(false);
  });

  it('does NOT pair a permission code and a workspace path from two SEPARATE npm records', () => {
    // Record 1 is a real EACCES, but on the npm cache — not the workspace. A
    // separate later record (broken by a non-npm-error line) has a workspace
    // path but a DIFFERENT, non-permission error code. Neither record carries
    // both fields, so this must stay CI-class.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'npm error code EACCES',
          'npm error syscall mkdir',
          'npm error path /home/runner/.npm/_cacache',
          'npm error errno -13',
          '+ npm ci --prefix client', // non-npm-error line closes record 1
          'npm error code ELIFECYCLE',
          'npm error path /github/workspace/client',
        ],
      }),
    ).toBe(false);
  });

  it('does NOT pair an npm code field in the tail with a workspace path field in the excerpt', () => {
    // Fields from different output windows must never associate.
    expect(
      isRunnerWorkspacePermissionError({
        tail: ['npm error code EACCES', 'npm error path /home/runner/.npm/_cacache'],
        excerpt: ['npm error path /github/workspace/node_modules'],
      }),
    ).toBe(false);
  });

  it('does NOT pair fields across two npm records separated by a real blank line', () => {
    // A blank line is npm's boundary between two separate error blocks. The first
    // block's EACCES is on ~/.npm; the second block (after the blank) has the
    // workspace path but a non-permission code. They must not merge into one
    // record, so this stays CI-class.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'npm error code EACCES',
          'npm error path /home/runner/.npm/_cacache',
          'npm error errno -13',
          '', // real blank line = record boundary
          'npm error code ELIFECYCLE',
          'npm error path /github/workspace/client',
        ],
      }),
    ).toBe(false);
  });

  it('still matches when the workspace EACCES block follows a blank-separated warning block', () => {
    // The blank breaks the leading (non-error) block; the trailing block is a
    // genuine single-record workspace EACCES and must still classify.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'npm warn deprecated foo@1.0.0',
          '',
          'npm error code EACCES',
          'npm error path /github/workspace/node_modules',
          'npm error errno -13',
        ],
      }),
    ).toBe(true);
  });

  it('matches a single npm record even with bare `npm error` spacer lines inside it', () => {
    // Bare spacer lines are part of the same contiguous record and must not
    // break the association.
    expect(
      isRunnerWorkspacePermissionError({
        tail: [
          'npm error code EACCES',
          'npm error',
          'npm error path /github/workspace/node_modules',
          'npm error errno -13',
        ],
      }),
    ).toBe(true);
  });

  it('returns false on empty / blank input', () => {
    expect(isRunnerWorkspacePermissionError({ tail: [] })).toBe(false);
    expect(isRunnerWorkspacePermissionError({ tail: ['', '   '] })).toBe(false);
  });
});
