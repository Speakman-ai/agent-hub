import { describe, expect, it } from 'vitest';
import {
  requireVisibleComposeProjectDirectory,
  resolveComposeProjectDirectory,
  translateContainerPathToHost,
} from './host-path-translation.js';

describe('translateContainerPathToHost', () => {
  it('returns null and a reason when no host root is configured', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo', {
      hostProjectsDir: null,
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/no host root configured/);
  });

  it('returns null when the host projects dir is an empty string and workspaces is unset', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo', {
      hostProjectsDir: '   ',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/no host root configured/);
  });

  it('rewrites a path that lives directly under the container projects root', () => {
    const r = translateContainerPathToHost('/home/node/projects/surveytracker', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects/surveytracker');
    expect(r.matchedRoot).toBe('projects');
    expect(r.skippedReason).toBeUndefined();
  });

  it('rewrites a nested path under the container projects root', () => {
    const r = translateContainerPathToHost('/home/node/projects/surveytracker/frontend/src', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects/surveytracker/frontend/src');
    expect(r.matchedRoot).toBe('projects');
  });

  it('returns the host root itself when the input is the container root', () => {
    const r = translateContainerPathToHost('/home/node/projects', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects');
    expect(r.matchedRoot).toBe('projects');
  });

  it('strips a trailing slash on inputs', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo/', {
      hostProjectsDir: '/var/lib/agent-hub/projects/',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects/foo');
  });

  it('refuses paths outside the bind-mounted roots when only projects is configured', () => {
    const r = translateContainerPathToHost('/home/node/.agent-hub/workspaces/foo/session-abc', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/outside the bind-mounted/);
  });

  it('refuses a path that is a sibling of the container projects root (no prefix match)', () => {
    const r = translateContainerPathToHost('/home/node/projects-foo/x', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/outside the bind-mounted/);
  });

  it('honours a custom container projects dir override', () => {
    const r = translateContainerPathToHost('/srv/code/app1/sub', {
      hostProjectsDir: '/data/projects',
      containerProjectsDir: '/srv/code',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBe('/data/projects/app1/sub');
    expect(r.matchedRoot).toBe('projects');
  });

  it('returns null when the container projects dir resolves to empty and workspaces is unset', () => {
    // An empty containerProjectsDir drops the projects pair entirely;
    // with workspaces also disabled there is no configured root at all.
    const r = translateContainerPathToHost('/home/node/projects/foo', {
      hostProjectsDir: '/data/projects',
      containerProjectsDir: '   ',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/no host root configured/);
  });

  it('returns null + reason when input is empty', () => {
    const r = translateContainerPathToHost('', {
      hostProjectsDir: '/data/projects',
      hostWorkspacesDir: null,
    });
    expect(r.hostPath).toBeNull();
    expect(r.skippedReason).toMatch(/empty container path/);
  });

  // ─── Workspaces-root translation ─────────────────────────────────────
  // Card 9b868252: per-session worktrees must be host-visible for compose
  // previews launched from worktrees (the iframe a chat session opens).
  // Before this change the worktree case returned null and the daemon
  // mounted empty dirs.

  it('rewrites a worktree path under the container workspaces root', () => {
    const r = translateContainerPathToHost(
      '/home/node/.agent-hub/workspaces/surveytracker/session-abc',
      {
        hostProjectsDir: null,
        hostWorkspacesDir: '/var/lib/agent-hub/workspaces',
      },
    );
    expect(r.hostPath).toBe('/var/lib/agent-hub/workspaces/surveytracker/session-abc');
    expect(r.matchedRoot).toBe('workspaces');
  });

  it('rewrites a nested worktree path under the container workspaces root', () => {
    const r = translateContainerPathToHost(
      '/home/node/.agent-hub/workspaces/surveytracker/session-abc/frontend',
      {
        hostProjectsDir: null,
        hostWorkspacesDir: '/var/lib/agent-hub/workspaces',
      },
    );
    expect(r.hostPath).toBe('/var/lib/agent-hub/workspaces/surveytracker/session-abc/frontend');
    expect(r.matchedRoot).toBe('workspaces');
  });

  it('returns the workspaces host root when input is the container workspaces root', () => {
    const r = translateContainerPathToHost('/home/node/.agent-hub/workspaces', {
      hostProjectsDir: null,
      hostWorkspacesDir: '/var/lib/agent-hub/workspaces',
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/workspaces');
    expect(r.matchedRoot).toBe('workspaces');
  });

  it('honours a custom container workspaces dir override', () => {
    const r = translateContainerPathToHost('/var/data/workspaces/proj/sess', {
      hostProjectsDir: null,
      hostWorkspacesDir: '/host/workspaces',
      containerWorkspacesDir: '/var/data/workspaces',
    });
    expect(r.hostPath).toBe('/host/workspaces/proj/sess');
    expect(r.matchedRoot).toBe('workspaces');
  });

  it('picks projects when both roots are configured and the path lives under projects', () => {
    const r = translateContainerPathToHost('/home/node/projects/foo/src', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: '/var/lib/agent-hub/workspaces',
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/projects/foo/src');
    expect(r.matchedRoot).toBe('projects');
  });

  it('picks workspaces when both roots are configured and the path lives under workspaces', () => {
    const r = translateContainerPathToHost('/home/node/.agent-hub/workspaces/foo/session-x/src', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: '/var/lib/agent-hub/workspaces',
    });
    expect(r.hostPath).toBe('/var/lib/agent-hub/workspaces/foo/session-x/src');
    expect(r.matchedRoot).toBe('workspaces');
  });

  it('reports a helpful reason listing both roots when neither matches', () => {
    const r = translateContainerPathToHost('/tmp/elsewhere', {
      hostProjectsDir: '/var/lib/agent-hub/projects',
      hostWorkspacesDir: '/var/lib/agent-hub/workspaces',
    });
    expect(r.hostPath).toBeNull();
    // Both labels appear, order is longest-first (workspaces > projects).
    expect(r.skippedReason).toMatch(/projects/);
    expect(r.skippedReason).toMatch(/workspaces/);
    expect(r.skippedReason).toMatch(/\/home\/node\/projects/);
    expect(r.skippedReason).toMatch(/\/home\/node\/\.agent-hub\/workspaces/);
  });

  it('rewrites macOS ~/projects checkouts when mac projects roots are configured', () => {
    const r = translateContainerPathToHost('/Users/dev/projects/surveytracker', {
      hostProjectsDir: null,
      hostWorkspacesDir: null,
      hostMacProjectsDir: '/Users/dev/projects',
      containerMacProjectsDir: '/Users/dev/projects',
    });
    expect(r.hostPath).toBe('/Users/dev/projects/surveytracker');
    expect(r.matchedRoot).toBe('macProjects');
  });

  it('picks the longest-matching prefix when one root is nested under the other', () => {
    // Defensive: production roots are disjoint, but a custom operator
    // setup could in principle nest one root under the other. Make sure
    // the more-specific (longer) root wins so the suffix is correct.
    const r = translateContainerPathToHost('/srv/code/.workspaces/foo', {
      hostProjectsDir: '/host/projects',
      containerProjectsDir: '/srv/code',
      hostWorkspacesDir: '/host/workspaces',
      containerWorkspacesDir: '/srv/code/.workspaces',
    });
    expect(r.hostPath).toBe('/host/workspaces/foo');
    expect(r.matchedRoot).toBe('workspaces');
  });
});

describe('resolveComposeProjectDirectory', () => {
  it('uses the translated host path when it is visible to this process', () => {
    const worktree = '/data/.agent-hub/workspaces/p/session-abc';
    const translation = {
      containerPath: worktree,
      hostPath: '/host/workspaces/p/session-abc',
      matchedRoot: 'workspaces' as const,
    };
    expect(
      resolveComposeProjectDirectory(worktree, translation, {
        pathExists: (p) => p === translation.hostPath,
      }),
    ).toBe(translation.hostPath);
  });

  it('falls back to the container worktree when the host path is not visible and no mapping env', () => {
    const savedProjects = process.env.AGENT_HUB_HOST_PROJECTS_DIR;
    const savedWorkspaces = process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    delete process.env.AGENT_HUB_HOST_PROJECTS_DIR;
    delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    try {
      const worktree = '/data/.agent-hub/workspaces/surveytracker/session-6445b988';
      const translation = translateContainerPathToHost(worktree, {
        hostWorkspacesDir: '/Users/dev/.agent-hub/data/.agent-hub/workspaces',
        containerWorkspacesDir: '/data/.agent-hub/workspaces',
      });
      expect(
        resolveComposeProjectDirectory(worktree, translation, {
          pathExists: () => false,
        }),
      ).toBe(worktree);
    } finally {
      if (savedProjects === undefined) delete process.env.AGENT_HUB_HOST_PROJECTS_DIR;
      else process.env.AGENT_HUB_HOST_PROJECTS_DIR = savedProjects;
      if (savedWorkspaces === undefined) delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
      else process.env.AGENT_HUB_HOST_WORKSPACES_DIR = savedWorkspaces;
    }
  });

  it('uses translated host path when mapping env is set even if invisible in container', () => {
    const savedWorkspaces = process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    process.env.AGENT_HUB_HOST_WORKSPACES_DIR = '/host/workspaces';
    try {
      const worktree = '/data/.agent-hub/workspaces/p/session-abc';
      const translation = {
        containerPath: worktree,
        hostPath: '/host/workspaces/p/session-abc',
        matchedRoot: 'workspaces' as const,
      };
      expect(
        resolveComposeProjectDirectory(worktree, translation, {
          pathExists: () => false,
        }),
      ).toBe(translation.hostPath);
    } finally {
      if (savedWorkspaces === undefined) delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
      else process.env.AGENT_HUB_HOST_WORKSPACES_DIR = savedWorkspaces;
    }
  });
});

describe('requireVisibleComposeProjectDirectory', () => {
  it('returns the resolved directory when it is visible to this process', () => {
    const worktree = '/data/.agent-hub/workspaces/p/session-abc';
    const translation = {
      containerPath: worktree,
      hostPath: '/host/workspaces/p/session-abc',
      matchedRoot: 'workspaces' as const,
    };
    expect(
      requireVisibleComposeProjectDirectory(worktree, translation, {
        pathExists: (p) => p === translation.hostPath,
      }),
    ).toBe(translation.hostPath);
  });

  it('throws an actionable error when the host path is configured but invisible inside the container', () => {
    const savedWorkspaces = process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    process.env.AGENT_HUB_HOST_WORKSPACES_DIR = '/host/workspaces';
    try {
      const worktree = '/data/.agent-hub/workspaces/p/session-abc';
      const translation = {
        containerPath: worktree,
        hostPath: '/host/workspaces/p/session-abc',
        matchedRoot: 'workspaces' as const,
      };
      expect(() =>
        requireVisibleComposeProjectDirectory(worktree, translation, {
          pathExists: () => false,
        }),
      ).toThrow(/not readable inside this process/);
      // The error should include the actionable bind-mount hint with the
      // exact path. Operators paste this directly into their docker run /
      // compose file.
      expect(() =>
        requireVisibleComposeProjectDirectory(worktree, translation, {
          pathExists: () => false,
        }),
      ).toThrow(/-v \/host\/workspaces\/p\/session-abc:\/host\/workspaces\/p\/session-abc/);
    } finally {
      if (savedWorkspaces === undefined) delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
      else process.env.AGENT_HUB_HOST_WORKSPACES_DIR = savedWorkspaces;
    }
  });

  it('does not throw when env mapping is unset and the lenient resolver returns the worktree', () => {
    // No env mapping configured -> resolveComposeProjectDirectory falls
    // back to the container worktree, which exists in the dev / Electron
    // case. requireVisible only checks the resolved value, so this is the
    // correct behaviour for non-containerized deployments.
    const savedProjects = process.env.AGENT_HUB_HOST_PROJECTS_DIR;
    const savedWorkspaces = process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    delete process.env.AGENT_HUB_HOST_PROJECTS_DIR;
    delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    try {
      const worktree = '/data/.agent-hub/workspaces/p/session-abc';
      const translation = translateContainerPathToHost(worktree, {
        hostProjectsDir: null,
        hostWorkspacesDir: null,
      });
      expect(
        requireVisibleComposeProjectDirectory(worktree, translation, {
          pathExists: (p) => p === worktree,
        }),
      ).toBe(worktree);
    } finally {
      if (savedProjects === undefined) delete process.env.AGENT_HUB_HOST_PROJECTS_DIR;
      else process.env.AGENT_HUB_HOST_PROJECTS_DIR = savedProjects;
      if (savedWorkspaces === undefined) delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
      else process.env.AGENT_HUB_HOST_WORKSPACES_DIR = savedWorkspaces;
    }
  });
});
