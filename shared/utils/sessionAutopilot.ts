/**
 * Session-mode Autopilot — shared config, validation, and wire helpers.
 *
 * Autopilot is a shipping-compatible session mode: one worktree, one
 * user-named branch, repeated Finalize push, preview verify, until the
 * goal is met or the wall clock runs out. Merge to the default branch is
 * always a human action.
 */

export const AUTOPILOT_ESCALATION_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type AutopilotEscalation = (typeof AUTOPILOT_ESCALATION_LEVELS)[number];

export const AUTOPILOT_STATUSES = [
  'configuring',
  'running',
  'paused',
  'completed',
  'expired',
  'escalated',
] as const;
export type AutopilotStatus = (typeof AUTOPILOT_STATUSES)[number];

/** Matches the session Branch picker: no leading dash, no `..`, safe git chars. */
export const AUTOPILOT_BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export const AUTOPILOT_RESERVED_BRANCHES = new Set([
  'main',
  'master',
  'head',
  'develop',
  'development',
  'production',
  'prod',
  'staging',
  'release',
]);

export const AUTOPILOT_MAX_DURATION_HOURS = 72;

export interface AutopilotSessionConfig {
  durationHours: number;
  brief: string;
  goal: string;
  escalation: AutopilotEscalation;
  branch: string;
  startedAt: string | null;
  deadlineAt: string | null;
  status: AutopilotStatus;
  cycle: number;
  lastPushSha: string | null;
}

export interface AutopilotSetupInput {
  durationHours: number;
  brief: string;
  goal: string;
  escalation: AutopilotEscalation;
  branch: string;
}

export type AutopilotSetupError = { field: string; message: string };

export function isAutopilotEscalation(value: unknown): value is AutopilotEscalation {
  return (
    typeof value === 'string' && (AUTOPILOT_ESCALATION_LEVELS as readonly string[]).includes(value)
  );
}

export function isAutopilotStatus(value: unknown): value is AutopilotStatus {
  return typeof value === 'string' && (AUTOPILOT_STATUSES as readonly string[]).includes(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function normalizeAutopilotBranch(raw: string): string {
  return raw
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/\/+$/, '');
}

export function isReservedAutopilotBranch(branch: string, defaultBranch?: string | null): boolean {
  const name = normalizeAutopilotBranch(branch);
  if (!name) return true;
  if (AUTOPILOT_RESERVED_BRANCHES.has(name.toLowerCase())) return true;
  if (defaultBranch && name.toLowerCase() === defaultBranch.trim().toLowerCase()) return true;
  return false;
}

export function validateAutopilotSetupInput(
  input: Partial<AutopilotSetupInput> | null | undefined,
  options: { defaultBranch?: string | null } = {},
): { ok: true; value: AutopilotSetupInput } | { ok: false; errors: AutopilotSetupError[] } {
  const errors: AutopilotSetupError[] = [];
  const durationHours = asFiniteNumber(input?.durationHours);
  if (durationHours == null) {
    errors.push({
      field: 'durationHours',
      message: 'Duration is required (0 = no limit, or 1–72 hours).',
    });
  } else if (
    !Number.isInteger(durationHours) ||
    durationHours < 0 ||
    durationHours > AUTOPILOT_MAX_DURATION_HOURS
  ) {
    errors.push({
      field: 'durationHours',
      message: `Duration must be 0 (no limit) or an integer from 1 to ${AUTOPILOT_MAX_DURATION_HOURS} hours.`,
    });
  }

  const brief = asTrimmedString(input?.brief);
  if (!brief) errors.push({ field: 'brief', message: 'Say what you want Autopilot to do.' });
  else if (brief.length > 8000)
    errors.push({ field: 'brief', message: 'Brief is too long (max 8000 characters).' });

  const goal = asTrimmedString(input?.goal);
  if (!goal) errors.push({ field: 'goal', message: 'Give a goal Autopilot can check for.' });
  else if (goal.length > 4000)
    errors.push({ field: 'goal', message: 'Goal is too long (max 4000 characters).' });

  const escalation = input?.escalation;
  if (!isAutopilotEscalation(escalation)) {
    errors.push({
      field: 'escalation',
      message: 'Pick an escalation sensitivity: none, low, medium, or high.',
    });
  }

  const branch = normalizeAutopilotBranch(asTrimmedString(input?.branch));
  if (!branch) {
    errors.push({ field: 'branch', message: 'Name the branch Autopilot should push to.' });
  } else if (branch.length > 255) {
    errors.push({ field: 'branch', message: 'Branch name is too long.' });
  } else if (!AUTOPILOT_BRANCH_RE.test(branch)) {
    errors.push({
      field: 'branch',
      message: 'Branch name must be a valid git ref (letters, numbers, ., _, /, no leading dash).',
    });
  } else if (isReservedAutopilotBranch(branch, options.defaultBranch)) {
    errors.push({
      field: 'branch',
      message: `Autopilot cannot push to '${branch}'. Pick a feature branch; merge to the default branch stays a human action.`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      durationHours: durationHours as number,
      brief,
      goal,
      escalation: escalation as AutopilotEscalation,
      branch,
    },
  };
}

export function deadlineAtFromDuration(startedAtIso: string, durationHours: number): string | null {
  if (durationHours === 0) return null;
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return null;
  return new Date(started + durationHours * 60 * 60 * 1000).toISOString();
}

export function parseAutopilotSessionConfig(raw: unknown): AutopilotSessionConfig | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const durationHours = asFiniteNumber(row.durationHours);
  const brief = asTrimmedString(row.brief);
  const goal = asTrimmedString(row.goal);
  const branch = normalizeAutopilotBranch(asTrimmedString(row.branch));
  if (durationHours == null || !brief || !goal || !branch) return null;
  if (!isAutopilotEscalation(row.escalation)) return null;
  const status = isAutopilotStatus(row.status) ? row.status : 'configuring';
  const cycle = asFiniteNumber(row.cycle);
  return {
    durationHours,
    brief,
    goal,
    escalation: row.escalation,
    branch,
    startedAt: typeof row.startedAt === 'string' && row.startedAt ? row.startedAt : null,
    deadlineAt: typeof row.deadlineAt === 'string' && row.deadlineAt ? row.deadlineAt : null,
    status,
    cycle: cycle != null && cycle >= 0 ? Math.floor(cycle) : 0,
    lastPushSha: typeof row.lastPushSha === 'string' && row.lastPushSha ? row.lastPushSha : null,
  };
}

export function autopilotConfigFromSession(
  session: { autopilot?: unknown; autopilot_session_config?: unknown } | null | undefined,
): AutopilotSessionConfig | null {
  if (!session) return null;
  return (
    parseAutopilotSessionConfig(session.autopilot) ??
    parseAutopilotSessionConfig(session.autopilot_session_config)
  );
}

export function needsAutopilotSetup(
  session:
    | { session_mode?: string | null; autopilot?: unknown; autopilot_session_config?: unknown }
    | null
    | undefined,
): boolean {
  if (session?.session_mode !== 'autopilot') return false;
  const cfg = autopilotConfigFromSession(session);
  if (!cfg) return true;
  return !cfg.startedAt || cfg.status === 'configuring';
}

export function isAutopilotRunning(cfg: AutopilotSessionConfig | null | undefined): boolean {
  return !!cfg && cfg.status === 'running' && !!cfg.startedAt;
}

export function autopilotDeadlineReached(
  cfg: AutopilotSessionConfig | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!cfg?.deadlineAt) return false;
  const deadline = Date.parse(cfg.deadlineAt);
  return Number.isFinite(deadline) && nowMs >= deadline;
}

