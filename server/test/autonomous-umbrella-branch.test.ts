/**
 * Unit tests for the autonomous-mode umbrella feature branch logic.
 *
 * `createUmbrellaBranch` is tested in isolation by mocking child_process so
 * no real git operations happen. We verify:
 *   1. Branch names follow the `feature/autonomous-{epicId8}-{uuid8}` pattern.
 *   2. The function calls `git fetch` then `git rev-parse` then `git push`.
 *   3. It falls back gracefully when the remote ref can't be resolved.
 *   4. It falls back gracefully when git push fails.
 *
 * The integration-level contract (epic.pr_base_branch is set in DB after the
 * first dispatch tick) is verified by inspecting the kanban_epics row after
 * triggering the loop — but that requires a real running server so we skip it
 * here; the DB query path is covered by existing autonomous-eligible-order tests.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mock child_process BEFORE importing the module under test ──────────────
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from 'child_process';
import { createUmbrellaBranch } from '../autonomous.js';
import type { KanbanEpicRow, Project } from '../types.js';

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// Minimal fake project + epic for the helper
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    cwd: '/tmp/fake-repo',
    ahw: '/tmp/fake-workspace',
    agents: [],
    ...overrides,
  } as unknown as Project;
}

function makeEpic(overrides: Partial<KanbanEpicRow> = {}): KanbanEpicRow {
  return {
    id: 'aabbccdd-eeff-0011-2233-445566778899',
    board_id: 'board-1',
    name: 'Test Epic',
    description: null,
    color: '#3B82F6',
    autonomous: 1,
    autonomous_interval: 60,
    autonomous_max_concurrent: 2,
    autonomous_max_iterations: 3,
    autonomous_model: null,
    orchestration_budgets_json: null,
    pr_base_branch: null,
    position: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Simulate a successful execFile call returning stdout. */
function mockExecSuccess(stdout: string) {
  return (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...args: unknown[]) => void) => {
    cb(null, { stdout, stderr: '' });
  };
}

/** Simulate a failing execFile call. */
function mockExecFail(msg: string) {
  return (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...args: unknown[]) => void) => {
    cb(new Error(msg), { stdout: '', stderr: '' });
  };
}

beforeEach(() => {
  mockedExecFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createUmbrellaBranch', () => {
  it('returns a branch name matching the feature/autonomous- prefix pattern', async () => {
    // fetch → success, rev-parse origin/HEAD → sha, push → success
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // git fetch origin --depth=1
          expect(args).toContain('fetch');
          cb(null, { stdout: '', stderr: '' });
        } else if (callIdx === 2) {
          // git rev-parse origin/HEAD
          expect(args).toContain('rev-parse');
          cb(null, { stdout: 'abc1234567890def\n', stderr: '' });
        } else {
          // git push origin sha:refs/heads/...
          expect(args).toContain('push');
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).not.toBeNull();
    expect(result).toMatch(/^feature\/autonomous-[a-f0-9]{8}-[a-f0-9]{8}$/);
  });

  it('falls back to origin/main when origin/HEAD resolution fails', async () => {
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // fetch
          cb(null, { stdout: '', stderr: '' });
        } else if (callIdx === 2) {
          // rev-parse origin/HEAD → fail
          cb(new Error('unknown ref'), { stdout: '', stderr: '' });
        } else if (callIdx === 3) {
          // rev-parse origin/main → success
          expect(args).toContain('rev-parse');
          expect(args).toContain('origin/main');
          cb(null, { stdout: 'deadbeef1234\n', stderr: '' });
        } else {
          // push
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).toMatch(/^feature\/autonomous-/);
  });

  it('returns null when all ref resolutions fail', async () => {
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // fetch
          cb(null, { stdout: '', stderr: '' });
        } else {
          // all rev-parse attempts fail
          cb(new Error('bad ref'), { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).toBeNull();
  });

  it('returns null when git push fails', async () => {
    let callIdx = 0;
    mockedExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
        callIdx++;
        if (callIdx === 1) {
          // fetch
          cb(null, { stdout: '', stderr: '' });
        } else if (callIdx === 2) {
          // rev-parse origin/HEAD
          cb(null, { stdout: 'abc123\n', stderr: '' });
        } else {
          // push → fail
          cb(new Error('permission denied'), { stdout: '', stderr: '' });
        }
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic());
    expect(result).toBeNull();
  });

  it('returns null immediately when project.cwd is empty', async () => {
    const result = await createUmbrellaBranch(makeProject({ cwd: '' }), makeEpic());
    expect(result).toBeNull();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('embeds the first 8 hex chars of the epic id (dashes stripped) in the branch name', async () => {
    const epicId = 'aabbccdd-eeff-0011-2233-445566778899';
    // 'aabbccdd-eeff-...' → remove dashes → 'aabbccddeeff...' → first 8 → 'aabbccdd'
    const expectedPrefix = 'aabbccdd';

    mockedExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(null, { stdout: 'sha123\n', stderr: '' });
      },
    );

    const result = await createUmbrellaBranch(makeProject(), makeEpic({ id: epicId }));
    expect(result).toMatch(new RegExp(`^feature\\/autonomous-${expectedPrefix}-`));
  });
});
