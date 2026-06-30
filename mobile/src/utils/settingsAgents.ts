// Pure helpers for the Settings → Agents tab (mobile). Kept in src/utils/
// so they're covered by the existing vitest config
// (include: ['src/utils/**/*.test.js']) without importing react-native.
/**
 * Group the flat `/api/agents` list (each row enriched with `projectId`)
 * by project. Projects with zero agents are still returned so the user can
 * add the first agent to them; agents whose projectId matches no known
 * project land in a trailing "Other" bucket.
 *
 * @param {Array<{id: string, name?: string, projectId?: string}>} agents
 * @param {Array<{id: string, name?: string, color?: string}>} projects
 * @returns {Array<{projectId: string|null, projectName: string, color: string|null, agents: Array}>}
 */
export function groupAgentsByProject(agents: any, projects: any) {
    const safeAgents = Array.isArray(agents) ? agents.filter(Boolean) : [];
    const safeProjects = Array.isArray(projects) ? projects.filter(Boolean) : [];
    const groups = safeProjects.map((p: any) => ({
        projectId: p.id,
        projectName: p.name || p.id,
        color: p.color || null,
        agents: safeAgents.filter((a: any) => a.projectId === p.id),
    }));
    const knownIds = new Set(safeProjects.map((p: any) => p.id));
    const orphans = safeAgents.filter((a: any) => !knownIds.has(a.projectId));
    if (orphans.length > 0) {
        groups.push({ projectId: null, projectName: 'Other', color: null, agents: orphans });
    }
    return groups;
}
/**
 * Resolve the effective new-agent form for submission.
 *
 * When the Agents tab is project-scoped (`filterProjectId` is set), the Project
 * picker is hidden, so `form.projectId` is never populated from the UI. Force
 * the scoped project onto the form so the agent is always created under the
 * project whose Agents screen the user is on — never the section's default
 * state (which would create it under the wrong / no project).
 *
 * Pass-through (returns the same form) when there is no scope.
 *
 * @param {object} form
 * @param {string | null | undefined} filterProjectId
 * @returns {object}
 */
export function resolveNewAgentForm(form: any, filterProjectId: any) {
    if (!filterProjectId)
        return form;
    return { ...form, projectId: filterProjectId };
}
/**
 * Validate the new-agent form. Returns an error string, or null when valid.
 * Mirrors the server's CreateAgentRequestSchema essentials: `id` and
 * `projectId` are required; ids are slug-shaped.
 */
export function validateNewAgentForm(form: any) {
    const id = (form?.id || '').trim();
    if (!id)
        return 'Agent ID is required.';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(id)) {
        return 'Agent ID must be alphanumeric (hyphens/underscores allowed).';
    }
    if (!form?.projectId)
        return 'Pick a project for the new agent.';
    return null;
}
/**
 * Build the POST /api/agents payload from the new-agent form. Empty
 * optional fields are omitted so the server applies its own defaults
 * (name falls back to id, model to the engine default, color to the
 * project color). `isDev` is always sent (defaults to `false`) so new
 * agents are opt-in for autonomous-ticket dispatch.
 */
export function buildCreateAgentPayload(form: any) {
    const payload: Record<string, any> = {
        id: (form.id || '').trim(),
        projectId: form.projectId,
        isDev: form.isDev === true,
    };
    if ((form.name || '').trim())
        payload.name = form.name.trim();
    if (form.engine)
        payload.engine = form.engine;
    if (form.model)
        payload.model = form.model;
    if ((form.systemPrompt || '').trim())
        payload.systemPrompt = form.systemPrompt.trim();
    return payload;
}
/**
 * Build the PATCH /api/agents/:id payload from an edit form, including only
 * fields that actually changed vs. the original agent record. Returns an
 * empty object when nothing changed (caller can skip the request).
 */
