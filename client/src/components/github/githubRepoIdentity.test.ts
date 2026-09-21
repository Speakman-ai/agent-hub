import { describe, it, expect } from 'vitest';
import { githubRepoIdentity, isHubHostedProject } from './githubRepoIdentity';

describe('githubRepoIdentity', () => {
  it('splits githubRepo owner/repo', () => {
    expect(githubRepoIdentity({ githubRepo: 'acme/webapp', name: 'Other' }, 'p')).toEqual({
      owner: 'acme',
      repo: 'webapp',
      slug: 'acme/webapp',
    });
  });

  it('falls back to hub / project name', () => {
    expect(githubRepoIdentity({ name: 'webapp' }, 'proj-1')).toEqual({
      owner: 'hub',
      repo: 'webapp',
      slug: 'hub/webapp',
    });
  });
});

describe('isHubHostedProject', () => {
  it('is true only for Agent Hub-hosted repos', () => {
    expect(isHubHostedProject({ gitHost: 'agenthub' })).toBe(true);
  });

  it('is false for GitHub-backed and unconfigured projects', () => {
    // These have no git-host endpoints, so offering the Code tab would
    // navigate the user straight to an error page.
    expect(isHubHostedProject({ githubRepo: 'acme/webapp' })).toBe(false);
    expect(isHubHostedProject({ gitHost: 'github' })).toBe(false);
    expect(isHubHostedProject({})).toBe(false);
    expect(isHubHostedProject(null)).toBe(false);
    expect(isHubHostedProject(undefined)).toBe(false);
  });
});
