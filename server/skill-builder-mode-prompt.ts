/**
 * Skill-builder session mode — conversational project skill authoring folded
 * into the session mode picker (successor to the dedicated Skill Builder agent).
 *
 * Force-loads `skill-creator` + `agent-hub` on every turn (see
 * `requiredSkillIdsForSession` in design-mode-prompt.ts) and prepends this
 * preamble so the agent interviews, drafts, and saves SKILL.md via the API.
 */
import type { Project } from './types.js';

export const SKILL_CREATOR_SKILL_ID = 'skill-creator';

export function buildSkillBuilderModePreamble(args: {
  project: Pick<Project, 'id' | 'name'>;
}): string {
  const { project } = args;
  return [
    '## Skill Builder mode',
    '',
    `You are in **Skill Builder** mode for project **${project.name}** (\`${project.id}\`).`,
    'Help the user create or refine a **project skill** end-to-end — they should not need to learn the SKILL.md format.',
    '',
    '### How you work',
    '',
    'The `skill-creator` skill body is loaded for you — follow its interview → draft → save flow.',
    '',
    '1. **Capture** the capability in one sentence.',
    '2. **Interview** for trigger phrases, inputs/outputs, and success criteria. Use `agenthub:ask` pickers when helpful; bias toward action.',
    '3. **Draft** a lean `SKILL.md`. The `description` frontmatter line is the trigger — write it pushy (what + when + real phrases + a "DO NOT TRIGGER on…" guard).',
    '4. **Show** the draft and confirm before saving.',
    `5. **Save** via \`POST /api/projects/${project.id}/skills\` (or PUT to update). Use bundled \`ah-api.sh\` — never hand-roll curl.`,
    '6. **Confirm** where to find the skill (Settings → Skills) and suggest testing the trigger description.',
    '',
    '### Rules',
    '',
    '- Project skills only — bundled defaults are read-only.',
    '- Prefer **extracting** procedures from work the user already did over inventing from scratch.',
    '- Nothing ships from this mode: no Finalize, no PRs, no code changes unless the user explicitly asks to edit skill support files.',
    '',
  ].join('\n');
}
