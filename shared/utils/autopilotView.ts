/**
 * Pure view-model derivation for the Experimental Project Autopilot UI.
 *
 * Both the web client (`AutopilotSettingsSection`) and the mobile client
 * (`ExperimentalAutopilotScreen`) read the same `GET
 * /api/projects/:projectId/autopilot` payload and render the same setup
 * readiness checklist, run summary, and lifecycle-control availability. This
 * module owns that derivation so the logic is written and tested once, and the
 * two UIs stay in lock-step.
 *
 * Nothing here talks to the network or the DOM — it maps a wire snapshot to a
 * plain view-model. The server re-enforces every authority check; the derived
 * `controls` object is only a UX hint for which buttons to show.
 */

export type AutopilotStage =
  | 'planning'
  | 'implementing'
  | 'finalizing'
  | 'deploying'
  | 'verifying'
  | 'documenting'
  | 'selecting-next';

export type AutopilotControlState =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'failed';

/** Control states in which a run is still occupying the project's single slot. */
export const AUTOPILOT_ACTIVE_STATES: readonly AutopilotControlState[] = [
  'running',
  'pausing',
  'paused',
  'stopping',
];

export interface AutopilotLimitsWire {
  cycleMode: 'continuous' | 'finite';
  maxCycles: number | null;
  maxWallTimeMs: number;
  maxStageTimeoutMs: number;
  maxRetriesPerStage: number;
  maxCostUsd: number | null;
}

export interface AutopilotTargetWire {
  targetId: string;
  readinessProbeUrl: string | null;
  origin: string | null;
}

export interface AutopilotUsageWire {
  wallTimeMs: number;
  costUsd: number | null;
  costAvailable: boolean;
}

export interface AutopilotConfigWire {
  projectId: string;
  enabled: boolean;
  disabling: boolean;
  briefId: string | null;
  brief: string | null;
  briefRevision: number | null;
  target: AutopilotTargetWire | null;
  limits: AutopilotLimitsWire | null;
  credentialOwnerUserId: string | null;
  updatedAt: string;
  updatedBy: string | null;
  /** Optimistic-concurrency revision; sent back as `expectedRevision` on save. */
  revision: number;
  /**
   * Operator-selected isolation adapter for workers. `auto` keeps the managed
   * isolation requirement; `host` + `hostAdapterAck` runs without a boundary.
   */
  isolationAdapter: AutopilotIsolationAdapter;
  /** Acknowledgment that Autopilot may run on the host adapter (no isolation). */
  hostAdapterAck: boolean;
}

export const AUTOPILOT_ISOLATION_ADAPTERS = [
  'auto',
  'host',
  'sysbox',
  'container',
  'firecracker',
] as const;

export type AutopilotIsolationAdapter = (typeof AUTOPILOT_ISOLATION_ADAPTERS)[number];

export interface AutopilotRunWire {
  id: string;
  projectId: string;
  controlState: AutopilotControlState;
  stage: AutopilotStage | null;
  cycleNumber: number;
  pauseReason: string | null;
  failureReason: string | null;
  lastVerifiedSha: string | null;
  lastDeploymentId: string | null;
  targetId: string | null;
  limits: AutopilotLimitsWire;
  usage: AutopilotUsageWire;
  startedBy: string | null;
  startedAt: string;
  stoppedAt: string | null;
  updatedAt: string;
}

export interface AutopilotCycleWire {
  cycleNumber: number;
  selectedImprovement: string | null;
  verification: unknown;
  documentation: unknown;
  outcome: string | null;
  status: string;
  testedCommitSha: string | null;
  deploymentId: string | null;
}

export interface AutopilotEventWire {
  id: string;
  type: string;
  payload?: unknown;
  createdAt: string;
  seq: number;
  operationId?: string | null;
}

