/**
 * "Make routine" flow for a browser demo recording (web + mobile): the agent
 * drafts a project skill from the recording, and the human edits and saves it.
 */

export interface RoutineDraftWire {
  projectId: string;
  agentId: string;
  agentName: string;
  artifactId: string;
  steps: number;
  draft: { name: string; description: string; body: string };
}

/** Client wait for the draft: one model call, capped at 3 minutes server-side. */
export const ROUTINE_DRAFT_TIMEOUT_MS = 240_000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Problems that would make the skill save fail, in display order. */
export function routineSkillProblems(input: { name: string; description: string; body: string }) {
  const problems: string[] = [];
  const name = input.name.trim();
  if (!name) problems.push('Name is required');
  else if (name.length > 64 || !SLUG_RE.test(name)) {
    problems.push('Name must be lowercase letters, digits and hyphens');
  }
  if (!input.description.trim()) problems.push('Description is required');
  if (!input.body.trim()) problems.push('Steps are required');
  return problems;
}

/** Body for `POST /api/projects/:projectId/skills`. */
export function routineSkillCreateBody(input: { name: string; description: string; body: string }) {
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    category: 'general',
    body: input.body,
  };
}
