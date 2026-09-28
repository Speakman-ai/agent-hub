/**
 * Session-mode Autopilot — shared config, validation, and wire helpers.
 *
 * Autopilot is a shipping-compatible session mode: one worktree, one
 * user-named branch, repeated Finalize push, preview verify, until the
 * goal is met or the wall clock runs out. Merge to the default branch is
 * always a human action.
 */

import {
  type AutopilotMainlineConfig,
  type MainlineSlot,
  parseAutopilotMainlineConfig,
} from './autopilotMainlineSlot.js';

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

/**
 * Where a cycle ships: `branch` pushes the named branch and a human merges;
 * `mainline` lands on the default branch and deploys `mainline.deployEnvironment`.
 */
export const AUTOPILOT_TARGETS = ['branch', 'mainline'] as const;
export type AutopilotTarget = (typeof AUTOPILOT_TARGETS)[number];

/**
 * Whether servers offer the `mainline` target by default. An operator can
 * still turn it off per server (`AGENT_HUB_AUTOPILOT_MAINLINE=0`); clients
 * read the answer from the session's `can_autopilot_mainline`.
 */
export const AUTOPILOT_MAINLINE_AVAILABLE = true;

export const AUTOPILOT_MAINLINE_UNAVAILABLE_MESSAGE =
  'Default branch + deploy is turned off on this server. Use an isolated branch.';

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
  target: AutopilotTarget;
  /** Set exactly when `target` is `mainline`. */
  mainline: AutopilotMainlineConfig | null;
}

export interface AutopilotSetupInput {
  durationHours: number;
  brief: string;
  goal: string;
  escalation: AutopilotEscalation;
  target: AutopilotTarget;
  /** Feature branch for `branch`; empty for `mainline` (the server fills in the default branch). */
  branch: string;
  /** deploy.yaml environment for `mainline`; null for `branch`. */
  deployEnvironment: string | null;
}

/** Raw setup fields as a form or request body carries them. */
export interface AutopilotSetupRequest {
  durationHours?: unknown;
  brief?: unknown;
  goal?: unknown;
  escalation?: unknown;
  target?: unknown;
  branch?: unknown;
  deployEnvironment?: unknown;
}

export const AUTOPILOT_DEPLOY_ENVIRONMENT_MAX = 64;

export type AutopilotSetupError = { field: string; message: string };

export function isAutopilotEscalation(value: unknown): value is AutopilotEscalation {
  return (
    typeof value === 'string' && (AUTOPILOT_ESCALATION_LEVELS as readonly string[]).includes(value)
  );
}