export interface AutopilotOperationWire {
  id: string;
  kind: string;
  status: string;
  sessionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotRunSnapshotWire {
  run: AutopilotRunWire;
  cycle: AutopilotCycleWire | null;
  events?: AutopilotEventWire[];
  operations?: AutopilotOperationWire[];
  /** Server-authored monotonic version; used to order overlapping responses. */
  stateVersion?: number;
}

export interface AutopilotProjectStateWire {
  config: AutopilotConfigWire;
  activeRun: AutopilotRunSnapshotWire | null;
  /** Server-authored monotonic version, present even with no active run. */
  stateVersion?: number;
}

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

const STAGE_LABELS: Record<AutopilotStage, string> = {
  planning: 'Planning',
  implementing: 'Implementing',
  finalizing: 'Finalizing',
  deploying: 'Deploying',
  verifying: 'Verifying',
  documenting: 'Documenting',
  'selecting-next': 'Selecting next improvement',
};

const CONTROL_STATE_LABELS: Record<AutopilotControlState, string> = {
  running: 'Running',
  pausing: 'Pausing',
  paused: 'Paused',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: 'Failed',
};

export function stageLabel(stage: AutopilotStage | null | undefined): string {
  if (!stage) return 'Idle';
  return STAGE_LABELS[stage] ?? stage;
}

export function controlStateLabel(state: AutopilotControlState | null | undefined): string {
  if (!state) return 'Idle';
  return CONTROL_STATE_LABELS[state] ?? state;
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

/** Human-readable wall time, e.g. `2h 05m`, `12m 30s`, `8s`. */
export function formatWallTime(ms: number | null | undefined): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * Usage line. Cost is shown when the provider reports it; when it does not,
 * we say so honestly rather than implying `$0.00` (see the LIMITS-STOP
 * decision: expose unavailable cost metrics honestly).
 */
export function formatUsage(usage: AutopilotUsageWire | null | undefined): string {
  const wall = formatWallTime(usage?.wallTimeMs ?? 0);
  if (!usage || !usage.costAvailable || usage.costUsd == null) {
    return `${wall} · cost unavailable`;
  }
  return `${wall} · $${usage.costUsd.toFixed(2)}`;
}

export function msToHours(ms: number | null | undefined): number {
  if (!ms || ms <= 0) return 0;
  return Math.round((ms / 3_600_000) * 100) / 100;
}

export function hoursToMs(hours: number | null | undefined): number {
  if (!hours || hours <= 0) return 0;
  return Math.round(hours * 3_600_000);
}

/**
 * Parse a cost-cap form field. `null` is reserved for an explicitly empty
 * field ("no cap"); a nonempty value must be a finite, positive number.
 * Invalid nonempty input is rejected (`ok: false`) rather than silently
 * coerced to `null`, which would replace an existing spending cap with no cap.
 */
export function parseAutopilotCostCap(
  raw: string | null | undefined,
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { ok: true, value: null };
  const n = Number(trimmed);
  if (Number.isFinite(n) && n > 0) return { ok: true, value: n };
  return { ok: false };
}

/** The numeric limit fields of the setup form, as raw string inputs. */
export interface AutopilotLimitFormInput {
  cycleMode: 'continuous' | 'finite';
  maxCycles: string;
  maxWallTimeHours: string;
  maxStageTimeoutMinutes: string;
  maxRetriesPerStage: string;
  maxCostUsd: string;
}

/**
 * Validate the setup form's numeric limits before a save. Invalid input on any
 * limit field is rejected (with a specific message) rather than silently
 * coerced to a default or to "no cap" — the same class of defect as the cost
 * cap: an invalid entry must never quietly change a safety-relevant limit.
 */
export function validateAutopilotLimitsForm(
  form: AutopilotLimitFormInput,
): { ok: true } | { ok: false; message: string } {
  if (!parseAutopilotCostCap(form.maxCostUsd).ok) {
    return { ok: false, message: 'Cost cap must be a positive number, or blank for no cap' };
  }
  const hours = Number(form.maxWallTimeHours);
  if (!(Number.isFinite(hours) && hours > 0)) {
    return { ok: false, message: 'Wall-time budget must be a positive number of hours' };
  }
  const minutes = Number(form.maxStageTimeoutMinutes);
  if (!(Number.isFinite(minutes) && minutes > 0)) {
    return { ok: false, message: 'Per-stage timeout must be a positive number of minutes' };
  }
  const retries = Number(form.maxRetriesPerStage);
  if (!(Number.isInteger(retries) && retries >= 0 && retries <= 2)) {
    return { ok: false, message: 'Retries per stage must be 0, 1, or 2' };
  }
  if (form.cycleMode === 'finite') {
    const cycles = Number(form.maxCycles);
    if (!(Number.isInteger(cycles) && cycles >= 1)) {
      return { ok: false, message: 'Max cycles must be a whole number of at least 1' };
    }
  }
  return { ok: true };
}

export function msToMinutes(ms: number | null | undefined): number {
  if (!ms || ms <= 0) return 0;
  return Math.round((ms / 60_000) * 100) / 100;
}

export function minutesToMs(minutes: number | null | undefined): number {
  if (!minutes || minutes <= 0) return 0;
  return Math.round(minutes * 60_000);
}

function hasBrief(config: AutopilotConfigWire): boolean {
  return Boolean(config.brief && config.brief.trim());
}

/**
 * Ordered setup readiness checklist. Mirrors the server's
 * `assertReadyToEnable` + local-target contract so the operator sees exactly
 * what is missing before enabling or starting, without having to trigger a
 * server error to find out.
 */
export function deriveReadiness(state: AutopilotProjectStateWire): ReadinessItem[] {
  const config = state.config;
  const target = config.target;
  return [
    {
      key: 'brief',
      label: 'Product brief',
      ok: hasBrief(config),
      detail: hasBrief(config)
        ? 'A product brief is set.'
        : 'Describe what the experiment should build and improve.',
    },
    {
      key: 'target',
      label: 'Local deploy target',
      ok: Boolean(target?.targetId),
      detail: target?.targetId
        ? `Target "${target.targetId}".`
        : 'Name the dedicated local deploy.yaml environment to deploy and verify against.',
    },
    {
      key: 'origin',
      label: 'Target loopback origin',
      ok: Boolean(target?.origin),
      detail: target?.origin
        ? target.origin
        : 'A loopback origin (scheme://host[:port]) for the dedicated target is required.',
    },
    {
      key: 'readiness',
      label: 'Readiness probe URL',
      ok: Boolean(target?.readinessProbeUrl),
      detail: target?.readinessProbeUrl
        ? target.readinessProbeUrl
        : 'A readiness probe on the same origin is required to confirm the deploy is live.',
    },
    {
      key: 'limits',
      label: 'Resource limits',
      ok: Boolean(config.limits),
      detail: config.limits
        ? 'Per-run wall-time and stage limits are set.'
        : 'Set the run budget: cycle mode, wall-time, per-stage timeout and retries.',
    },
    {
      key: 'owner',
      label: 'Credential owner',
      ok: Boolean(config.credentialOwnerUserId),
      detail: config.credentialOwnerUserId
        ? 'A credential owner is assigned to scope worker authority.'
        : 'Assign the user whose scoped credentials the unattended worker runs under.',
    },
  ];
}

export function isReady(state: AutopilotProjectStateWire): boolean {
  return deriveReadiness(state).every((item) => item.ok);
}

export interface AutopilotControls {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
  canDisable: boolean;
  /** True while a stop or pause is draining — controls should show a settling state. */
  stopping: boolean;
  /** True when a run currently holds the project's single active slot. */
  isActive: boolean;
}

export function isActiveRun(run: AutopilotRunWire | null | undefined): boolean {
  return Boolean(run && AUTOPILOT_ACTIVE_STATES.includes(run.controlState));
}

export function deriveControls(state: AutopilotProjectStateWire): AutopilotControls {
  const run = state.activeRun?.run ?? null;
  const cs = run?.controlState ?? null;
  const active = isActiveRun(run);
  const disabling = state.config.disabling;
  return {
    canStart: state.config.enabled && !disabling && !active && isReady(state),
    canPause: cs === 'running',
    canResume: cs === 'paused' && !disabling,
    canStop: active && cs !== 'stopping',
    canDisable: state.config.enabled && !disabling,
    stopping: cs === 'stopping' || cs === 'pausing' || disabling,
    isActive: active,
  };
}

/** A criterion-level pass/fail row with any bound artifact reference. */
export interface AutopilotCriterionView {
  criterionId: string;
  passed: boolean;
  kind: string | null;
  observed: string | null;
  /** Best available artifact reference (screenshot/trace path or artifact id). */
  artifactRef: string | null;
  claimedWithoutEvidence: boolean;
}

/** Verification evidence a run recorded, including failure evidence. */
export interface AutopilotEvidenceView {
  verdict: 'passed' | 'failed' | 'pending';
  /** Reject reason detail when the verdict failed. */
  failureDetail: string | null;
  failureReason: string | null;
  expectedSha: string | null;
  observedSha: string | null;
  origin: string | null;
  usedPreview: boolean;
  healthOk: boolean | null;
  criteria: AutopilotCriterionView[];
}

export interface AutopilotLinkView {
  label: string;
  value: string;
  /** Present when the value is a navigable URL. */
  href: string | null;
}

/** The structured cycle record the documenting stage persisted. */
export interface AutopilotDocumentationView {
  expectedBenefit: string | null;
  actualChange: string | null;
  outcome: string | null;
  nextAction: string | null;
  decisions: { key: string; decision: string }[];
  links: AutopilotLinkView[];
  evidenceRefs: { kind: string; ref: string }[];
  journalSlug: string | null;
  wikiSlugs: string[];
}

export type AutopilotActivityTone = 'info' | 'ok' | 'warn' | 'error';

export interface AutopilotActivityLine {
  id: string;
  seq: number;
  createdAt: string;
  tone: AutopilotActivityTone;
  text: string;
}

export interface AutopilotCurrentWork {
  kind: string;
  kindLabel: string;
  status: string;
  since: string;
  sessionId: string | null;
}

export interface AutopilotRunView {
  runId: string;
  controlState: AutopilotControlState;
  controlStateLabel: string;
  stage: AutopilotStage | null;
  stageLabel: string;
  cycleNumber: number;
  pauseReason: string | null;
  failureReason: string | null;
  lastVerifiedSha: string | null;
  lastVerifiedShaShort: string;
  deployedUrl: string | null;
  selectedImprovement: string | null;
  usageText: string;
  hasEvidence: boolean;
  hasDocumentation: boolean;
  evidence: AutopilotEvidenceView | null;
  /** "Last evaluation" when a failed scorecard is leftover from an earlier verify. */
  evidenceLabel: string;
  evidenceStale: boolean;
  documentation: AutopilotDocumentationView | null;
  stopping: boolean;
  active: boolean;
  currentWork: AutopilotCurrentWork | null;
  activity: AutopilotActivityLine[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isHttpUrl(value: string | null): boolean {
  return !!value && /^https?:\/\//i.test(value);
}

/**
 * Defensively project the server's `cycle.verification` blob
 * (`AutopilotCycleVerification`) into a flat, render-ready evidence view —
 * verdict, revision identity, per-criterion pass/fail with artifact refs, and
 * failure detail. Tolerant of partial/absent shapes.
 */
export function deriveEvidenceView(verification: unknown): AutopilotEvidenceView | null {
  const root = asRecord(verification);
  if (!root) return null;
  const judgement = asRecord(root.judgement);
  const report = asRecord(root.evidence);

  let verdict: AutopilotEvidenceView['verdict'] = 'pending';
  let failureDetail: string | null = null;
  let failureReason: string | null = null;
  if (judgement) {
    if (judgement.ok === true) verdict = 'passed';
    else if (judgement.ok === false) {
      verdict = 'failed';
      failureDetail = asString(judgement.detail);
      failureReason = asString(judgement.reason);
    }
  }

  const health = asRecord(report?.healthCheck);
  const criteriaRaw = Array.isArray(report?.criteria) ? (report!.criteria as unknown[]) : [];
  const criteria: AutopilotCriterionView[] = criteriaRaw.map((row) => {
    const c = asRecord(row) ?? {};
    return {
      criterionId: asString(c.criterionId) ?? '',
      passed: c.passed === true,
      kind: asString(c.kind),
      observed: asString(c.observed),
      artifactRef:
        asString(c.screenshotPath) ??
        asString(c.tracePath) ??
        asString(asRecord(c.apiCheck)?.url) ??
        null,
      claimedWithoutEvidence: c.claimedWithoutEvidence === true,
    };
  });

  return {
    verdict,
    failureDetail,
    failureReason,
    expectedSha: asString(report?.expectedSha),
    observedSha: asString(report?.observedSha),
    origin: asString(report?.origin),
    usedPreview: report?.usedPreview === true,
    healthOk: health ? health.ok === true : null,
    criteria,
  };
}

/**
 * Defensively project the server's `cycle.documentation` blob
 * (`AutopilotStructuredCycleRecord`) into render-ready summaries, links and
 * evidence references. Records failures too (outcome/nextAction).
 */
export function deriveDocumentationView(documentation: unknown): AutopilotDocumentationView | null {
  const root = asRecord(documentation);
  if (!root) return null;
  const linksRaw = asRecord(root.links) ?? {};
  const links: AutopilotLinkView[] = [];
  const push = (label: string, value: string | null) => {
    if (value) links.push({ label, value, href: isHttpUrl(value) ? value : null });
  };
  push('Deployment', asString(linksRaw.deploymentOrigin));
  push('Tested commit', asString(linksRaw.testedCommitSha));
  push('Card', asString(linksRaw.cardId));
  push('Session', asString(linksRaw.sessionId));
  push('Finalize run', asString(linksRaw.finalizeRunId));

  const decisionsRaw = Array.isArray(root.decisions) ? (root.decisions as unknown[]) : [];
  const decisions = decisionsRaw
    .map((d) => {
      const r = asRecord(d) ?? {};
      const key = asString(r.key);
      const decision = asString(r.decision);
      return key && decision ? { key, decision } : null;
    })
    .filter((d): d is { key: string; decision: string } => d != null);

  const evidenceRaw = Array.isArray(root.evidence) ? (root.evidence as unknown[]) : [];
  const evidenceRefs = evidenceRaw
    .map((e) => {
      const r = asRecord(e) ?? {};
      const kind = asString(r.kind) ?? 'artifact';
      const ref = asString(r.path) ?? asString(r.artifactId) ?? asString(r.key);
      return ref ? { kind, ref } : null;
    })
    .filter((e): e is { kind: string; ref: string } => e != null);

  const wikiSlugs = Array.isArray(root.wikiSlugs)
    ? (root.wikiSlugs as unknown[]).map((s) => asString(s)).filter((s): s is string => s != null)
    : [];

  return {
    expectedBenefit: asString(root.expectedBenefit),
    actualChange: asString(root.actualChange),
    outcome: asString(root.outcome),
    nextAction: asString(root.nextAction),
    decisions,
    links,
    evidenceRefs,
    journalSlug: asString(root.journalSlug),
    wikiSlugs,
  };
}

const OPERATION_KIND_LABELS: Record<string, string> = {
  'plan-baseline': 'plan baseline',
  implement: 'implement',
  finalize: 'finalize',
  deploy: 'deploy',
  evaluate: 'evaluate',
  'document-cycle': 'document',
  'select-next': 'select next',
};

export function formatOperationKind(kind: string | null | undefined): string {
  if (!kind) return 'work';
  return OPERATION_KIND_LABELS[kind] ?? kind.replace(/-/g, ' ');
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return asRecord(payload) ?? {};
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  return asString(payload[key]);
}

export function deriveCurrentWork(
  operations: AutopilotOperationWire[] | undefined,
): AutopilotCurrentWork | null {
  const inflight = (operations ?? []).filter((op) => op.status === 'in_flight');
  if (inflight.length === 0) return null;
  const latest = inflight.reduce((best, op) => (op.createdAt >= best.createdAt ? op : best));
  return {
    kind: latest.kind,
    kindLabel: formatOperationKind(latest.kind),
    status: latest.status,
    since: latest.createdAt,
    sessionId: latest.sessionId ?? null,
  };
}

export function deriveActivityLog(
  events: AutopilotEventWire[] | undefined,
  operations: AutopilotOperationWire[] | undefined,
): AutopilotActivityLine[] {
  const opsById = new Map((operations ?? []).map((op) => [op.id, op]));
  const lines = (events ?? []).map((event) => {
    const payload = payloadRecord(event.payload);
    const linked = event.operationId ? (opsById.get(event.operationId) ?? null) : null;
    const kind = payloadString(payload, 'kind') ?? linked?.kind ?? null;
    const kindLabel = formatOperationKind(kind);
    let text: string;
    let tone: AutopilotActivityTone = 'info';
    switch (event.type) {
      case 'run_started':
        text = 'Run started';
        tone = 'ok';
        break;
      case 'resumed':
        text = 'Resumed';
        tone = 'ok';
        break;
      case 'paused':
        text = payloadString(payload, 'reason')
          ? `Paused: ${payloadString(payload, 'reason')}`
          : 'Paused';
        tone = 'warn';
        break;
      case 'pause_drain':
        text = payloadString(payload, 'reason')
          ? `Cancelling in-flight work (${payloadString(payload, 'reason')})`
          : 'Cancelling in-flight work';
        tone = 'warn';
        break;
      case 'operation_started':
        text = `Started ${kindLabel}`;
        if (linked?.sessionId) text += ` · session ${linked.sessionId.slice(0, 8)}`;
        break;
      case 'operation_completed': {
        const outcome = payloadString(payload, 'outcome') ?? 'completed';
        text = `${kindLabel} ${outcome}`;
        if (outcome === 'failed' || outcome === 'ambiguous') tone = 'error';
        else if (outcome === 'succeeded') tone = 'ok';
        else if (outcome === 'cancelled') tone = 'warn';
        break;
      }
      case 'stage_advanced': {
        const from = payloadString(payload, 'from');
        const to = payloadString(payload, 'to');
        text =
          from && to
            ? `${stageLabel(from as AutopilotStage)} → ${stageLabel(to as AutopilotStage)}`
            : `Advanced to ${stageLabel((to as AutopilotStage) ?? null)}`;
        break;
      }
      case 'restart_reconcile':
        text = payloadString(payload, 'action')
          ? `Hub restart: ${payloadString(payload, 'action')}`
          : 'Hub restarted';
        tone = 'warn';
        break;
      case 'resume_rejected':
        text = payloadString(payload, 'reason')
          ? `Resume rejected: ${payloadString(payload, 'reason')}`
          : 'Resume rejected';
        tone = 'error';
        break;
      case 'stage_retries_exhausted':
        text = 'Stage retries exhausted';
        tone = 'error';
        break;
      case 'stage_retry_scheduled':
        text = 'Retrying the current stage';
        break;
      case 'cycle_opened':
        text = 'Opened a new cycle';
        tone = 'ok';
        break;
      case 'improvement_selected':
        text = payloadString(payload, 'action')
          ? `Selected next: ${payloadString(payload, 'action')}`
          : 'Selected next improvement';
        tone = 'ok';
        break;
      case 'last_known_good_promoted':
        text = 'Promoted last known good revision';
        tone = 'ok';
        break;
      case 'stop_requested':
        text = 'Stop requested';
        tone = 'warn';
        break;
      case 'stopped':
        text = 'Stopped';
        tone = 'warn';
        break;
      case 'cancel_failed':
        text = 'Failed to cancel leftover work';
        tone = 'error';
        break;
      case 'outstanding_work_reconciled':
        text = 'Reconciled leftover work';
        break;
      default:
        text = event.type.replace(/_/g, ' ');
        break;
    }
    return {
      id: event.id,
      seq: event.seq,
      createdAt: event.createdAt,
      tone,
      text,
    };
  });
  return lines.sort((a, b) => b.seq - a.seq);
}

export function deriveRunView(state: AutopilotProjectStateWire): AutopilotRunView | null {
  const snap = state.activeRun;
  if (!snap) return null;
  const run = snap.run;
  const cycle = snap.cycle;
  // The deployed URL is the dedicated target's origin. The run records the
  // target id; the origin lives on the config (session preview is not proof of
  // deployment — this is the real target origin).
  const deployedUrl =
    state.config.target && (!run.targetId || run.targetId === state.config.target.targetId)
      ? state.config.target.origin
      : null;
  const evidence = deriveEvidenceView(cycle?.verification);
  const evidenceStale = Boolean(
    evidence && evidence.verdict === 'failed' && run.stage != null && run.stage !== 'verifying',
  );
  return {
    runId: run.id,
    controlState: run.controlState,
    controlStateLabel: controlStateLabel(run.controlState),
    stage: run.stage,
    stageLabel: stageLabel(run.stage),
    cycleNumber: run.cycleNumber,
    pauseReason: run.pauseReason,
    failureReason: run.failureReason,
    lastVerifiedSha: run.lastVerifiedSha,
    lastVerifiedShaShort: shortSha(run.lastVerifiedSha),
    deployedUrl,
    selectedImprovement: cycle?.selectedImprovement ?? null,
    usageText: formatUsage(run.usage),
    hasEvidence: cycle?.verification != null,
    hasDocumentation: cycle?.documentation != null,
    evidence,
    evidenceLabel: evidenceStale ? 'Last evaluation' : 'Verification evidence',
    evidenceStale,
    documentation: deriveDocumentationView(cycle?.documentation),
    stopping: run.controlState === 'stopping' || run.controlState === 'pausing',
    active: isActiveRun(run),
    currentWork: deriveCurrentWork(snap.operations),
    activity: deriveActivityLog(snap.events, snap.operations),
  };
}

export interface AutopilotView {
  enabled: boolean;
  disabling: boolean;
  readiness: ReadinessItem[];
  ready: boolean;
  controls: AutopilotControls;
  run: AutopilotRunView | null;
}

/** Single entry point the UIs call to turn a wire snapshot into everything they render. */
export function deriveAutopilotView(state: AutopilotProjectStateWire): AutopilotView {
  const readiness = deriveReadiness(state);
  return {
    enabled: state.config.enabled,
    disabling: state.config.disabling,
    readiness,
    ready: readiness.every((item) => item.ok),
    controls: deriveControls(state),
    run: deriveRunView(state),
  };
}
