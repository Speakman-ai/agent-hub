// Shared cron engine + model resolution helpers for the mobile SettingsScreen.
//
// Mirrors the precedence chain enforced server-side in
// `server/cron-engine.ts::resolveCronEngine` and
// `server/cron-skill-principal.ts::resolveCronSkillPrincipalAgentId`.
//
// Why this lives in its own module:
//   - The cron form needs to filter the model picker by the engine the
//     cron will actually run under (per-row override → skill principal →
//     project default → sole-agent fallback → claude-code).
//   - The screen file is large and the precedence chain is fiddly enough
//     that a unit test on its own surface keeps the resolver honest.
//
// Keep in sync with `server/cron-engine.ts` — divergence between the UI
// and the server is exactly the bug `card 70b5ac8c` shipped to prevent.
/**
 * Default engine for a cron with `engine = ''` (blank/null in DB).
 * Mirrors `DEFAULT_CRON_ENGINE` on the server — historically every cron
 * targeted Claude Code, so the model dropdown also falls back to
 * claude-code's allowlist when the engine picker is left blank and no
 * skill principal supplies a different engine.
 */
export const CRON_DEFAULT_ENGINE = 'claude-code';
export function cronEngineChoices(modelConfig: any) {
    if (!modelConfig?.engineValidModels)
        return [];
    return Object.keys(modelConfig.engineValidModels).filter((e: any) => (modelConfig.engineValidModels[e]?.length ?? 0) > 0);
}
export function modelsForCronEngine(modelConfig: any, engine: any) {
    const key = engine || CRON_DEFAULT_ENGINE;
    return modelConfig?.engineValidModels?.[key] || [];
}
export function defaultModelForCronEngine(modelConfig: any, engine: any) {
    const key = engine || CRON_DEFAULT_ENGINE;
    return modelConfig?.engineDefaultModels?.[key] || '';
}
/**
 * Mirror `resolveCronSkillPrincipalAgentId` on the server: pick the
 * agent whose engine the cron would inherit when its own `engine`
 * column is blank. Order:
 *   1. cron.skill_principal_agent_id
 *   2. project.cronSkillPrincipalAgentId
 *   3. project.agents (sole-agent fallback)
 * Returns null when nothing resolves so the caller can advertise the
 * historical claude-code default.
 */
export function resolveCronSkillPrincipalEngine(formState: any, projects: any) {
    const project = (projects || []).find((p: any) => p.id === formState?.project_id);
    if (!project)
        return null;
    const principalId = (formState?.skill_principal_agent_id || '').trim() ||
        (project.cronSkillPrincipalAgentId || '').trim() ||
        (project.agents?.length === 1 ? project.agents[0].id : '');
    if (!principalId)
        return null;
    const agent = (project.agents || []).find((a: any) => a.id === principalId);
    return agent?.engine || null;
}
/**
 * Engine the cron will actually run under given the form state — the
 * explicit picker value when set, otherwise the inherited engine from
 * the skill principal, finally falling back to claude-code. The model
 * dropdown filters on this so the operator can't accidentally save a
 * Cursor id under a cron whose project resolves to Codex.
 */
export function effectiveCronEngine(formState: any, projects: any) {
    return (formState?.engine ||
        resolveCronSkillPrincipalEngine(formState, projects) ||
        CRON_DEFAULT_ENGINE);
}
/**
 * Helper-text version of the inherited-engine lookup: returns null when
 * the inherited engine would equal `CRON_DEFAULT_ENGINE` (no point
 * shouting "will run as claude-code — inherited" when claude-code is
 * already the historical default).
 */
export function inheritedCronEngineForHelper(formState: any, projects: any) {
    if (formState?.engine)
        return null;
    const eng = resolveCronSkillPrincipalEngine(formState, projects);
    return eng && eng !== CRON_DEFAULT_ENGINE ? eng : null;
}