export function buildAutopilotKickoffMessage(cfg: AutopilotSessionConfig): string {
  const duration =
    cfg.durationHours === 0
      ? 'no time limit'
      : `${cfg.durationHours} hour${cfg.durationHours === 1 ? '' : 's'}`;
  return [
    'Start Autopilot on this session.',
    '',
    `Branch: \`${cfg.branch}\` (push here only — never merge to the default branch)`,
    `Duration: ${duration}`,
    `Escalation: ${cfg.escalation}`,
    '',
    'What to do:',
    cfg.brief,
    '',
    'Goal to check for:',
    cfg.goal,
    '',
    'Loop: pick the next improvement against that brief, implement it on this branch, leave committable changes so Finalize can push, then verify the session preview. If verify finds a bug, fix it. If the goal is unmet, pick the next improvement. Stop when the goal holds or time runs out.',
  ].join('\n');
}

export function buildAutopilotVerifyContinueMessage(args: {
  cfg: AutopilotSessionConfig;
  sha: string;
  branch: string;
  prUrl?: string | null;
  previewNote?: string | null;
}): string {
  const { cfg, sha, branch, prUrl, previewNote } = args;
  const lines = [
    `Autopilot push landed on \`${branch}\` at \`${sha.slice(0, 12)}\`.`,
    prUrl ? `PR (do not merge): ${prUrl}` : 'A PR should be open for this branch. Do not merge it.',
    previewNote ||
      'Use this session’s preview pane (preview tool: start if needed, then screenshot / read the page) to verify.',
    '',
    'Check:',
    `1. The last change works.`,
    `2. Goal: ${cfg.goal}`,
    '3. No obvious regression against that goal.',
    '',
    'If verification fails, fix it on this same branch. If it passes and the goal is unmet, pick the next improvement from the brief and implement it. Leave changes ready so Finalize can push again.',
    'Never switch branches. Never merge to main/master.',
  ];
  if (cfg.escalation === 'none') {
    lines.push('Escalation is none: do not stop to ask unless the goal is met or time is up.');
  } else {
    lines.push(
      `Escalation is ${cfg.escalation}: pause and ask the user only if you are blocked or about to take a risky change.`,
    );
  }
  return lines.join('\n');
}
