// Organization switcher for the sidebar.
//
// A project may be linked to several organizations or to none. The sidebar
// shows one organization at a time; linked projects appear in every
// organization they belong to, and projects with no link stay in an
// Independent option. An empty organization list means "no switcher" — the
// sidebar keeps its flat project list.

export const SIDEBAR_ORG_SECTIONS_KEY = 'sidebarOrgSectionsCollapsed';
export const SIDEBAR_SELECTED_ORG_KEY = 'sidebarSelectedOrganization';

/** The organization (or Independent) the sidebar should show. */
export function activeOrganizationSection(
  sections: readonly SidebarOrgSection[] | null,
  selectedId: string | null,
): SidebarOrgSection | null {
  if (!sections?.length) return null;
  return sections.find((section) => section.id === selectedId) ?? sections[0];
}

export function readSelectedOrganization(): string | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_SELECTED_ORG_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeSelectedOrganization(id: string | null): void {
  try {
    if (!id) {
      localStorage.removeItem(SIDEBAR_SELECTED_ORG_KEY);
      return;
    }
    localStorage.setItem(SIDEBAR_SELECTED_ORG_KEY, id);
  } catch {
    // Best-effort — private mode / quota.
  }
}

export interface SidebarOrgRef {
  id: string;
  name: string;
}

export interface SidebarOrgSection {
  id: string;
  name: string;
  projectIds: string[];
}

export function groupProjectsByOrganization(
  projects: readonly { id: string }[],
  organizations: readonly SidebarOrgRef[],
  links: Record<string, readonly { id: string }[] | undefined>,
): SidebarOrgSection[] | null {
  if (!organizations.length) return null;
  const projectIds = projects.map((project) => project.id);
  const known = new Set(projectIds);
  const linked = new Set<string>();
  const sections: SidebarOrgSection[] = organizations.map((org) => {
    const memberIds = new Set(
      (links[org.id] || []).map((project) => project.id).filter((id) => known.has(id)),
    );
    const ids = projectIds.filter((id) => memberIds.has(id));
    for (const id of ids) linked.add(id);
    return { id: org.id, name: org.name, projectIds: ids };
  });
  const independent = projectIds.filter((id) => !linked.has(id));
  if (independent.length) {
    sections.push({ id: 'independent', name: 'Independent', projectIds: independent });
  }
  return sections;
}

/** Read collapsed organization sections. Missing keys stay expanded. */
export function readCollapsedOrgSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SIDEBAR_ORG_SECTIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && key.length > 0 && value === true) out[key] = true;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist collapsed organization sections. Drops the key when nothing is collapsed. */
export function writeCollapsedOrgSections(state: Record<string, boolean>): void {
  try {
    const collapsed: Record<string, true> = {};
    for (const [key, value] of Object.entries(state)) {
      if (value === true && key.length > 0) collapsed[key] = true;
    }
    if (Object.keys(collapsed).length === 0) {
      localStorage.removeItem(SIDEBAR_ORG_SECTIONS_KEY);
      return;
    }
    localStorage.setItem(SIDEBAR_ORG_SECTIONS_KEY, JSON.stringify(collapsed));
  } catch {
    // Best-effort — private mode / quota.
  }
}
