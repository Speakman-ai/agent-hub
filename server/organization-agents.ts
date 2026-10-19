/** Organization-agent lifecycle inside the hidden organization workspace. Callers must already
 * hold Organization Owner/Admin (or Server administrator) authority for mutations. */
import { randomUUID } from 'node:crypto';
import { defaultModelForEngine } from './config.js';
import { saveProjects } from './project-model.js';
import { listBusinessOrganizationProjectIds } from './business-organizations-store.js';
import {
  visibleOrganizationProject,
  type OrganizationCaller,
} from './business-organizations-access.js';
import { findOrganizationAgentTemplate } from './organization-agent-templates.js';
import type { Agent, AppConfig, OrganizationAgentScope, Project } from './types.js';

export type OrganizationTool = OrganizationAgentScope['tools'][number];
export const ORGANIZATION_TOOLS: readonly OrganizationTool[] = [
  'projects:read',
  'dispatch',
  'artifacts',
  'credentials',
  'skills',
  'web',
  'browser',
  'computer',
  'approvals',
];
/** Least privilege for a fresh custom agent: read linked projects the user can already see. */
export const DEFAULT_CUSTOM_AGENT_TOOLS: readonly OrganizationTool[] = ['projects:read'];

export class OrganizationAgentError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface OrganizationAgentConfigInput {
  name?: string;
  systemPrompt?: string;
  engine?: string;
  model?: string;
  tools?: OrganizationTool[];
  projects?: 'all-linked' | string[];
  computerToolEnabled?: boolean;
  enabled?: boolean;
  archived?: boolean;
}

function validModel(config: AppConfig, engine: string, model: string): boolean {
  return config.engineValidModels?.[engine]?.includes(model) ?? false;
}

/** Explicit subsets may only name projects currently linked to this organization AND visible
 * to the acting administrator. One generic error avoids confirming hidden or foreign IDs. */
function validatedProjectScope(
  caller: OrganizationCaller,
  workspace: Project,
  projects: 'all-linked' | string[],
): 'all-linked' | string[] {
  if (projects === 'all-linked') return projects;
  const linked = new Set(
    listBusinessOrganizationProjectIds(caller.serverId, workspace.organizationId!),
  );
  const unique = [...new Set(projects)];
  if (unique.some((id) => !linked.has(id) || !visibleOrganizationProject(caller, id)))
    throw new OrganizationAgentError(400, 'Unknown or inaccessible project in scope');
  return unique.sort();
}

function normalizedTools(tools: readonly OrganizationTool[]): OrganizationTool[] {
  return [...new Set(tools)].sort() as OrganizationTool[];
}

export function createOrganizationAgent(
  caller: OrganizationCaller,
  workspace: Project,
  config: AppConfig,
  input: OrganizationAgentConfigInput & { templateId?: string },
): Agent {
  const template = input.templateId ? findOrganizationAgentTemplate(input.templateId) : null;
  if (input.templateId && !template) throw new OrganizationAgentError(400, 'Unknown template');
  const name = input.name ?? template?.name;
  if (!name) throw new OrganizationAgentError(400, 'Name is required without a template');
  const engine = input.engine ?? 'claude-code';
  if (!config.engineValidModels?.[engine]) throw new OrganizationAgentError(400, 'Invalid engine');
  const model = input.model ?? defaultModelForEngine(engine);
  if (input.model && !validModel(config, engine, input.model))
    throw new OrganizationAgentError(400, 'Invalid model for agent engine');
  // Templates never contribute tools, projects or Computer: those come only from the request.
  const tools = normalizedTools(input.tools ?? DEFAULT_CUSTOM_AGENT_TOOLS);
  const computerToolEnabled = input.computerToolEnabled ?? false;
  if (computerToolEnabled && !tools.includes('computer'))
    throw new OrganizationAgentError(400, 'Computer preference requires the computer tool');
  const agent: Agent = {
    id: `${workspace.id}agent_${randomUUID()}`,
    name,
    engine,
    model,
    isDev: false,
    systemPrompt: input.systemPrompt ?? template?.instructions ?? '',
    computerToolEnabled,
    organizationScope: {
      enabled: input.enabled ?? true,
      archivedAt: null,
      projects: validatedProjectScope(caller, workspace, input.projects ?? 'all-linked'),
      tools,
    },
    ...(template ? { organizationTemplate: { id: template.id, version: template.version } } : {}),
  };
  workspace.agents.push(agent);
  saveProjects();
  return agent;
}

/** Saving re-fingerprints every live organization context. Any scope, tool, prompt or state
 * change revokes affected capabilities and stops running turns through the revalidator. */
export function updateOrganizationAgent(
  caller: OrganizationCaller,
  workspace: Project,
  agent: Agent,
  config: AppConfig,
  input: OrganizationAgentConfigInput,
): Agent {
  const scope = agent.organizationScope;
  if (!scope) throw new OrganizationAgentError(404, 'Agent not found');
  if (input.engine !== undefined && input.engine !== agent.engine)
    throw new OrganizationAgentError(400, 'Engine cannot be changed after creation');
  if (input.model !== undefined && !validModel(config, agent.engine, input.model))
    throw new OrganizationAgentError(400, 'Invalid model for agent engine');
  const tools = input.tools ? normalizedTools(input.tools) : scope.tools;
  let computerToolEnabled = input.computerToolEnabled ?? agent.computerToolEnabled ?? false;
  if (input.computerToolEnabled && !tools.includes('computer'))
    throw new OrganizationAgentError(400, 'Computer preference requires the computer tool');
  // Revoking the permission also clears the preference rather than leaving it dangling.
  if (!tools.includes('computer')) computerToolEnabled = false;
  const projects =
    input.projects !== undefined
      ? validatedProjectScope(caller, workspace, input.projects)
      : scope.projects;

  if (input.name !== undefined) agent.name = input.name;
  if (input.systemPrompt !== undefined) agent.systemPrompt = input.systemPrompt;
  if (input.model !== undefined) agent.model = input.model;
  agent.computerToolEnabled = computerToolEnabled;
  scope.tools = tools;
  scope.projects = projects;
  if (input.enabled !== undefined) scope.enabled = input.enabled;
  if (input.archived !== undefined)
    scope.archivedAt = input.archived ? (scope.archivedAt ?? new Date().toISOString()) : null;
  saveProjects();
  return agent;
}

/** Project IDs in a response are limited to those the acting user can see right now. */
export function organizationAgentView(
  caller: OrganizationCaller,
  workspace: Project,
  agent: Agent,
) {
  const scope = agent.organizationScope!;
  const linked = listBusinessOrganizationProjectIds(caller.serverId, workspace.organizationId!);
  const visible = (id: string) => visibleOrganizationProject(caller, id) !== null;
  const effectiveProjectIds = linked
    .filter((id) => (scope.projects === 'all-linked' || scope.projects.includes(id)) && visible(id))
    .sort();
  return {
    ...agent,
    isAssistant: workspace.organizationAssistantId === agent.id,
    organizationScope: {
      ...scope,
      projects: scope.projects === 'all-linked' ? scope.projects : scope.projects.filter(visible),
    },
    effectiveProjectIds,
  };
}
