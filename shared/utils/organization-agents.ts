/** Organization-agent roster, templates and chat entry points shared by web and mobile. */
export const ORGANIZATION_AGENT_TOOLS = [
  'projects:read',
  'dispatch',
  'artifacts',
  'credentials',
  'skills',
  'web',
  'browser',
  'computer',
  'approvals',
] as const;
export type OrganizationAgentTool = (typeof ORGANIZATION_AGENT_TOOLS)[number];

export const ORGANIZATION_TOOL_LABELS: Record<OrganizationAgentTool, string> = {
  'projects:read': 'Read linked projects',
  dispatch: 'Dispatch project agents',
  artifacts: 'Artifacts',
  credentials: 'Credential requests',
  skills: 'Skills',
  web: 'Web search',
  browser: 'Browser',
  computer: 'Computer',
  approvals: 'Approvals',
};

export type OrganizationProjectScope = 'all-linked' | string[];
export interface OrganizationAgent {
  id: string;
  name: string;
  engine: string;
  model?: string;
  systemPrompt?: string;
  computerToolEnabled?: boolean;
  organizationScope: {
    enabled: boolean;
    archivedAt?: string | null;
    projects: OrganizationProjectScope;
    tools: string[];
  };
  organizationTemplate?: { id: string; version: number };
  isAssistant?: boolean;
  effectiveProjectIds?: string[];
}
export interface OrganizationAgentTemplate {
  id: string;
  version: number;
  label: string;
  name: string;
  description: string;
  instructions: string;
}
export interface OrganizationChat {
  id: string;
  name: string;
  agentId: string;
  agentName: string | null;
  agentAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface OrganizationAgentDraft {
  templateId: string | null;
  name: string;
  systemPrompt: string;
  model: string;
  tools: OrganizationAgentTool[];
  allLinked: boolean;
  projectIds: string[];
  enabled: boolean;
}

type Request = (path: string, options?: { method?: string; body?: string }) => Promise<any>;
export function createOrganizationAgentApi(request: Request) {
  const base = (id: string) => `/organizations/${encodeURIComponent(id)}`;
  const agent = (id: string, agentId: string) =>
    `${base(id)}/agents/${encodeURIComponent(agentId)}`;
  return {
    list: (id: string): Promise<{ agents: OrganizationAgent[] }> => request(`${base(id)}/agents`),
    templates: (id: string): Promise<{ templates: OrganizationAgentTemplate[] }> =>
      request(`${base(id)}/agent-templates`),
    chats: (id: string): Promise<{ sessions: OrganizationChat[] }> =>
      request(`${base(id)}/sessions`),
    create: (id: string, body: Record<string, unknown>): Promise<{ agent: OrganizationAgent }> =>
      request(`${base(id)}/agents`, { method: 'POST', body: JSON.stringify(body) }),
    update: (
      id: string,
      agentId: string,
      body: Record<string, unknown>,
    ): Promise<{ agent: OrganizationAgent }> =>
      request(agent(id, agentId), { method: 'PATCH', body: JSON.stringify(body) }),
    startChat: (id: string, agentId: string): Promise<{ session: any; agent: OrganizationAgent }> =>
      request(`${agent(id, agentId)}/sessions`, { method: 'POST', body: '{}' }),
  };
}
export type OrganizationAgentApi = ReturnType<typeof createOrganizationAgentApi>;

export type OrganizationAgentStatus = 'active' | 'disabled' | 'archived';
export function organizationAgentStatus(agent: OrganizationAgent): OrganizationAgentStatus {
  if (agent.organizationScope.archivedAt) return 'archived';
  return agent.organizationScope.enabled ? 'active' : 'disabled';
}

/** Archived agents drop out of the roster; their chats stay in the history list. */
export function rosterAgents(agents: OrganizationAgent[]): OrganizationAgent[] {
  return agents
    .filter((a) => organizationAgentStatus(a) !== 'archived')
    .sort((a, b) => Number(!!b.isAssistant) - Number(!!a.isAssistant));
}

/** A template only fills in the name and instructions. Tools and projects stay least-privilege. */
export function newAgentDraft(
  template: OrganizationAgentTemplate | null,
  defaultModel: string,
): OrganizationAgentDraft {
  return {
    templateId: template?.id ?? null,
    name: template?.name ?? '',
    systemPrompt: template?.instructions ?? '',
    model: defaultModel,
    tools: ['projects:read'],
    allLinked: true,
    projectIds: [],
    enabled: true,
  };
}

export function draftFromAgent(agent: OrganizationAgent): OrganizationAgentDraft {
  const projects = agent.organizationScope.projects;
  return {
    templateId: agent.organizationTemplate?.id ?? null,
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? '',
    model: agent.model ?? '',
    tools: agent.organizationScope.tools.filter((t): t is OrganizationAgentTool =>
      (ORGANIZATION_AGENT_TOOLS as readonly string[]).includes(t),
    ),
    allLinked: projects === 'all-linked',
    projectIds: projects === 'all-linked' ? [] : [...projects],
    enabled: agent.organizationScope.enabled,
  };
}

function draftBody(draft: OrganizationAgentDraft) {
  return {
    name: draft.name.trim(),
    systemPrompt: draft.systemPrompt,
    ...(draft.model ? { model: draft.model } : {}),
    tools: [...draft.tools].sort(),
    projects: draft.allLinked ? ('all-linked' as const) : [...draft.projectIds].sort(),
    enabled: draft.enabled,
  };
}

export function createBodyFromDraft(draft: OrganizationAgentDraft) {
  return { ...draftBody(draft), ...(draft.templateId ? { templateId: draft.templateId } : {}) };
}

/** Only changed fields are sent, so an edit never rewrites settings the user did not touch. */
export function patchFromDraft(agent: OrganizationAgent, draft: OrganizationAgentDraft) {
  const before = draftBody(draftFromAgent(agent));
  const after = draftBody(draft);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof typeof after)[])
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  // Dropping the computer tool also clears the Computer preference server-side.
  if (!draft.tools.includes('computer') && agent.computerToolEnabled)
    patch.computerToolEnabled = false;
  return patch;
}

