/**
 * Skills a user adds to their Server Agent, on top of the built-in Hub set.
 *
 * The Server Agent is one shared agent row, so the additions live in the
 * user's preferences (`serverAgent.skills`) and are applied per turn from the
 * session owner. A ref is either a global/bundled skill (`{ id }`) or a skill
 * from a project's own store (`{ id, projectId }`). Project refs are checked
 * against the user's project visibility twice: when saved, and again on every
 * turn, so losing access to a project drops its skills without a migration.
 */
import { isHubSystemProject } from '../shared/utils/hub.js';
import type {
  ServerAgentSkillOption,
  ServerAgentSkillOptions,
} from '../shared/utils/serverAgentSkills.js';
import {
  listGlobalCatalogSkills,
  listProjectSkills,
  type PinnedSkill,
  type SkillWithSource,
} from './agent-skills-list.js';
import { isLocalBundledServer } from './auth.js';
import { buildDailySummaryCaller } from './daily-summary-schedule.js';
import { HUB_SKILL_IDS } from './hub-mode-prompt.js';
import { findProject, getProjects, resolveProjectSkillsDir } from './project-model.js';
import { canViewProject, type VisibilityCaller } from './project-visibility.js';
import type { Project } from './types.js';
import { getUserPreferencesRow, type ServerAgentSkillRef } from './user-preferences-store.js';

/** What one turn of a Server Agent session may see and load beyond the agent row. */
export interface ServerAgentSkillScope {
  ids: string[];
  pinned: PinnedSkill[];
}

const BUILT_IN = new Set<string>(HUB_SKILL_IDS);

function toOption(s: SkillWithSource): ServerAgentSkillOption {
  return { id: s.id, name: s.name, description: s.description, source: s.source };
}

function canPickFromProject(project: Project | null, caller: VisibilityCaller): project is Project {
  if (!project || project.kind === 'system' || isHubSystemProject(project)) return false;
  return canViewProject(project, caller);
}

/** The visibility context a Server Agent turn runs under: its owner's own. */
export function serverAgentCaller(userId: string): VisibilityCaller {
  if (isLocalBundledServer()) return { userId, localBypass: true };
  return buildDailySummaryCaller(userId);
}

export function listServerAgentSkillOptions(caller: VisibilityCaller): ServerAgentSkillOptions {
  const projects: ServerAgentSkillOptions['projects'] = [];
  for (const project of getProjects()) {
    if (!canPickFromProject(project, caller)) continue;
    const skills = listProjectSkills(resolveProjectSkillsDir(project))
      .filter((s) => !BUILT_IN.has(s.id))
      .map(toOption);
    if (skills.length > 0) {
      projects.push({ projectId: project.id, projectName: project.name, skills });
    }
  }
  projects.sort((a, b) => a.projectName.localeCompare(b.projectName));
  return {
    builtIn: [...HUB_SKILL_IDS],
    global: listGlobalCatalogSkills()
      .filter((s) => !BUILT_IN.has(s.id))
      .map(toOption),
    projects,
  };
}

type RefCheck = { ok: true; pinned?: PinnedSkill } | { ok: false; error: string };

function checkRef(
  ref: ServerAgentSkillRef,
  caller: VisibilityCaller,
  globalIds: () => Set<string>,
): RefCheck {
  if (BUILT_IN.has(ref.id)) {
    return { ok: false, error: `Skill "${ref.id}" is already built in to the Server Agent` };
  }
  if (!ref.projectId) {
    return globalIds().has(ref.id)
      ? { ok: true }
      : { ok: false, error: `Skill "${ref.id}" was not found` };
  }
  const project = findProject(ref.projectId);
  if (!canPickFromProject(project, caller)) {
    return { ok: false, error: `Project "${ref.projectId}" was not found` };
  }
  const root = resolveProjectSkillsDir(project);
  if (!listProjectSkills(root).some((s) => s.id === ref.id)) {
    return { ok: false, error: `Skill "${ref.id}" was not found in project "${project.name}"` };
  }
  return { ok: true, pinned: { id: ref.id, root } };
}

function lazyGlobalIds(): () => Set<string> {
  let ids: Set<string> | null = null;
  return () => (ids ??= new Set(listGlobalCatalogSkills().map((s) => s.id)));
}

/**
 * Validate a list the user is saving. Ids must be unique: the agent loads
 * skills by id, so two refs with one id would leave it unable to pick between
 * them. Refs not in `saved` must exist and be usable by the caller. Refs
 * already saved are kept as is even if they stopped resolving, so removing one
 * stale skill never fails because another saved skill went stale too; turns
 * drop unresolvable refs anyway.
 */
export function validateServerAgentSkillRefs(
  refs: readonly ServerAgentSkillRef[],
  caller: VisibilityCaller,
  saved: readonly ServerAgentSkillRef[] = [],
): { ok: true } | { ok: false; error: string } {
  const globalIds = lazyGlobalIds();
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ids.has(ref.id)) {
      return { ok: false, error: `Skill "${ref.id}" was added more than once` };
    }
    ids.add(ref.id);
    const alreadySaved = saved.some(
      (r) => r.id === ref.id && (r.projectId || '') === (ref.projectId || ''),
    );
    if (alreadySaved) continue;
    const check = checkRef(ref, caller, globalIds);
    if (!check.ok) return check;
  }
  return { ok: true };
}

/**
 * The added skills a turn may use right now. Refs that stopped resolving (the
 * skill was deleted, or the user lost access to its project) are dropped.
 */
export function resolveServerAgentSkillScope(
  refs: readonly ServerAgentSkillRef[] | undefined,
  caller: VisibilityCaller,
): ServerAgentSkillScope {
  const scope: ServerAgentSkillScope = { ids: [], pinned: [] };
  if (!refs?.length) return scope;
  const globalIds = lazyGlobalIds();
  for (const ref of refs) {
    if (scope.ids.includes(ref.id)) continue;
    const check = checkRef(ref, caller, globalIds);
    if (!check.ok) continue;
    scope.ids.push(ref.id);
    if (check.pinned) scope.pinned.push(check.pinned);
  }
  return scope;
}

/**
 * Widen an agent allowlist with the scope's ids. An unrestricted agent
 * (`null`/`undefined`) stays unrestricted.
 */
export function widenAllowedSkills(
  allowedSkills: string[] | null | undefined,
  scope: ServerAgentSkillScope | null,
): string[] | null {
  if (!Array.isArray(allowedSkills)) return null;
  if (!scope?.ids.length) return allowedSkills;
  return [...allowedSkills, ...scope.ids.filter((id) => !allowedSkills.includes(id))];
}

/** The session owner's added skills, resolved for this turn. Empty on any failure. */
export function serverAgentSkillScopeForUser(
  userId: string | null | undefined,
): ServerAgentSkillScope {
  if (!userId) return { ids: [], pinned: [] };
  try {
    const refs = getUserPreferencesRow(userId).serverAgent?.skills;
    return resolveServerAgentSkillScope(refs, serverAgentCaller(userId));
  } catch (err) {
    console.warn(
      `[server-agent-skills] could not resolve skills for ${userId}:`,
      (err as Error).message,
    );
    return { ids: [], pinned: [] };
  }
}

/** Project skill dirs to read a skill's credential/option schema from, in precedence order. */
export function skillSchemaDirs(
  skillsRoot: string,
  scope: ServerAgentSkillScope | null | undefined,
  skillId: string,
): string[] {
  const dirs = [skillsRoot];
  for (const pin of scope?.pinned ?? []) if (pin.id === skillId) dirs.push(pin.root);
  return dirs;
}
