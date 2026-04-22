import {
  resolveProjectPaths,
  contextFilePath,
  SHARED_CONTEXT_FILES,
  AGENT_CONTEXT_FILES,
  ALL_CONTEXT_FILES,
} from './project-paths.js';
import type { Project, Agent } from './types.js';

describe('resolveProjectPaths', () => {
  it('resolves all paths for a project with ahw', () => {
    const paths = resolveProjectPaths(
      { cwd: '/projects/myapp', ahw: '/data/projects/myapp' } as Project,
      { id: 'agent-1' } as Agent,
    );

    expect(paths.cwd).toBe('/projects/myapp');
    expect(paths.ahw).toBe('/data/projects/myapp');
    expect(paths.agentDir).toBe('/data/projects/myapp/agents/agent-1');
    expect(paths.soulMd).toBe('/data/projects/myapp/SOUL.md');
    expect(paths.agentsMd).toBe('/data/projects/myapp/AGENTS.md');
    expect(paths.userMd).toBe('/data/projects/myapp/USER.md');
    expect(paths.toolsMd).toBe('/data/projects/myapp/TOOLS.md');
    expect(paths.memoryMd).toBe('/data/projects/myapp/MEMORY.md');
    expect(paths.skillsDir).toBe('/data/projects/myapp/skills');
    expect(paths.memoryDir).toBe('/data/projects/myapp/memory');
    expect(paths.identityMd).toBe('/data/projects/myapp/agents/agent-1/IDENTITY.md');
  });

  it('returns empty strings when ahw is not set', () => {
    const paths = resolveProjectPaths(
      { cwd: '/projects/myapp' } as Project,
      { id: 'agent-1' } as Agent,
    );

    expect(paths.cwd).toBe('/projects/myapp');
    expect(paths.ahw).toBe('');
    expect(paths.agentDir).toBe('');
    expect(paths.soulMd).toBe('');
    expect(paths.identityMd).toBe('');
    expect(paths.skillsDir).toBe('');
  });
});

describe('contextFilePath', () => {
  const paths = resolveProjectPaths(
    { cwd: '/projects/myapp', ahw: '/data/projects/myapp' } as Project,
    { id: 'agent-1' } as Agent,
  );

  it('resolves shared context files to project data dir', () => {
    expect(contextFilePath(paths, 'SOUL.md')).toBe('/data/projects/myapp/SOUL.md');
    expect(contextFilePath(paths, 'AGENTS.md')).toBe('/data/projects/myapp/AGENTS.md');
    expect(contextFilePath(paths, 'USER.md')).toBe('/data/projects/myapp/USER.md');
    expect(contextFilePath(paths, 'TOOLS.md')).toBe('/data/projects/myapp/TOOLS.md');
    expect(contextFilePath(paths, 'MEMORY.md')).toBe('/data/projects/myapp/MEMORY.md');
  });

  it('resolves agent-specific files to agent dir', () => {
    expect(contextFilePath(paths, 'IDENTITY.md')).toBe(
      '/data/projects/myapp/agents/agent-1/IDENTITY.md',
    );
  });

  it('returns empty string when ahw is not configured', () => {
    const emptyPaths = resolveProjectPaths({ cwd: '/x' } as Project, { id: 'a' } as Agent);
    expect(contextFilePath(emptyPaths, 'SOUL.md')).toBe('');
    expect(contextFilePath(emptyPaths, 'IDENTITY.md')).toBe('');
  });
});

describe('constants', () => {
  it('SHARED_CONTEXT_FILES contains expected files', () => {
    expect(SHARED_CONTEXT_FILES).toContain('SOUL.md');
    expect(SHARED_CONTEXT_FILES).toContain('AGENTS.md');
    expect(SHARED_CONTEXT_FILES).toContain('CLAUDE.md');
    expect(SHARED_CONTEXT_FILES).toContain('USER.md');
    expect(SHARED_CONTEXT_FILES).toContain('TOOLS.md');
    expect(SHARED_CONTEXT_FILES).toContain('MEMORY.md');
    expect(SHARED_CONTEXT_FILES).toHaveLength(6);
  });

  it('AGENT_CONTEXT_FILES contains IDENTITY.md', () => {
    expect(AGENT_CONTEXT_FILES).toEqual(['IDENTITY.md']);
  });

  it('ALL_CONTEXT_FILES is union of shared and agent', () => {
    expect(ALL_CONTEXT_FILES).toHaveLength(7);
    expect(ALL_CONTEXT_FILES).toEqual([...SHARED_CONTEXT_FILES, ...AGENT_CONTEXT_FILES]);
  });
});
