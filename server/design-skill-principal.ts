/**
 * Skill enable/disable + credential merge for Design Studio spawns must use the
 * same sentinel as `skill-router.ts` built-in routing and
 * `server/default-skills/design/SKILL.md` — not a positional `agents[0]` guess.
 */
export const DESIGN_SKILL_PRINCIPAL_AGENT_ID = '__design_studio__';
