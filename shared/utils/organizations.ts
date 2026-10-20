/** Business organizations use /organizations. Legacy /orgs still means Servers. */
export type OrganizationRole = 'Owner' | 'Admin' | 'Member';
export interface Organization {
  id: string;
  serverId: string;
  name: string;
  role: OrganizationRole | null;
  canManage: boolean;
}
export interface OrganizationProject {
  id: string;
  name: string;
  kind?: string;
}
export interface OrganizationMember {
  userId: string;
  username: string;
  role: OrganizationRole;
}
type Request = (path: string, options?: { method?: string; body?: string }) => Promise<any>;
export function createOrganizationApi(request: Request) {
  const path = (id: string) => `/organizations/${encodeURIComponent(id)}`;
  return {
    list: (): Promise<{ organizations: Organization[] }> => request('/organizations'),
    projects: async (): Promise<OrganizationProject[]> =>
      (await request('/organizations/project-choices')).projects,
    candidates: (): Promise<{ members: OrganizationMember[] }> => request('/chat/members'),
    linked: (id: string): Promise<{ projects: OrganizationProject[] }> =>
      request(`${path(id)}/projects`),
    members: (id: string): Promise<{ members: OrganizationMember[] }> =>
      request(`${path(id)}/members`),
    create: (name: string): Promise<{ organization: Organization }> =>
      request('/organizations', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (id: string, name: string) =>
      request(path(id), { method: 'PATCH', body: JSON.stringify({ name }) }),
    archive: (id: string) => request(path(id), { method: 'DELETE' }),
    link: (id: string, projectId: string, attached: boolean) =>
      request(`${path(id)}/projects/${encodeURIComponent(projectId)}`, {
        method: attached ? 'PUT' : 'DELETE',
      }),
    member: (id: string, userId: string, role: OrganizationRole | null) =>
      request(
        `${path(id)}/members/${encodeURIComponent(userId)}`,
        role ? { method: 'PUT', body: JSON.stringify({ role }) } : { method: 'DELETE' },
      ),
  };
}
export type OrganizationApi = ReturnType<typeof createOrganizationApi>;
export interface OrganizationState {
  organizations: Organization[];
  projects: OrganizationProject[];
  links: Record<string, OrganizationProject[]>;
  members: OrganizationMember[];
  candidates: OrganizationMember[];
  selectedId: string | null;
  busy: boolean;
  ready: boolean;
  error: string;
}
const empty = (): OrganizationState => ({
  organizations: [],
  projects: [],
  links: {},
  members: [],
  candidates: [],
  selectedId: null,
  busy: false,
  ready: false,
  error: '',
});
const staleState = empty();

/** Every awaited boundary checks the connection/account AND request generation.
 * In particular, a partially completed multi-select save cannot write to a newly selected Server.
 */
export class OrganizationController {
  state = empty();
  private scope: string;
  private generation = 0;
  private selectedId: string | null = null;
  private mutating = false;
  private listeners = new Set<() => void>();
  constructor(
    private api: OrganizationApi,
    private getScope: () => string,
    scope = getScope(),
  ) {
    this.scope = scope;
  }
  snapshot = () => (this.getScope() === this.scope ? this.state : staleState);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  cancel = () => {
    this.generation++;
  };
  private publish(patch: Partial<OrganizationState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private current(generation: number) {
    return generation === this.generation && this.scope === this.getScope();
  }
  refresh = () => {
    if (!this.mutating) void this.load();
  };
  async load(selectedId: string | null = this.selectedId) {
    const generation = ++this.generation;
    if (this.scope !== this.getScope()) {
      this.scope = this.getScope();
      selectedId = null;
    }
    this.selectedId = selectedId;
    // Hide stale authorization data immediately, including after a revocation event.
    this.publish({ ...empty(), busy: true });
    try {
      const [result, projects] = await Promise.all([this.api.list(), this.api.projects()]);
      if (!this.current(generation)) return;
      const organizations = result.organizations;
      const selected = organizations.find((o) => o.id === selectedId);
      const links = await Promise.all(
        organizations.map(async (o) => [o.id, (await this.api.linked(o.id)).projects] as const),
      );
      if (!this.current(generation)) return;
      const [members, candidates] = selected
        ? await Promise.all([
            this.api.members(selected.id),
            selected.canManage ? this.api.candidates() : Promise.resolve({ members: [] }),
          ])
        : [{ members: [] }, { members: [] }];
      if (!this.current(generation)) return;
      this.selectedId = selected?.id ?? null;
      this.publish({
        organizations,
        projects: projects.filter((p) => p.kind !== 'system' && p.id !== '__hub__'),
        links: Object.fromEntries(links),
        members: members.members,
        candidates: candidates.members,
        selectedId: selected?.id ?? null,
        ready: true,
        busy: false,
      });
    } catch (error) {
      if (this.current(generation)) this.publish({ busy: false, error: message(error) });
    }
  }
  private async mutate(work: (current: () => boolean) => Promise<string | null | void>) {
    if (this.state.busy || !this.state.ready || this.getScope() !== this.scope) return;
    const generation = ++this.generation;
    const current = () => this.current(generation);
    const selectedId = this.state.selectedId;
    this.mutating = true;
    this.publish({ busy: true, error: '' });
    let error = '';
    let nextId: string | null | void = undefined;
    try {
      nextId = await work(current);
    } catch (cause) {
      error = message(cause);
    }
    this.mutating = false;
    if (!current()) return;
    await this.load(nextId === undefined ? selectedId : nextId);
    if (this.scope === this.getScope() && error) this.publish({ error });
  }
  create(name: string) {
    return this.mutate(async () => (await this.api.create(name.trim())).organization.id);
  }
  rename(name: string) {
    return this.mutate(async () => {
      await this.api.rename(this.manage(), name.trim());
    });
  }
  archive() {
    return this.mutate(async () => {
      await this.api.archive(this.manage());
      return null;
    });
  }
  member(userId: string, role: OrganizationRole | null) {
    return this.mutate(async () => {
      await this.api.member(this.manage(), userId, role);
    });
  }
  private manage() {
    const organization = this.state.organizations.find((o) => o.id === this.state.selectedId);
    if (!organization?.canManage)
      throw new Error('Ask an organization Owner or Admin to make changes.');
    return organization.id;
  }
  saveProjects(ids: string[]) {
    return this.mutate(async (current) => {
      const id = this.manage();
      const before = new Set(this.state.links[id]?.map((p) => p.id));
      for (const project of this.state.projects) {
        if (!current()) return;
        if (before.has(project.id) !== ids.includes(project.id))
          await this.api.link(id, project.id, ids.includes(project.id));
      }
    });
  }
  saveProjectOrganizations(projectId: string, ids: string[]) {
    return this.mutate(async (current) => {
      if (!this.state.projects.some((p) => p.id === projectId))
        throw new Error('Project unavailable. Refresh or check your project access.');
      for (const organization of this.state.organizations.filter((o) => o.canManage)) {
        if (!current()) return;
        const before = this.state.links[organization.id]?.some((p) => p.id === projectId) ?? false;
        if (before !== ids.includes(organization.id))
          await this.api.link(organization.id, projectId, ids.includes(organization.id));
      }
    });
  }
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Could not load organizations. Retry or check your Server connection.';
}
