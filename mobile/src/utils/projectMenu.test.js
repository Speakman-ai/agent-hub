import { describe, it, expect } from 'vitest';
import { projectMenuEntries } from './projectMenu.js';

describe('projectMenuEntries', () => {
  it('always includes Board, Threads, Support, Wiki and Notes', () => {
    const keys = projectMenuEntries({}).map((e) => e.key);
    expect(keys).toEqual(['board', 'threads', 'support', 'wiki', 'notes']);
  });

  it('maps each entry to a navigable screen name', () => {
    const byKey = Object.fromEntries(
      projectMenuEntries({ githubRepo: 'x/y' }).map((e) => [e.key, e.screen]),
    );
    expect(byKey).toMatchObject({
      board: 'Kanban',
      threads: 'Threads',
      support: 'CustomerSupport',
      pulls: 'PullRequests',
      wiki: 'Wiki',
      notes: 'Notes',
    });
  });

  it('adds Pulls when the project has a GitHub repo and is not a workflow', () => {
    const keys = projectMenuEntries({ githubRepo: 'owner/repo' }).map((e) => e.key);
    expect(keys).toContain('pulls');
    // Pulls sits between Support and Wiki, mirroring the web ordering.
    expect(keys).toEqual(['board', 'threads', 'support', 'pulls', 'wiki', 'notes']);
  });

  it('omits Pulls when there is no GitHub repo', () => {
    expect(projectMenuEntries({}).map((e) => e.key)).not.toContain('pulls');
    expect(projectMenuEntries(null).map((e) => e.key)).not.toContain('pulls');
  });

  it('omits Pulls for workflow projects even with a repo', () => {
    const keys = projectMenuEntries({ githubRepo: 'owner/repo', mode: 'workflow' }).map(
      (e) => e.key,
    );
    expect(keys).not.toContain('pulls');
  });
});
