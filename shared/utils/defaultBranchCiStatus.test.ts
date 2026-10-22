import { describe, expect, it } from 'vitest';
import { ciOnPushEnabled, defaultBranchCiStatus, latestPushRun } from './defaultBranchCiStatus';

const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  branch: 'main',
  head_sha: 'abcdef1234567890',
  status: 'succeeded',
  trigger_source: 'git_push',
  started_at: 1_000,
  ended_at: 2_000,
  jobs: [{ job_id: 'test', matrix_key: 'default', state: 'passed' }],
  ...over,
});

describe('ciOnPushEnabled', () => {
  it('is true only when ciOnPush.enabled is true', () => {
    expect(ciOnPushEnabled({ ciOnPush: { enabled: true } })).toBe(true);
    expect(ciOnPushEnabled({ ciOnPush: { enabled: false } })).toBe(false);
    expect(ciOnPushEnabled({})).toBe(false);
    expect(ciOnPushEnabled(null)).toBe(false);
  });
});

describe('latestPushRun', () => {
  it('reads the { runs } envelope and keeps only push runs', () => {
    const finalize = run({ id: 'f', trigger_source: 'ui_button', started_at: 9_000 });
    const older = run({ id: 'old', started_at: 500 });
    const newer = run({ id: 'new', started_at: 3_000 });
    expect(latestPushRun({ runs: [finalize, older, newer] })?.id).toBe('new');
    expect(latestPushRun([finalize])).toBeNull();
    expect(latestPushRun(null)).toBeNull();
  });
});

describe('defaultBranchCiStatus', () => {
  it('reports no run yet', () => {
    expect(defaultBranchCiStatus(null).tone).toBe('none');
  });

  it('reports a passing run with its end time', () => {
    const s = defaultBranchCiStatus(run());
    expect(s).toMatchObject({ tone: 'passed', label: 'CI passing on main', at: 2_000 });
    expect(s.sha).toBe('abcdef1234567890');
  });

  it('names failed jobs and shards', () => {
    const s = defaultBranchCiStatus(
      run({
        status: 'failed',
        jobs: [
          { job_id: 'lint', matrix_key: 'default', state: 'failed' },
          { job_id: 'e2e', matrix_key: 'core', state: 'failed' },
          { job_id: 'unit', matrix_key: 'default', state: 'passed' },
        ],
      }),
    );
    expect(s.tone).toBe('failed');
    expect(s.label).toBe('CI failing on main: 2 failed jobs');
    expect(s.failingJobs).toEqual(['lint', 'e2e · core']);
  });

  it('shows running for a non-terminal run, timed from its start', () => {
    const s = defaultBranchCiStatus(run({ status: 'running', ended_at: null }));
    expect(s).toMatchObject({ tone: 'running', label: 'CI running on main', at: 1_000 });
  });

  it('does not call a run passed while a shard is still running', () => {
    const s = defaultBranchCiStatus(
      run({ jobs: [{ job_id: 'e2e', matrix_key: 'a', state: 'running' }] }),
    );
    expect(s.tone).toBe('running');
  });

  it('reports a failed run as failing even with shards still running', () => {
    const s = defaultBranchCiStatus(
      run({
        status: 'failed',
        jobs: [
          { job_id: 'e2e', matrix_key: 'a', state: 'failed' },
          { job_id: 'e2e', matrix_key: 'b', state: 'running' },
        ],
      }),
    );
    expect(s.tone).toBe('failed');
  });
});
