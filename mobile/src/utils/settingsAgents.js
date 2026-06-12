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
export function groupAgentsByProject(agents, projects) {
  const safeAgents = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const safeProjects = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const groups = safeProjects.map((p) => ({
    projectId: p.id,
    projectName: p.name || p.id,
    color: p.color || null,
    agents: safeAgents.filter((a) => a.projectId === p.id),
  }));
  const knownIds = new Set(safeProjects.map((p) => p.id));
  const orphans = safeAgents.filter((a) => !knownIds.has(a.projectId));
  if (orphans.length > 0) {
    groups.push({ projectId: null, projectName: 'Other', color: null, agents: orphans });
  }
  return groups;
}

/**
 * Validate the new-agent form. Returns an error string, or null when valid.
 * Mirrors the server's CreateAgentRequestSchema essentials: `id` and
 * `projectId` are required; ids are slug-shaped.
 */
export function validateNewAgentForm(form) {
  const id = (form?.id || '').trim();
  if (!id) return 'Agent ID is required.';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(id)) {
    return 'Agent ID must be alphanumeric (hyphens/underscores allowed).';
  }
  if (!form?.projectId) return 'Pick a project for the new agent.';
  return null;
}

/**
 * Build the POST /api/agents payload from the new-agent form. Empty
 * optional fields are omitted so the server applies its own defaults
 * (name falls back to id, model to the engine default, color to the
 * project color).
 */
export function buildCreateAgentPayload(form) {
  const payload = {
    id: (form.id || '').trim(),
    projectId: form.projectId,
  };
  if ((form.name || '').trim()) payload.name = form.name.trim();
  if (form.engine) payload.engine = form.engine;
  if (form.model) payload.model = form.model;
  if ((form.systemPrompt || '').trim()) payload.systemPrompt = form.systemPrompt.trim();
  return payload;
}

/**
 * Build the PATCH /api/agents/:id payload from an edit form, including only
 * fields that actually changed vs. the original agent record. Returns an
 * empty object when nothing changed (caller can skip the request).
 */
export function buildUpdateAgentPayload(original, edit) {
  const payload = {};
  if (!original || !edit) return payload;
  for (const field of ['name', 'engine', 'model', 'systemPrompt']) {
    const next = edit[field];
    if (next !== undefined && next !== (original[field] ?? '')) {
      payload[field] = next;
    }
  }
  return payload;
}

/**
 * Engines offered by the picker — keys of `engineValidModels` that have at
 * least one model (i.e. the host/user is authenticated for that engine).
 */
export function settingsEngineChoices(modelConfig) {
  const map = modelConfig?.engineValidModels;
  if (!map) return [];
  return Object.keys(map).filter((eng) => (map[eng]?.length ?? 0) > 0);
}

/** Models valid for an engine, per the server's /api/config/models map. */
export function settingsModelsForEngine(modelConfig, engine) {
  return modelConfig?.engineValidModels?.[engine] || [];
}

/** The server-side default model for an engine (used as picker fallback). */
export function settingsDefaultModelForEngine(modelConfig, engine) {
  if (!modelConfig) return '';
  return modelConfig.engineDefaultModels?.[engine] || modelConfig.defaultModel || '';
}
