import path from 'path';
import type { ProjectPaths, Project, Agent } from './types.js';

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

    skillsDir: dataDir ? path.join(dataDir, 'skills') : '',
    memoryDir: dataDir ? path.join(dataDir, 'memory') : '',

    identityMd: agentDir ? path.join(agentDir, 'IDENTITY.md') : '',
  };
}

export const SHARED_CONTEXT_FILES: readonly string[] = [
  'AGENTS.md',
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

export function contextFilePath(paths: ProjectPaths, filename: string): string {
  if (!paths.ahw) return '';
  if (AGENT_CONTEXT_FILES.includes(filename)) {
    return paths.agentDir ? path.join(paths.agentDir, filename) : '';
  }
  return path.join(paths.ahw, filename);
}
