import { describe, it, expect } from 'vitest';
import {
  parseLogLine,
  groupCommits,
  renderReleaseNotes,
  parseArgs,
} from './format-release-notes.mjs';

describe('parseLogLine', () => {
  it('parses a conventional-commit line', () => {
    expect(parseLogLine('- feat(api): add /foo route (abc1234)')).toEqual({
      subject: 'feat(api): add /foo route',
      hash: 'abc1234',
      category: 'feat',
    });
  });

  it('parses fix without scope', () => {
    expect(parseLogLine('- fix: null check in parser (deadbee)')).toEqual({
      subject: 'fix: null check in parser',
      hash: 'deadbee',
      category: 'fix',
    });
  });

  it('handles breaking-change marker', () => {
    expect(parseLogLine('- feat!: drop node 18 (1234567)')).toEqual({
      subject: 'feat!: drop node 18',
      hash: '1234567',
      category: 'feat',
    });
  });

  it('buckets unknown type into other', () => {
    expect(parseLogLine('- wip: scratch commit (abcdef0)')?.category).toBe('other');
  });

  it('buckets non-conventional subjects into other', () => {
    const parsed = parseLogLine('- Make the widget blue (0123456)');
    expect(parsed?.category).toBe('other');
    expect(parsed?.subject).toBe('Make the widget blue');
  });

  it('returns null on blank lines', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('   ')).toBeNull();
  });

  it('returns null on malformed lines', () => {
    expect(parseLogLine('no dash prefix (abc1234)')).toBeNull();
    expect(parseLogLine('- missing hash')).toBeNull();
  });

  it('accepts long (40-char) commit hashes', () => {
    const parsed = parseLogLine('- chore: bump (0123456789abcdef0123456789abcdef01234567)');
    expect(parsed?.hash).toBe('0123456789abcdef0123456789abcdef01234567');
  });
});

describe('groupCommits', () => {
  it('groups commits by category', () => {
    const commits = [
      { subject: 'feat: a', hash: '1', category: 'feat' },
      { subject: 'fix: b', hash: '2', category: 'fix' },
      { subject: 'feat: c', hash: '3', category: 'feat' },
    ];
    const grouped = groupCommits(commits);
    expect(grouped.get('feat')).toHaveLength(2);
    expect(grouped.get('fix')).toHaveLength(1);
  });
});

describe('renderReleaseNotes', () => {
  it('renders categorized sections in documented order', () => {
    const commits = [
      { subject: 'chore: c', hash: 'c0000000', category: 'chore' },
      { subject: 'feat: a', hash: 'a0000000', category: 'feat' },
      { subject: 'fix: b', hash: 'b0000000', category: 'fix' },
    ];
    const md = renderReleaseNotes({
      version: 'v1.2.3',
      previous: 'v1.2.2',
      commits,
      repo: 'Speakman-ai/agent-hub',
    });
    expect(md).toContain('## v1.2.3');
    // Features section comes before Bug Fixes which comes before Chores.
    const featIdx = md.indexOf('### Features');
    const fixIdx = md.indexOf('### Bug Fixes');
    const choreIdx = md.indexOf('### Chores');
    expect(featIdx).toBeGreaterThan(-1);
    expect(fixIdx).toBeGreaterThan(featIdx);
    expect(choreIdx).toBeGreaterThan(fixIdx);
    expect(md).toContain(
      '**Full Changelog**: https://github.com/Speakman-ai/agent-hub/compare/v1.2.2...v1.2.3',
    );
  });

  it('renders an "Other" section for non-conventional commits', () => {
    const commits = [{ subject: 'Just a fix', hash: 'deadbee', category: 'other' }];
    const md = renderReleaseNotes({
      version: 'v1.0.0',
      previous: null,
      commits,
    });
    expect(md).toContain('### Other');
    expect(md).toContain('- Just a fix (`deadbee`)');
  });

  it('handles empty commit list gracefully', () => {
    const md = renderReleaseNotes({
      version: 'v1.0.0',
      previous: null,
      commits: [],
    });
    expect(md).toContain('_No user-visible changes since the previous release._');
  });

  it('omits compare link when repo is missing', () => {
    const md = renderReleaseNotes({
      version: 'v1.0.1',
      previous: 'v1.0.0',
      commits: [{ subject: 'feat: x', hash: 'abcdef0', category: 'feat' }],
    });
    expect(md).not.toContain('Full Changelog');
    expect(md).toContain('**Previous release**: v1.0.0');
  });
});

describe('parseArgs', () => {
  it('parses --flag value pairs', () => {
    expect(parseArgs(['--version', 'v1.2.3', '--previous', 'v1.2.2'])).toEqual({
      version: 'v1.2.3',
      previous: 'v1.2.2',
    });
  });

  it('treats a lone --flag as boolean true', () => {
    expect(parseArgs(['--verbose', '--version', 'v1'])).toEqual({
      verbose: true,
      version: 'v1',
    });
  });
});
