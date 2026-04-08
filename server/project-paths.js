/**
 * Path resolution for the project-based architecture.
 *
 * Given a project and agent, resolves all filesystem paths for:
 *   - Shared context files (project data dir)
 *   - Agent-specific files (data dir/agents/{agentId}/)
 *   - Skills, memory, etc.
 *
 * The data directory is computed from config.projectsDir/{projectId},
 * never stored in projects.json. It's hydrated at runtime as `project.ahw`.
 */

import path from 'path';

/**
 * Resolve all relevant paths for a project + agent pair.
 *
 * @param {object} project - Project object with `cwd` and `ahw` (computed data dir)
 * @param {object} agent   - Agent object with `id`
 * @returns {object} All resolved paths
 */
export function resolveProjectPaths(project, agent) {
  const dataDir = project.ahw || '';
  const agentDir = dataDir ? path.join(dataDir, 'agents', agent.id) : '';

  return {
    // Project-level
    cwd: project.cwd,
    ahw: dataDir,

    // Agent-specific directory
    agentDir,

    // Shared context files (project level)
    soulMd:    dataDir ? path.join(dataDir, 'SOUL.md') : '',
    agentsMd:  dataDir ? path.join(dataDir, 'AGENTS.md') : '',
    userMd:    dataDir ? path.join(dataDir, 'USER.md') : '',
    toolsMd:   dataDir ? path.join(dataDir, 'TOOLS.md') : '',
    memoryMd:  dataDir ? path.join(dataDir, 'MEMORY.md') : '',

    // Shared directories (project level)
    skillsDir: dataDir ? path.join(dataDir, 'skills') : '',
    memoryDir: dataDir ? path.join(dataDir, 'memory') : '',

    // Agent-specific files
    identityMd: agentDir ? path.join(agentDir, 'IDENTITY.md') : '',
  };
}

/**
 * The context files that live at the project level (shared).
 */
export const SHARED_CONTEXT_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];

/**
 * The context file that is agent-specific.
 */
export const AGENT_CONTEXT_FILES = ['IDENTITY.md'];

/**
 * All context files (shared + agent-specific).
 */
export const ALL_CONTEXT_FILES = [...SHARED_CONTEXT_FILES, ...AGENT_CONTEXT_FILES];

/**
 * Determine where a context file should be written:
 * - IDENTITY.md → agent-specific dir (dataDir/agents/{id}/)
 * - Everything else → project data dir root
 *
 * @param {object} paths - Result of resolveProjectPaths()
 * @param {string} filename - e.g. 'SOUL.md', 'IDENTITY.md'
 * @returns {string} Full file path, or '' if no data dir configured
 */
export function contextFilePath(paths, filename) {
  if (!paths.ahw) return '';
  if (AGENT_CONTEXT_FILES.includes(filename)) {
    return paths.agentDir ? path.join(paths.agentDir, filename) : '';
  }
  return path.join(paths.ahw, filename);
}