export function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

export interface OrganizationAgentsState {
  organizationId: string | null;
  agents: OrganizationAgent[];
  templates: OrganizationAgentTemplate[];
  chats: OrganizationChat[];
  busy: boolean;
  ready: boolean;
  error: string;
}
const empty = (organizationId: string | null = null): OrganizationAgentsState => ({
  organizationId,
  agents: [],
  templates: [],
  chats: [],
  busy: false,
  ready: false,
  error: '',
});
const staleState = empty();

/** Scoped to one Server connection + account + organization. Every async operation captures that
 * scope and the view's lifetime when it starts and applies its result only if both still hold, so
 * another Server's or organization's roster, chats or navigation never surface. A newer `load`
 * additionally supersedes an older one; it never invalidates an in-flight mutation or chat. */
export class OrganizationAgentsController {
  state: OrganizationAgentsState;
  private loadGeneration = 0;
  // Bumped when the owning view unmounts or switches organization.
  private lifetime = 0;
  private listeners = new Set<() => void>();
  constructor(
    private api: OrganizationAgentApi,
    private getScope: () => string,
    readonly organizationId: string,
    private scope = getScope(),
  ) {
    this.state = empty(organizationId);
  }
  snapshot = () => (this.getScope() === this.scope ? this.state : staleState);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  cancel = () => {
    this.lifetime++;
  };
  private publish(patch: Partial<OrganizationAgentsState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** Snapshot of the scope and lifetime an operation started under. */
  private begin(): () => boolean {
    const lifetime = this.lifetime;
    return () => this.lifetime === lifetime && this.scope === this.getScope();
  }
  async load() {
    const alive = this.begin();
    const generation = ++this.loadGeneration;
    const current = () => alive() && generation === this.loadGeneration;
    if (!alive()) return;
    // Hide the previous roster at once so a scope or permission change never shows stale data.
    this.publish({ ...empty(this.organizationId), busy: true });
    try {
      const [agents, templates, chats] = await Promise.all([
        this.api.list(this.organizationId),
        this.api.templates(this.organizationId),
        this.api.chats(this.organizationId),
      ]);
      if (!current()) return;
      this.publish({
        agents: agents.agents,
        templates: templates.templates,
        chats: chats.sessions,
        busy: false,
        ready: true,
      });
    } catch (error) {
      if (current()) this.publish({ busy: false, error: message(error) });
    }
  }
  private async mutate<T>(work: () => Promise<T>): Promise<T | null> {
    const alive = this.begin();
    if (this.state.busy || !alive()) return null;
    this.publish({ busy: true, error: '' });
    try {
      const result = await work();
      if (!alive()) return null;
      await this.load();
      return result;
    } catch (error) {
      if (alive()) this.publish({ busy: false, error: message(error) });
      return null;
    }
  }
  create(draft: OrganizationAgentDraft) {
    return this.mutate(
      async () => (await this.api.create(this.organizationId, createBodyFromDraft(draft))).agent.id,
    );
  }
  update(agent: OrganizationAgent, patch: Record<string, unknown>) {
    if (!Object.keys(patch).length) return Promise.resolve(agent.id);
    return this.mutate(
      async () => (await this.api.update(this.organizationId, agent.id, patch)).agent.id,
    );
  }
  /** Starts a private chat owned by the signed-in user and adds it to the owned history. Returns
   * null if the Server, account or organization moved on, so the caller never navigates there. */
  async startChat(agentId: string) {
    const alive = this.begin();
    try {
      const result = await this.api.startChat(this.organizationId, agentId);
      if (!alive()) return null;
      const session = result.session ?? {};
      if (session.id && !this.state.chats.some((chat) => chat.id === session.id)) {
        const now = new Date().toISOString();
        this.publish({
          chats: [
            {
              id: session.id,
              name: session.name ?? result.agent?.name ?? '',
              agentId: result.agent?.id ?? agentId,
              agentName: result.agent?.name ?? null,
              agentAvailable: true,
              createdAt: session.created_at ?? now,
              updatedAt: session.updated_at ?? now,
            },
            ...this.state.chats,
          ],
        });
      }
      return result;
    } catch (error) {
      if (alive()) this.publish({ error: message(error) });
      return null;
    }
  }
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Could not load organization agents. Retry or check your Server connection.';
}

/** Web hash route for an organization page. The Server id pins the link to one connection. */
export function organizationRouteParams(serverId: string | null, organizationId: string | null) {
  const params = new URLSearchParams();
  if (organizationId) params.set('organization', organizationId);
  if (organizationId && serverId) params.set('server', serverId);
  return params;
}

/** Organization agents live in a hidden per-organization workspace whose id carries this prefix. */
export function isOrganizationAgentId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('__organization_');
}
