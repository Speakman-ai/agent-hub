import path from 'path';
import type { ProjectPaths, Project, Agent } from './types.js';
import { resolveProjectSkillsDir } from './project-skill-paths.js';

/** Workspace data dir aligned with `resolveSlashSkill` / agent tooling: project.ahw → agent.ahw → workspace. */
export function resolveWorkspaceDataDir(project: Project | undefined, agent: Agent): string {
  const raw = project?.ahw || agent.ahw || (agent as Record<string, unknown>).workspace;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '';
}

/** `skills/` under {@link resolveWorkspaceDataDir}, or `''` when no workspace root is configured. */
export function resolveWorkspaceSkillsDir(project: Project | undefined, agent: Agent): string {
  const dataDir = resolveWorkspaceDataDir(project, agent);
  return dataDir ? path.join(dataDir, 'skills') : '';
}

export function resolveProjectPaths(project: Project, agent: Agent): ProjectPaths {
  const dataDir = project.ahw || '';
  const agentDir = dataDir ? path.join(dataDir, 'agents', agent.id) : '';

  return {
    cwd: project.cwd,
    ahw: dataDir,
    agentDir,

    soulMd: dataDir ? path.join(dataDir, 'SOUL.md') : '',
    agentsMd: dataDir ? path.join(dataDir, 'AGENTS.md') : '',
    userMd: dataDir ? path.join(dataDir, 'USER.md') : '',
    toolsMd: dataDir ? path.join(dataDir, 'TOOLS.md') : '',
    memoryMd: dataDir ? path.join(dataDir, 'MEMORY.md') : '',

    skillsDir: project.id ? resolveProjectSkillsDir(project) : '',
    memoryDir: dataDir ? path.join(dataDir, 'memory') : '',

    identityMd: agentDir ? path.join(agentDir, 'IDENTITY.md') : '',
  };
}

export const SHARED_CONTEXT_FILES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
];

export const AGENT_CONTEXT_FILES: readonly string[] = ['IDENTITY.md'];

export const ALL_CONTEXT_FILES: readonly string[] = [
  ...SHARED_CONTEXT_FILES,
  ...AGENT_CONTEXT_FILES,
];

/**
 * Repo checkout root for files that live in git, not the Hub workspace.
 * Session worktree wins when present (that's the live clone agents edit);
 * otherwise `project.cwd`.
 */
export function resolveCheckoutContextRoot(
  paths: Pick<ProjectPaths, 'cwd'>,
  sessionWorktreePath?: string | null,
): string {
  const worktree = typeof sessionWorktreePath === 'string' ? sessionWorktreePath.trim() : '';
  if (worktree) return worktree;
  return typeof paths.cwd === 'string' && paths.cwd.trim() ? paths.cwd.trim() : '';
}

export function contextFilePath(
  paths: ProjectPaths,
  filename: string,
  opts?: { checkoutRoot?: string | null },
): string {
  // CLAUDE.md is a repo convention (Claude Code / Cursor load it from the
  // checkout root). Hub workspace (`ahw` = ~/.agent-hub/projects/<id>/)
  // never seeds it — reading it from ahw silently skips the file that
  // actually exists at cwd/worktree.
  if (filename === 'CLAUDE.md') {
    const root = resolveCheckoutContextRoot(paths, opts?.checkoutRoot);
    return root ? path.join(root, filename) : '';
  }
  if (!paths.ahw) return '';
  if (AGENT_CONTEXT_FILES.includes(filename)) {
    return paths.agentDir ? path.join(paths.agentDir, filename) : '';
  }
  return path.join(paths.ahw, filename);
}
