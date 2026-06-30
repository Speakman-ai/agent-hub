import { describe, it, expect, vi } from 'vitest';
import { collectReleaseRangeLinks, parsePrNumberFromSubject } from './release-range.js';

const REC_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/** Build the `git log --format=%H\x1f%s\x1e` machine output the collector parses. */
function gitLog(commits: Array<{ sha: string; subject: string }>): string {
  return commits.map((c) => `${c.sha}${FIELD_SEP}${c.subject}${REC_SEP}`).join('\n');
}

describe('parsePrNumberFromSubject', () => {
  it('parses a squash-merge subject ending in (#N)', () => {
    expect(parsePrNumberFromSubject('Fix the deploy resolver (#392)')).toBe(392);
  });

  it('parses a merge-method subject "Merge pull request #N ..."', () => {
    expect(parsePrNumberFromSubject('Merge pull request #41 from agent-hub/dev/session-x')).toBe(
      41,
    );
  });

  it('ignores a bare #N reference that is not in a merge/squash position', () => {
    expect(parsePrNumberFromSubject('Revert change discussed in #99 thread')).toBeNull();
    expect(parsePrNumberFromSubject('chore: bump deps')).toBeNull();
  });

  it('rejects non-positive / non-numeric PR numbers', () => {
    expect(parsePrNumberFromSubject('weird (#0)')).toBeNull();
    expect(parsePrNumberFromSubject('weird (#)')).toBeNull();
  });
});

describe('collectReleaseRangeLinks', () => {
  const base = {
    worktreePath: '/tmp/deploy-wt',
    projectId: 'agent-hub',
    currentRef: 'mainHEAD',
    previousRef: 'prevHEAD',
  };

  it('collects in-range commit SHAs and native PR URLs from subjects', async () => {
    const runGit = vi.fn().mockResolvedValue(
      gitLog([
        { sha: 'sha_merge', subject: 'Merge pull request #41 from agent-hub/x' },
        { sha: 'sha_feat', subject: 'Add a thing (#42)' },
        { sha: 'sha_squash', subject: 'Polish copy (#43)' },
        { sha: 'sha_chore', subject: 'chore: nothing linked here' },
      ]),
    );

    const result = await collectReleaseRangeLinks({ ...base, runGit });

    // currentRef is always a candidate ref, plus every in-range SHA.
    expect(result.refs).toContain('mainHEAD');
    expect(result.refs).toEqual(
      expect.arrayContaining(['sha_merge', 'sha_feat', 'sha_squash', 'sha_chore']),
    );
    // Native PR URLs only from the two merge/squash positions.
    expect(result.prUrls).toEqual([
      '/projects/agent-hub/pulls/41',
      '/projects/agent-hub/pulls/42',
      '/projects/agent-hub/pulls/43',
    ]);

    // Range is bounded by previousRef..currentRef.
    expect(runGit).toHaveBeenCalledWith(
      expect.arrayContaining(['log', 'prevHEAD..mainHEAD']),
      '/tmp/deploy-wt',
    );
  });

  it('falls back to the deployed ref alone when there is no previous ref (first deploy)', async () => {
    const runGit = vi.fn();
    const result = await collectReleaseRangeLinks({ ...base, previousRef: null, runGit });
    expect(result).toEqual({ refs: ['mainHEAD'], prUrls: [] });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('falls back when previousRef equals currentRef (no-op re-deploy)', async () => {
    const runGit = vi.fn();
    const result = await collectReleaseRangeLinks({
      ...base,
      previousRef: 'mainHEAD',
      runGit,
    });
    expect(result).toEqual({ refs: ['mainHEAD'], prUrls: [] });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('falls back to the deployed ref alone when git throws (e.g. shallow clone)', async () => {
    const runGit = vi.fn().mockRejectedValue(new Error('fatal: bad revision'));
    const result = await collectReleaseRangeLinks({ ...base, runGit });
    expect(result).toEqual({ refs: ['mainHEAD'], prUrls: [] });
  });

  it('dedupes repeated SHAs and PR URLs', async () => {
    const runGit = vi.fn().mockResolvedValue(
      gitLog([
        { sha: 'sha_a', subject: 'thing (#7)' },
        { sha: 'sha_a', subject: 'thing (#7)' },
      ]),
    );
    const result = await collectReleaseRangeLinks({ ...base, runGit });
    expect(result.refs.filter((r) => r === 'sha_a')).toHaveLength(1);
    expect(result.prUrls).toEqual(['/projects/agent-hub/pulls/7']);
  });
});
