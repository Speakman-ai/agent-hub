/**
 * Pure helpers for the Server Agent's skill picker, shared by web and mobile.
 * The server is the authority on what may be added; these only shape the list.
 */
import type { ServerAgentSkillRef } from './hub.js';

export interface ServerAgentSkillOption {
  id: string;
  name: string;
  description: string;
  source: 'project' | 'global' | 'default';
}

export interface ServerAgentSkillOptions {
  builtIn: string[];
  global: ServerAgentSkillOption[];
  projects: Array<{ projectId: string; projectName: string; skills: ServerAgentSkillOption[] }>;
}

export interface ServerAgentSkillGroup {
  key: string;
  label: string;
  items: Array<{ ref: ServerAgentSkillRef; option: ServerAgentSkillOption }>;
}

export function sameSkillRef(a: ServerAgentSkillRef, b: ServerAgentSkillRef): boolean {
  return a.id === b.id && (a.projectId || '') === (b.projectId || '');
}

/**
 * Add a ref. The agent loads skills by id, so adding a skill whose id is
 * already present replaces the earlier ref rather than keeping both.
 */
export function addSkillRef(
  refs: readonly ServerAgentSkillRef[],
  ref: ServerAgentSkillRef,
): ServerAgentSkillRef[] {
  const next = refs.filter((r) => r.id !== ref.id);
  next.push(ref.projectId ? { id: ref.id, projectId: ref.projectId } : { id: ref.id });
  return next;
}

export function removeSkillRef(
  refs: readonly ServerAgentSkillRef[],
  ref: ServerAgentSkillRef,
): ServerAgentSkillRef[] {
  return refs.filter((r) => !sameSkillRef(r, ref));
}

function matches(option: ServerAgentSkillOption, needle: string): boolean {
  if (!needle) return true;
  return (
    option.id.toLowerCase().includes(needle) ||
    option.name.toLowerCase().includes(needle) ||
    option.description.toLowerCase().includes(needle)
  );
}

/**
 * Options the user can still add, grouped Global first then by project,
 * filtered by `query` (id, name or description). Already-added refs are hidden.
 */
export function addableSkillGroups(
  options: ServerAgentSkillOptions | null,
  added: readonly ServerAgentSkillRef[],
  query = '',
): ServerAgentSkillGroup[] {
  if (!options) return [];
  const needle = query.trim().toLowerCase();
  const isAdded = (ref: ServerAgentSkillRef) => added.some((r) => sameSkillRef(r, ref));
  const groups: ServerAgentSkillGroup[] = [];
  const globalItems = options.global
    .filter((o) => matches(o, needle))
    .map((option) => ({ ref: { id: option.id }, option }))
    .filter((item) => !isAdded(item.ref));
  if (globalItems.length) groups.push({ key: 'global', label: 'Global', items: globalItems });
  for (const project of options.projects) {
    const items = project.skills
      .filter((o) => matches(o, needle))
      .map((option) => ({ ref: { id: option.id, projectId: project.projectId }, option }))
      .filter((item) => !isAdded(item.ref));
    if (items.length) {
      groups.push({ key: `project:${project.projectId}`, label: project.projectName, items });
    }
  }
  return groups;
}

/** Display label and scope for an added ref; falls back to raw ids when options are unknown. */
export function describeSkillRef(
  ref: ServerAgentSkillRef,
  options: ServerAgentSkillOptions | null,
): { name: string; scope: string } {
  if (ref.projectId) {
    const project = options?.projects.find((p) => p.projectId === ref.projectId);
    const option = project?.skills.find((s) => s.id === ref.id);
    return { name: option?.name || ref.id, scope: project?.projectName || ref.projectId };
  }
  const option = options?.global.find((s) => s.id === ref.id);
  return { name: option?.name || ref.id, scope: 'Global' };
}