export function buildUpdateAgentPayload(original: any, edit: any) {
    const payload: Record<string, any> = {};
    if (!original || !edit)
        return payload;
    for (const field of ['name', 'engine', 'systemPrompt']) {
        const next = edit[field];
        if (next !== undefined && next !== (original[field] ?? '')) {
            payload[field] = next;
        }
    }
    // The Dev flag: include it only when the editable value actually differs
    // from the agent's effective eligibility, and never for locked agents
    // (default Dev roles / out-of-band roles can't be changed).
    if (edit.isDev !== undefined && !isAutonomyLocked(original)) {
        if (edit.isDev !== agentAcceptsAutonomousTickets(original)) {
            payload.isDev = edit.isDev;
        }
    }
    return payload;
}
// ─── Per-agent "Dev" flag (autonomous-ticket eligibility) ────────────────────
// Mirror of server/agent-autonomy.ts — keep in sync with the server + web util.
// `skill-builder` is a conversational coach (not a code-shipping recipient), so
// its Dev toggle is locked OFF like docs/reviewer.
const OUT_OF_BAND_ROLES = new Set(['docs', 'reviewer', 'skill-builder']);
const DEFAULT_DEV_ROLES = new Set(['dev', 'lead']);
function autonomyRoleOf(agent: any) {
    return agent && typeof agent.role === 'string' ? agent.role.trim().toLowerCase() : '';
}
/** Out-of-band role (docs/reviewer) — the Dev toggle is locked OFF. */
export function isAutonomyLockedOff(agent: any) {
    return OUT_OF_BAND_ROLES.has(autonomyRoleOf(agent));
}
/** Default Dev role (dev/lead) — the Dev toggle is locked ON. */
export function isAutonomyLockedOn(agent: any) {
    return DEFAULT_DEV_ROLES.has(autonomyRoleOf(agent));
}
/** The Dev toggle cannot be changed for this agent. */
export function isAutonomyLocked(agent: any) {
    return isAutonomyLockedOff(agent) || isAutonomyLockedOn(agent);
}
/**
 * Effective: may this agent receive an autonomously-dispatched ticket?
 *  - out-of-band roles → never
 *  - default Dev roles → always
 *  - explicit isDev === false → opt-out
 *  - otherwise (isDev true, or undefined for pre-flag agents) → eligible
 */
export function agentAcceptsAutonomousTickets(agent: any) {
    if (!agent)
        return false;
    if (isAutonomyLockedOff(agent))
        return false;
    if (isAutonomyLockedOn(agent))
        return true;
    return agent.isDev !== false;
}
/**
 * Engines offered by the picker — keys of `engineValidModels` that have at
 * least one model (i.e. the host/user is authenticated for that engine).
 */
export function settingsEngineChoices(modelConfig: any) {
    const map = modelConfig?.engineValidModels;
    if (!map)
        return [];
    return Object.keys(map).filter((eng: any) => (map[eng]?.length ?? 0) > 0);
}
/** Models valid for an engine, per the server's /api/config/models map. */
export function settingsModelsForEngine(modelConfig: any, engine: any) {
    return modelConfig?.engineValidModels?.[engine] || [];
}
/** The server-side default model for an engine (used as picker fallback). */
export function settingsDefaultModelForEngine(modelConfig: any, engine: any) {
    if (!modelConfig)
        return '';
    return modelConfig.engineDefaultModels?.[engine] || modelConfig.defaultModel || '';
}
/**
 * Sentinel chip value for "use the shared/engine default model" in the
 * per-user model picker. Selecting it clears the caller's personal override
 * (the parent maps `''` → DELETE /api/auth/me/agent-model-overrides/:id), so
 * the agent tracks the server default again — even if that default later
 * changes. Without this the picker can only ever swap one concrete override
 * for another and never get back to default behaviour.
 */
export const PER_USER_DEFAULT_MODEL = '__default__';
/**
 * Which model chip should render active in the per-user picker. Returns the
 * caller's override when it is still a valid model for the current engine,
 * otherwise the {@link PER_USER_DEFAULT_MODEL} sentinel so the "Default" chip
 * highlights whenever no (valid) personal override is set.
 */
export function settingsSelectedModelChip(modelOverride: any, models: any) {
    const valid = Array.isArray(models) ? models : [];
    return modelOverride && valid.includes(modelOverride) ? modelOverride : PER_USER_DEFAULT_MODEL;
}
/**
 * Resolve a model-chip press to the value handed to the override saver. The
 * {@link PER_USER_DEFAULT_MODEL} sentinel resolves to `''` (clear the
 * override, back to shared/default); any concrete model id passes through
 * unchanged.
 */
export function settingsResolveModelChip(chip: any) {
    return chip === PER_USER_DEFAULT_MODEL ? '' : chip;
}
/**
 * The engine actually in effect for a user's sessions with an agent: their
 * personal engine override when set, otherwise the shared engine, otherwise
 * the built-in default. Mirrors the resolution the runtime uses.
 */
export function settingsEffectiveEngine(engineOverride: any, sharedEngine: any) {
    return engineOverride || sharedEngine || 'claude-code';
}
/**
 * True when a stored per-user model override is no longer valid for the
 * `effectiveEngine` (e.g. the user just switched their engine override, so a
 * model from the previous engine is now incompatible). Callers clear the
 * override in that case so the runtime never receives a mismatched
 * engine/model pair and the picker's "Default" fallback reflects real state.
 * An empty override is never stale (there is nothing to clear).
 */
export function settingsModelOverrideIsStale(modelOverride: any, effectiveEngine: any, modelConfig: any) {
    if (!modelOverride)
        return false;
    return !settingsModelsForEngine(modelConfig, effectiveEngine).includes(modelOverride);
}
