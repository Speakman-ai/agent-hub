/**
 * "Make routine" flow for a browser demo recording (web + mobile): the agent
 * drafts a project skill from the recording, the human edits and saves it,
 * then optionally attaches it to a cron that runs it as a routine.
 */

export interface RoutineDraftWire {
  projectId: string;
  agentId: string;
  agentName: string;
  artifactId: string;
  steps: number;
  draft: { name: string; description: string; body: string };
}

export interface RoutineSchedulePreset {
  id: string;
  label: string;
  cron: string;
}

export const ROUTINE_SCHEDULE_PRESETS: readonly RoutineSchedulePreset[] = [
  { id: 'weekdays-9', label: 'Weekdays at 9:00', cron: '0 9 * * 1-5' },
  { id: 'daily-9', label: 'Every day at 9:00', cron: '0 9 * * *' },
  { id: 'monday-9', label: 'Mondays at 9:00', cron: '0 9 * * 1' },
  { id: 'hourly', label: 'Every hour', cron: '0 * * * *' },
];

export const ROUTINE_DEFAULT_SCHEDULE = ROUTINE_SCHEDULE_PRESETS[0]!.cron;

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

/** Five whitespace-separated fields; the server does the full validation. */
export function looksLikeCronExpression(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5;
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

/** Body for `POST /api/crons` that makes the saved skill a scheduled routine. */
export function routineCronCreateBody(input: {
  projectId: string;
  agentId: string;
  skillName: string;
  schedule: string;
  timezone?: string | null;
  notes?: string;
}) {
  const notes = (input.notes ?? '').trim();
  return {
    name: `Routine: ${input.skillName}`,
    schedule: input.schedule.trim(),
    timezone: input.timezone || null,
    prompt: notes || `Run the ${input.skillName} routine.`,
    project_id: input.projectId,
    skill_principal_agent_id: input.agentId,
    routine_skill: input.skillName,
    enabled: true,
  };
}

/** The viewer's IANA timezone, or null when the runtime does not expose one. */
export function localTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
