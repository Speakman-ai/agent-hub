/**
 * Simple-chat roster grouped by organization.
 *
 * A project linked to an organization appears in that group. Projects with no
 * link sit in Independent. Organizations and the projects inside them keep a
 * saved order; anything new is appended, and an empty saved list keeps the
 * order the caller already had.
 */

export type SimpleRosterOrganization = {
  id: string;
  name: string;
};

export type SimpleChatProject<T> = {
  id: string;
  name: string;
  items: T[];
};

export type SimpleChatGroup<T> = {
  id: string;
  name: string;
  projects: SimpleChatProject<T>[];
};

export const SIMPLE_INDEPENDENT_ORG_ID = 'independent';

function reconcile(saved: readonly string[] | undefined, current: readonly string[]): string[] {
  if (current.length === 0) return [];
  const live = new Set(current);
  const kept = (saved ?? []).filter((id) => live.has(id));
  const seen = new Set(kept);
  return [...kept, ...current.filter((id) => !seen.has(id))];
}

/**
 * Null when there is no organization to group by, so the roster stays a flat
 * list. Empty organizations are omitted; Independent is included only when
 * some chat's project is not linked to any organization.
 */
export function groupSimpleChats<T>(input: {
  items: readonly T[];
  projectId: (item: T) => string;
  projectName: (item: T) => string;
  organizations: readonly SimpleRosterOrganization[] | null | undefined;
  /** Organization id → project ids linked to it. */
  membership: Readonly<Record<string, readonly string[] | undefined>>;
  orgOrder?: readonly string[];
  projectOrderByOrg?: Readonly<Record<string, readonly string[] | undefined>>;
}): SimpleChatGroup<T>[] | null {
  const organizations = input.organizations;
  if (!organizations || organizations.length === 0) return null;

  const itemsByProject = new Map<string, T[]>();
  const nameByProject = new Map<string, string>();
  const projectIds: string[] = [];
  for (const item of input.items) {
    const id = input.projectId(item).trim() || 'unknown';
    if (!itemsByProject.has(id)) {
      itemsByProject.set(id, []);
      nameByProject.set(id, input.projectName(item).trim() || 'Project');
      projectIds.push(id);
    }
    itemsByProject.get(id)!.push(item);
  }

  const known = new Set(projectIds);
  const linked = new Set<string>();
  const sections: { id: string; name: string; projectIds: string[] }[] = organizations.map(
    (org) => {
      const member = new Set((input.membership[org.id] || []).filter((id) => known.has(id)));
      const ids = projectIds.filter((id) => member.has(id));
      for (const id of ids) linked.add(id);
      return { id: org.id, name: org.name, projectIds: ids };
    },
  );
  const independent = projectIds.filter((id) => !linked.has(id));
  if (independent.length > 0) {
    sections.push({
      id: SIMPLE_INDEPENDENT_ORG_ID,
      name: 'Independent',
      projectIds: independent,
    });
  }

  const byId = new Map(sections.map((section) => [section.id, section]));
  return reconcile(
    input.orgOrder,
    sections.map((section) => section.id),
  )
    .map((id) => {
      const section = byId.get(id);
      if (!section) return null;
      const orderedIds = reconcile(input.projectOrderByOrg?.[id], section.projectIds);
      return {
        id: section.id,
        name: section.name,
        projects: orderedIds.map((projectId) => ({
          id: projectId,
          name: nameByProject.get(projectId) || 'Project',
          items: itemsByProject.get(projectId) || [],
        })),
      };
    })
    .filter((group): group is SimpleChatGroup<T> => !!group && group.projects.length > 0);
}
