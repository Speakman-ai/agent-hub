/** Hidden flat Project/Agent runtime for business organizations. No Git or scheduled work. */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { defaultModelForEngine } from './config.js';
import { getActiveOrgId, orgDataDir } from './orgs.js';
import { getProjectDataDir, listProjectsForServer, saveProjects } from './project-model.js';
import {
  getBusinessOrganization,
  listBusinessOrganizations,
} from './business-organizations-store.js';
import { revalidateOrganizationAccess } from './organization-spawn-policy.js';
import type { Agent, Project } from './types.js';
import { organizationWorkspaceId } from './organization-workspace-id.js';

export const ORGANIZATION_ASSISTANT_INSTRUCTIONS = `You are the Organization Assistant. Help the current user track priorities, summarize linked projects, coordinate work, dispatch eligible project agents, and follow up on their status and results.
Inspect authorized project resources on demand and cite their source. Ask before taking consequential actions. Your name and any template title grant no authority. Shared instructions contain only deliberately shared business context; keep project-derived memory private to the current user and record its source project.`;

export { organizationWorkspaceId } from './organization-workspace-id.js';

function persist(serverId: string, projects: Project[]): void {
  if (serverId === getActiveOrgId()) saveProjects();
  else {
    const directory = orgDataDir(serverId);
    mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'projects.json');
    writeFileSync(`${target}.tmp`, JSON.stringify(projects, null, 2) + '\n');
    renameSync(`${target}.tmp`, target);
    revalidateOrganizationAccess();
  }
}

/** The persisted assistant ID is also a seeding tombstone. Empty rosters are intentional. */
export function ensureOrganizationWorkspace(serverId: string, organizationId: string): Project {
  const organization = getBusinessOrganization(serverId, organizationId);
  if (!organization) throw new Error('Organization not found');
  const projects = listProjectsForServer(serverId);
  const matches = projects.filter(
    (p) =>
      p.workspaceKind === 'organization' &&
      p.organizationId === organizationId &&
      p.serverId === serverId,
  );
  if (matches.length > 1) throw new Error('Duplicate organization workspaces');
  let project = matches[0];
  let dirty = false;
  if (!project) {
    const id = organizationWorkspaceId(serverId, organizationId);
    if (projects.some((p) => p.id === id))
      throw new Error('Organization workspace identity collision');
    project = {
      id,
      name: organization.name,
      cwd: '',
      ahw: getProjectDataDir(id),
      kind: 'system',
      workspaceKind: 'organization',
      organizationId,
      serverId,
      mode: 'workflow',
      agents: [],
    };
    projects.push(project);
    dirty = true;
  }
  // Repair runtime classification without resetting any agent customizations.
  if (project.kind !== 'system' || project.mode !== 'workflow') dirty = true;
  project.kind = 'system';
  project.mode = 'workflow';
  if (!project.cwd) {
    project.cwd = path.join(getProjectDataDir(project.id), 'workspace');
    dirty = true;
  }
  mkdirSync(project.cwd, { recursive: true, mode: 0o700 });
  if (!project.organizationAssistantId) {
    // Adopt a pre-existing roster instead of adding an unwanted second agent.
    const id = project.agents[0]?.id ?? `${project.id}assistant`;
    project.organizationAssistantId = id;
    if (project.agents.length === 0) {
      const engine = 'claude-code';
      const assistant: Agent = {
        id,
        name: 'Organization Assistant',
        engine,
        model: defaultModelForEngine(engine),
        isDev: false,
        systemPrompt: ORGANIZATION_ASSISTANT_INSTRUCTIONS,
        computerToolEnabled: true,
        organizationScope: {
          enabled: true,
          projects: 'all-linked',
          tools: [
            'projects:read',
            'dispatch',
            'artifacts',
            'credentials',
            'skills',
            'web',
            'browser',
            'computer',
            'approvals',
          ],
        },
      };
      project.agents.push(assistant);
    }
    dirty = true;
  }
  if (dirty) persist(serverId, projects);
  return project;
}

/** Archive only the hidden runtime. Never delete agents, sessions, member projects or desktops. */
export function archiveOrganizationWorkspace(serverId: string, organizationId: string): void {
  const projects = listProjectsForServer(serverId);
  const organization = getBusinessOrganization(serverId, organizationId, { includeArchived: true });
  if (!organization?.archived_at) return;
  let dirty = false;
  for (const project of projects) {
    if (
      project.workspaceKind !== 'organization' ||
      project.serverId !== serverId ||
      project.organizationId !== organizationId
    )
      continue;
    if (project.archivedAt === organization.archived_at) continue;
    project.archivedAt = organization.archived_at;
    dirty = true;
  }
  if (dirty) persist(serverId, projects);
}

/** Startup/Server-switch repair is idempotent and never creates a chat or a background job. */
export function repairOrganizationWorkspaces(serverId = getActiveOrgId()): void {
  for (const organization of listBusinessOrganizations(serverId))
    ensureOrganizationWorkspace(serverId, organization.id);
  for (const project of listProjectsForServer(serverId)) {
    if (
      project.workspaceKind === 'organization' &&
      project.serverId === serverId &&
      project.organizationId
    )
      archiveOrganizationWorkspace(serverId, project.organizationId);
  }
}
