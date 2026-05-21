import { describe, expect, it } from 'vitest';
import { translateContainerPathToHost } from './host-path-translation.js';

describe('translateContainerPathToHost', () => {
  it('returns null and a reason when no host projects dir is configured', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo', {
      hostProjectsDir: null,
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/AGENT_HUB_HOST_PROJECTS_DIR/);
  });

  it('returns null when the host projects dir is an empty string', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo', {
      hostProjectsDir: '   ',
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/AGENT_HUB_HOST_PROJECTS_DIR/);
  });

  it('rewrites a path that lives directly under the container projects root', () => {
    const r = translateContainerPathToHost('/home/node/projects/surveytracker', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects/surveytracker');
    expect(r.skippedReason).toBeUndefined();
  });

  it('rewrites a nested path under the container projects root', () => {
    const r = translateContainerPathToHost('/home/node/projects/surveytracker/frontend/src', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects/surveytracker/frontend/src');
  });

  it('returns the host root itself when the input is the container root', () => {
    const r = translateContainerPathToHost('/home/node/projects', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects');
  });

  it('strips a trailing slash on inputs', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo/', {
      hostProjectsDir: '/var/lib/agent-hub/projects/',
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects/foo');
  });

  it('refuses paths outside the bind-mounted root (worktree case)', () => {
    const r = translateContainerPathToHost('/home/node/.agent-hub/workspaces/foo/session-abc', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/outside the bind-mounted projects root/);
  });

  it('refuses a path that is a sibling of the container root (no prefix match)', () => {
    const r = translateContainerPathToHost('/home/node/projects-foo/x', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/outside the bind-mounted projects root/);
  });

  it('honours a custom container projects dir override', () => {
    const r = translateContainerPathToHost('/srv/code/app1/sub', {
      hostProjectsDir: '/data/projects',
      containerProjectsDir: '/srv/code',
    });
    expect(r.hostPath).toBe('/data/projects/app1/sub');
  });

  it('returns null when the container projects dir resolves to empty', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo', {
      hostProjectsDir: '/data/projects',
      containerProjectsDir: '   ',
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/container projects dir resolves to empty/);
  });

  it('returns null + reason when input is empty', () => {
    const r = translateContainerPathToHost('', { hostProjectsDir: '/data/projects' });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/empty container path/);
  });
});