export function isAutopilotTarget(value: unknown): value is AutopilotTarget {
  return typeof value === 'string' && (AUTOPILOT_TARGETS as readonly string[]).includes(value);
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
  input: AutopilotSetupRequest | null | undefined,
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

  // Absent target means the isolated-branch mode every older client sends.
  const rawTarget = input?.target ?? 'branch';
  const target: AutopilotTarget = isAutopilotTarget(rawTarget) ? rawTarget : 'branch';
  if (!isAutopilotTarget(rawTarget)) {
    errors.push({
      field: 'target',
      message: 'Pick where Autopilot ships: an isolated branch or the default branch + deploy.',
    });
  }

  let branch = '';
  let deployEnvironment: string | null = null;
  if (target === 'mainline') {
    deployEnvironment = asTrimmedString(input?.deployEnvironment);
    if (!deployEnvironment) {
      errors.push({
        field: 'deployEnvironment',
        message: 'Name the deploy.yaml environment Autopilot should deploy and verify.',
      });
    } else if (deployEnvironment.length > AUTOPILOT_DEPLOY_ENVIRONMENT_MAX) {
      errors.push({ field: 'deployEnvironment', message: 'Environment name is too long.' });
    }
  } else {
    branch = normalizeAutopilotBranch(asTrimmedString(input?.branch));
    if (!branch) {
      errors.push({ field: 'branch', message: 'Name the branch Autopilot should push to.' });
    } else if (branch.length > 255) {
      errors.push({ field: 'branch', message: 'Branch name is too long.' });
    } else if (!AUTOPILOT_BRANCH_RE.test(branch)) {
      errors.push({
        field: 'branch',
        message:
          'Branch name must be a valid git ref (letters, numbers, ., _, /, no leading dash).',
      });
    } else if (isReservedAutopilotBranch(branch, options.defaultBranch)) {
      errors.push({
        field: 'branch',
        message: `Autopilot cannot push to '${branch}'. Pick a feature branch; merge to the default branch stays a human action.`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      durationHours: durationHours as number,
      brief,
      goal,
      escalation: escalation as AutopilotEscalation,
      target,
      branch,
      deployEnvironment: target === 'mainline' ? deployEnvironment : null,
    },
  };
}

/** POST /api/sessions/:id/autopilot body for a validated setup (attachments added by the caller). */
export function autopilotStartRequestBody(value: AutopilotSetupInput): {
  durationHours: number;
  brief: string;
  goal: string;
  escalation: AutopilotEscalation;
  target: AutopilotTarget;
  branch?: string;
  deployEnvironment?: string;
} {
  const base = {
    durationHours: value.durationHours,
    brief: value.brief,
    goal: value.goal,
    escalation: value.escalation,
    target: value.target,
  };
  return value.target === 'mainline'
    ? { ...base, deployEnvironment: value.deployEnvironment ?? '' }
    : { ...base, branch: value.branch };
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
  // Rows written before targets existed carry no `target`: they are branch-target.
  const target: AutopilotTarget = row.target === 'mainline' ? 'mainline' : 'branch';
  let mainline: AutopilotMainlineConfig | null = null;
  if (target === 'mainline') {
    mainline = parseAutopilotMainlineConfig(row.mainline);
    // A mainline row that cannot name its environment is unusable; refuse it
    // rather than quietly downgrading it to branch pushes.
    if (!mainline) return null;
  }
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
    target,
    mainline,
  };
}

/** Canonical stored form; `parseAutopilotSessionConfig` round-trips it. */
export function serializeAutopilotSessionConfig(cfg: AutopilotSessionConfig): string {
  const { mainline, ...rest } = cfg;
  return JSON.stringify(
    cfg.target === 'mainline' && mainline ? { ...rest, mainline } : { ...rest, target: 'branch' },
  );
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

export function formatAutopilotPrCommittedLabel(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return n === 1 ? '1 PR committed' : `${n} PRs committed`;
}

/** Toolbar label for a mainline session: confirmed landings on the default branch. */
export function formatAutopilotMainlinePushLabel(count: number, branch: string | null): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const target = branch && branch.trim() ? branch.trim() : 'the default branch';
  return `${n} ${n === 1 ? 'push' : 'pushes'} to ${target}`;
}

/**
 * The Autopilot toolbar counter. Branch sessions count Finalize pushes (each
 * opens or updates a PR); mainline sessions count commits confirmed on the
 * default branch.
 */
export function autopilotShipCounter(
  session: { autopilot?: unknown; finalize_pushed_count?: unknown } | null | undefined,
  pushedCount: number,
): { mainline: boolean; count: number; label: string } {
  const cfg = autopilotConfigFromSession(session);
  if (cfg?.target === 'mainline' && cfg.mainline) {
    const count = cfg.mainline.landedCount;
    return {
      mainline: true,
      count,
      label: formatAutopilotMainlinePushLabel(count, cfg.branch),
    };
  }
  return {
    mainline: false,
    count: pushedCount,
    label: formatAutopilotPrCommittedLabel(pushedCount),
  };
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

/**
 * One line describing when Autopilot should pause and ask the user, distinct
 * per escalation sensitivity. The startup form promises four behaviors; collapse
 * them into a single "ask only when blocked" line and the High/Medium settings
 * silently stop working. Keep the wording aligned with the picker copy.
 */
export function autopilotEscalationInstruction(escalation: AutopilotEscalation): string {
  switch (escalation) {
    case 'high':
      return 'Escalation is high: pause and ask the user before any non-trivial change (new dependency, schema/API change, deletions, anything you are unsure about). Make only small, obviously-safe edits without asking.';
    case 'medium':
      return 'Escalation is medium: pause and ask the user before a risky change (destructive, hard to reverse, or security-sensitive) or when the right approach is genuinely ambiguous. Otherwise keep working.';
    case 'low':
      return 'Escalation is low: keep working on your own and pause to ask only when you are blocked or about to take a risky change.';
    case 'none':
    default:
      return 'Escalation is none: do not stop to ask the user unless the goal is met or time is up.';
  }
}

/**
 * Transcript notice posted when Autopilot stops. Rendered as a plain system
 * message (never a model turn) so a stopped/expired session does not launch
 * another autonomous cycle just to announce that it stopped.
 */
export function autopilotStopNoticeContent(
  status: AutopilotStatus,
  branch: string,
  target: AutopilotTarget = 'branch',
  mainline?: Pick<AutopilotMainlineConfig, 'deployEnvironment' | 'slot'> | null,
): string {
  const reason =
    status === 'expired'
      ? 'the time limit was reached'
      : status === 'completed'
        ? 'the goal was met'
        : `status is ${status}`;
  if (target === 'mainline') {
    return (
      `Autopilot stopped: ${reason}. No further agent turns or pushes to \`${branch}\` will run for this session. ` +
      mainlineInFlightSentence(branch, mainline)
    );
  }
  return (
    `Autopilot stopped: ${reason}. Branch \`${branch}\` is ready for a human to review and merge. ` +
    'No further automatic work or pushes will run for this session.'
  );
}

function shortCommit(sha: string | null): string {
  return (sha ?? '').slice(0, 7) || 'the last commit';
}

/** What the stop notice says about a landing that is still owed. */
function mainlineInFlightSentence(
  branch: string,
  mainline: Pick<AutopilotMainlineConfig, 'deployEnvironment' | 'slot'> | null | undefined,
): string {
  const slot = mainline?.slot;
  if (!mainline || !slot || slot.phase === 'idle') return 'No deploy is in flight.';
  const sha = `\`${shortCommit(slot.sha)}\``;
  const env = `\`${mainline.deployEnvironment}\``;
  const where =
    slot.phase === 'pushing' || slot.phase === 'uncertain'
      ? `is still landing on \`${branch}\` and then deploys to ${env}`
      : slot.phase === 'reporting'
        ? `already deployed to ${env}`
        : `is still deploying to ${env}`;
  return `${sha} ${where}; it finishes and its result posts here as a notice, with no agent turn.`;
}

/** Why a mainline deploy result posted as a notice instead of an agent turn. */
export type AutopilotMainlineNoticeReason =
  | 'stopped'
  | 'expired'
  | 'mode_switched'
  | 'archived'
  | 'dispatch_failed'
  | 'dispatch_stalled';

function mainlineNoticeReasonText(reason: AutopilotMainlineNoticeReason, status: string): string {
  switch (reason) {
    case 'stopped':
      return `Autopilot is not running (status is ${status})`;
    case 'expired':
      return 'the Autopilot time limit was reached';
    case 'mode_switched':
      return 'the session left Autopilot mode';
    case 'archived':
      return 'the session is archived';
    case 'dispatch_failed':
      return 'the verify turn could not be started after several tries';
    case 'dispatch_stalled':
      return 'the verify turn did not start in time';
  }
}

function mainlineResultHeadline(
  slot: MainlineSlot,
  environment: string,
  branch: string,
): { headline: string; ok: boolean } {
  const sha = `\`${shortCommit(slot.sha)}\``;
  const env = `\`${environment}\``;
  const detail = slot.outcome?.detail ? ` (${slot.outcome.detail})` : '';
  switch (slot.outcome?.status) {
    case 'succeeded':
      return { headline: `The deploy of ${sha} to ${env} succeeded.`, ok: true };
    case 'failed':
      return { headline: `The deploy of ${sha} to ${env} failed${detail}.`, ok: false };
    case 'cancelled':
      return { headline: `The deploy of ${sha} to ${env} was cancelled${detail}.`, ok: false };
    case 'missing':
      return {
        headline: `The deployment of ${sha} to ${env} disappeared before it finished${detail}.`,
        ok: false,
      };
    case 'undeployable':
    default:
      return {
        headline: `${sha} is on \`${branch}\` but could not be deployed to ${env}${detail}.`,
        ok: false,
      };
  }
}

function mainlineTargetLines(slot: MainlineSlot): string[] {
  const origin = slot.outcome?.origin ?? null;
  const readiness = slot.outcome?.readiness ?? null;
  return [
    `Live origin: ${origin ?? 'not declared in deploy.yaml'}`,
    `Readiness: ${readiness ?? 'not declared in deploy.yaml'}`,
  ];
}

/** Line that carries the report key. Delivery is proven by finding it. */
export function autopilotMainlineReportKeyLine(reportKey: string): string {
  return `Report key: ${reportKey}`;
}

/**
 * The verify turn after a mainline deploy. Carries the report key so the Hub
 * can prove the turn was delivered (found in messages or the queue).
 */
export function buildAutopilotMainlineVerifyMessage(args: {
  cfg: AutopilotSessionConfig;
  slot: MainlineSlot;
  environment: string;
  reportKey: string;
}): string {
  const { cfg, slot, environment, reportKey } = args;
  const { headline, ok } = mainlineResultHeadline(slot, environment, cfg.branch);
  const lines = [`Autopilot deploy result: ${headline}`, ...mainlineTargetLines(slot), ''];
  if (ok) {
    lines.push(
      `Verify on the live \`${environment}\` environment at the origin above (browser tool), not the session preview. Check readiness first.`,
      '',
      'Check:',
      '1. The last change works live.',
      `2. Goal: ${cfg.goal}`,
      '3. No obvious regression against that goal.',
      '',
      'If verify finds a bug, fix it forward: commit the fix in this worktree and leave it for Finalize to land. If the goal holds, say so clearly and stop. Otherwise pick the next improvement from the brief.',
    );
  } else {
    lines.push(
      `The commit is already on \`${cfg.branch}\`, so fix forward: read the deployment logs on the Deployments page, commit a fix in this worktree, and leave it for Finalize to land and deploy.`,
      `Goal: ${cfg.goal}`,
    );
  }
  lines.push(
    'Do not revert by pushing, roll back the deploy, switch branches, merge, or open a PR yourself.',
    autopilotEscalationInstruction(cfg.escalation),
    '',
    autopilotMainlineReportKeyLine(reportKey),
  );
  return lines.join('\n');
}

/** Transcript notice for a deploy result that must not start an agent turn. */
export function buildAutopilotMainlineResultNotice(args: {
  cfg: AutopilotSessionConfig;
  slot: MainlineSlot;
  environment: string;
  reportKey: string;
  reason: AutopilotMainlineNoticeReason;
}): string {
  const { cfg, slot, environment, reportKey, reason } = args;
  const { headline } = mainlineResultHeadline(slot, environment, cfg.branch);
  return [
    `Autopilot deploy result: ${headline}`,
    ...mainlineTargetLines(slot),
    `No agent turn was started: ${mainlineNoticeReasonText(reason, cfg.status)}.`,
    autopilotMainlineReportKeyLine(reportKey),
  ].join('\n');
}

function autopilotDurationLabel(cfg: AutopilotSessionConfig): string {
  return cfg.durationHours === 0
    ? 'no time limit'
    : `${cfg.durationHours} hour${cfg.durationHours === 1 ? '' : 's'}`;
}

export function buildAutopilotKickoffMessage(cfg: AutopilotSessionConfig): string {
  const duration = autopilotDurationLabel(cfg);
  if (cfg.target === 'mainline' && cfg.mainline) {
    const env = cfg.mainline.deployEnvironment;
    return [
      'Start Autopilot on this session.',
      '',
      `Ships to: the default branch \`${cfg.branch}\`, then deploys environment \`${env}\``,
      `Duration: ${duration}`,
      `Escalation: ${cfg.escalation}`,
      '',
      'What to do:',
      cfg.brief,
      '',
      'Goal to check for:',
      cfg.goal,
      '',
      `Loop: pick the next improvement against that brief and implement it in this session's worktree. Leave committable changes so Finalize can validate them and push them to \`${cfg.branch}\`. Every validated change goes live: the Hub deploys \`${env}\` and then asks you to verify on that live environment. If verify finds a bug, fix it. If the goal is unmet, pick the next improvement. Stop when the goal holds or time runs out.`,
      'Do not switch branches, push, merge, or open a PR yourself. Finalize lands each change.',
    ].join('\n');
  }
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
  lines.push(autopilotEscalationInstruction(cfg.escalation));
  return lines.join('\n');
}

/**
 * Human-initiated recovery after a hung Autopilot turn (dropped network,
 * zombie CLI, stuck Finalize). Tells the agent to pick up from the worktree,
 * not to restart the brief from scratch.
 */
export function buildAutopilotUnstickContinueMessage(cfg: AutopilotSessionConfig): string {
  if (cfg.target === 'mainline' && cfg.mainline) {
    return [
      'Autopilot was unstuck by the user after a stalled turn (network drop, hung process, or stuck CI).',
      '',
      'The in-flight agent process, queued messages, and any running Finalize/CI for this session were stopped.',
      'Continue from the current worktree. Do not restart the Autopilot brief from scratch.',
      '',
      `Ships to: \`${cfg.branch}\`, deployed to \`${cfg.mainline.deployEnvironment}\``,
      `Goal: ${cfg.goal}`,
      '',
      'Check git status and the latest transcript, then pick up the next incomplete step (implement, leave committable changes so Finalize can land them, or verify on the live environment after a deploy).',
      'Do not switch branches, push, or merge yourself. Finalize lands each change.',
    ].join('\n');
  }
  return [
    'Autopilot was unstuck by the user after a stalled turn (network drop, hung process, or stuck CI).',
    '',
    'The in-flight agent process, queued messages, and any running Finalize/CI for this session were stopped.',
    'Continue from the current worktree — do not restart the Autopilot brief from scratch.',
    '',
    `Branch: \`${cfg.branch}\` (push here only — never merge to the default branch)`,
    `Goal: ${cfg.goal}`,
    '',
    'Check git status and the latest transcript, then pick up the next incomplete step (implement, leave committable changes so Finalize can push, or verify the session preview).',
    'Never switch branches. Never merge to main/master.',
  ].join('\n');
}
