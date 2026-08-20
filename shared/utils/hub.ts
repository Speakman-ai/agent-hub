/**
 * Hub — the org/user home surface (assistant + Dashboard / Daily Summary /
 * Org / Todos / Calendar / Mail).
 *
 * Constants and parsers shared by web, mobile, and the server so nav hashes,
 * the hidden Hub project, and the assistant agent id cannot drift.
 */

export const HUB_PROJECT_ID = '__hub__';
export const HUB_ASSISTANT_AGENT_ID = '__hub_assistant__';
export const HUB_ASSISTANT_ROLE = 'hub-assistant';
export const HUB_SESSION_MODE = 'hub';
export const HUB_SESSION_NAME = 'Hub';

/** Workspace panes inside Hub (the assistant is a sibling column / tab, not a pane). */
export const HUB_WORKSPACE_PANES = [
  'today',
  'summary',
  'org',
  'todos',
  'calendar',
  'mail',
] as const;
export type HubWorkspacePane = (typeof HUB_WORKSPACE_PANES)[number];
export const DEFAULT_HUB_PANE: HubWorkspacePane = 'today';

/** Retired top-level views that now live inside Hub. */
export const LEGACY_HUB_VIEWS: Record<string, HubWorkspacePane> = {
  home: 'today',
  dashboard: 'org',
  todos: 'todos',
  calendar: 'calendar',
  gmail: 'mail',
};

export function isHubProjectId(id: string | null | undefined): boolean {
  return id === HUB_PROJECT_ID;
}

export function isHubSystemProject(
  project: { id?: string | null; kind?: string | null } | null | undefined,
): boolean {
  if (!project) return false;
  return project.id === HUB_PROJECT_ID || project.kind === 'system';
}

export function isHubAssistantRole(role: string | null | undefined): boolean {
  return (role ?? '').trim().toLowerCase() === HUB_ASSISTANT_ROLE;
}

export function isHubAssistantAgentId(id: string | null | undefined): boolean {
  return id === HUB_ASSISTANT_AGENT_ID;
}

export function isHubWorkspacePane(value: unknown): value is HubWorkspacePane {
  return typeof value === 'string' && (HUB_WORKSPACE_PANES as readonly string[]).includes(value);
}

export function parseHubPane(value: unknown): HubWorkspacePane {
  return isHubWorkspacePane(value) ? value : DEFAULT_HUB_PANE;
}

export function hubPaneFromLegacyView(view: string | null | undefined): HubWorkspacePane | null {
  if (!view) return null;
  return LEGACY_HUB_VIEWS[view] ?? null;
}
