/**
 * Path resolution for the project-based architecture.
 *
 * Given a project and agent, resolves all filesystem paths for:
 *   - Shared context files (project-level ahw/)
 *   - Agent-specific files (ahw/agents/{agentId}/)
 *   - Skills, memory, etc.
 */

import path from 'path';

/**
 * Resolve all relevant paths for a project + agent pair.
 *
 * @param {object} project - Project object with `cwd` and `ahw`
 * @param {object} agent   - Agent object with `id`
 * @returns {object} All resolved paths
 */
export function resolveProjectPaths(project, agent) {
  const ahw = project.ahw || '';
  const agentDir = ahw ? path.join(ahw, 'agents', agent.id) : '';

  return {
    // Project-level
    cwd: project.cwd,
    ahw,

    // Agent-specific directory
    agentDir,

    // Shared context files (project level)
    soulMd:    ahw ? path.join(ahw, 'SOUL.md') : '',
    agentsMd:  ahw ? path.join(ahw, 'AGENTS.md') : '',
    userMd:    ahw ? path.join(ahw, 'USER.md') : '',
    toolsMd:   ahw ? path.join(ahw, 'TOOLS.md') : '',
    memoryMd:  ahw ? path.join(ahw, 'MEMORY.md') : '',

    // Shared directories (project level)
    skillsDir: ahw ? path.join(ahw, 'skills') : '',
    memoryDir: ahw ? path.join(ahw, 'memory') : '',

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
 * - IDENTITY.md → agent-specific dir (ahw/agents/{id}/)
 * - Everything else → project ahw root
 *
 * @param {object} paths - Result of resolveProjectPaths()
 * @param {string} filename - e.g. 'SOUL.md', 'IDENTITY.md'
 * @returns {string} Full file path, or '' if no ahw configured
 */
export function contextFilePath(paths, filename) {
  if (!paths.ahw) return '';
  if (AGENT_CONTEXT_FILES.includes(filename)) {
    return paths.agentDir ? path.join(paths.agentDir, filename) : '';
  }
  return path.join(paths.ahw, filename);
}
