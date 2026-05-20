import { describe, it, expect } from 'vitest';
import {
  humanizeCommitSubject,
  parseReleaseMarkdownBody,
  buildUserFacingSections,
  summarizeRelease,
  buildUserFacingRelease,
} from './user-facing-release-notes.js';

describe('humanizeCommitSubject', () => {
  it('turns feat commits into plain language', () => {
    expect(humanizeCommitSubject('feat(kanban): add release page')).toBe(
      'Added Release page (kanban)',
    );
  });

  it('turns fix commits into plain language', () => {
    expect(humanizeCommitSubject('fix: webhook race on merge')).toBe('Fixed Webhook race on merge');
  });

  it('marks breaking changes', () => {
    expect(humanizeCommitSubject('feat!: drop node 18')).toContain('Breaking:');
  });
});

describe('parseReleaseMarkdownBody', () => {
  it('parses sections from generated release notes', () => {
    const body = `## v1.2.0

### Features

- feat(ui): show changelog (abc1234)

### Bug Fixes

- fix(server): handle timeout (deadbee)
`;
    const rows = parseReleaseMarkdownBody(body);
    expect(rows).toHaveLength(2);
    expect(rows[0].section).toBe('Features');
    expect(rows[1].section).toBe('Bug Fixes');
  });
});

describe('buildUserFacingRelease', () => {
  it('groups into user-facing sections and builds a summary', () => {
    const release = buildUserFacingRelease({
      tag: 'v1.2.0',
      body: `### Features\n\n- feat(chat): stream tool cards (abc1234)\n\n### Bug Fixes\n\n- fix: null session id (deadbee)\n`,
      publishedAt: '2025-01-01T00:00:00Z',
      url: 'https://github.com/example/agent-hub/releases/tag/v1.2.0',
    });
    expect(release.version).toBe('1.2.0');
    expect(release.sections.map((s) => s.title)).toEqual(["What's new", 'Bug fixes']);
    expect(release.summary).toContain('tool cards');
  });

  it('omits developer-only sections by default', () => {
    const release = buildUserFacingRelease({
      tag: 'v1.0.1',
      body: `### Chores\n\n- chore: bump deps (aaaaaaa)\n\n### Features\n\n- feat: new button (bbbbbbb)\n`,
    });
    expect(release.sections.some((s) => s.title === 'Chores')).toBe(false);
    expect(release.sections.some((s) => s.title === "What's new")).toBe(true);
  });
});

describe('summarizeRelease', () => {
  it('falls back when there are no sections', () => {
    expect(summarizeRelease([])).toMatch(/updates and improvements/i);
  });
});
