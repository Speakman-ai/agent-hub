/**
 * Evidence-backed improvement selection for Autopilot's selecting-next stage.
 *
 * Ranking is Hub-owned and deterministic: regressions outrank defects, then
 * usability, performance, and unmet brief goals. The planner may propose
 * candidates, but Hub re-validates brief/non-goals/coverage and refuses
 * authority or scope expansion. Three consecutive rejected or no-benefit
 * proposals pause the run instead of churning.
 */

import type { AutopilotEventRecord } from './types.js';
import { parseCycleVerification } from './evaluate.js';

export interface AutopilotImprovementSpec {
  acceptanceJourneys: { action: string; expectedResult: string }[];
  nonGoals: string[];
  specDecisions: { key: string; decision: string }[];
}

export const AUTOPILOT_MAX_IMPROVEMENT_CANDIDATES = 5;
export const AUTOPILOT_NO_BENEFIT_PAUSE_STREAK = 3;

export const AUTOPILOT_IMPROVEMENT_KINDS = [
  'regression',
  'defect',
  'usability',
  'performance',
  'unmet-goal',
] as const;

export type AutopilotImprovementKind = (typeof AUTOPILOT_IMPROVEMENT_KINDS)[number];

export type AutopilotImprovementOutcome =
  | 'selected'
  | 'no-benefit'
  | 'rejected'
  | 'needs-expanded-authority';

const KIND_RANK: Record<AutopilotImprovementKind, number> = {
  regression: 0,
  defect: 1,
  usability: 2,
  performance: 3,
  'unmet-goal': 4,
};

export interface AutopilotImprovementCandidate {
  id: string;
  kind: AutopilotImprovementKind;
  action: string;
  expectedResult: string;
  expectedBenefit: string;
  rationale: string;
  specDecisions?: { key: string; decision: string }[];
  expandsScope?: boolean;
  expandsAuthority?: boolean;
  changesBrief?: boolean;
  changesNonGoals?: boolean;
  dropsBaselineCoverage?: boolean;
  changesEvaluatorPolicy?: boolean;
}

export type AutopilotSelectedImprovement = AutopilotImprovementCandidate;

export interface AutopilotImprovementProposal {
  candidates: AutopilotImprovementCandidate[];
  selected: AutopilotSelectedImprovement | null;
  outcome: AutopilotImprovementOutcome;
  reason?: string;
}

export interface AutopilotImprovementEvidence {
  brief: string;
  briefRevision: number;
  spec: AutopilotImprovementSpec;
  lastVerification: unknown;
  failedAttempts: { reason: string; detail?: string }[];
  priorImprovements: AutopilotSelectedImprovement[];
  proposed?: AutopilotImprovementCandidate[];
}

export interface AutopilotImprovementGuard {
  ok: boolean;
  outcome: AutopilotImprovementOutcome;
  reason?: string;
}

const PROTECTED_DECISION_KEYS = new Set([
  'brief',
  'non-goals',
  'nongoals',
  'evaluator',
  'evaluator-policy',
  'evaluatorpolicy',
  'permissions',
  'authority',
  'limits',
  'target',
]);

export function serializeSelectedImprovement(sel: AutopilotSelectedImprovement): string {
  return JSON.stringify({
    id: sel.id,
    kind: sel.kind,
    action: sel.action,
    expectedResult: sel.expectedResult,
    expectedBenefit: sel.expectedBenefit,
    rationale: sel.rationale,
    specDecisions: sel.specDecisions ?? [],
  });
}

export function parseSelectedImprovementRecord(
  raw: string | null | undefined,
): AutopilotSelectedImprovement | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
    const expectedResult =
      typeof parsed.expectedResult === 'string' ? parsed.expectedResult.trim() : '';
    if (!action || !expectedResult) return null;
    const kind = AUTOPILOT_IMPROVEMENT_KINDS.includes(parsed.kind as AutopilotImprovementKind)
      ? (parsed.kind as AutopilotImprovementKind)
      : 'unmet-goal';
    const expectedBenefit =
      typeof parsed.expectedBenefit === 'string' && parsed.expectedBenefit.trim()
        ? parsed.expectedBenefit.trim()
        : `When a user ${action}, then ${expectedResult}.`;
    const rationale =
      typeof parsed.rationale === 'string' && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : expectedBenefit;
    const specDecisions = Array.isArray(parsed.specDecisions)
      ? parsed.specDecisions
          .map((row) => {
            const dec = (row ?? {}) as Record<string, unknown>;
            const key = typeof dec.key === 'string' ? dec.key.trim() : '';
            const decision = typeof dec.decision === 'string' ? dec.decision.trim() : '';
            return key && decision ? { key, decision } : null;
          })
          .filter((d): d is { key: string; decision: string } => d != null)
      : [];
    return {
      id:
        typeof parsed.id === 'string' && parsed.id.trim()
          ? parsed.id.trim()
          : `improvement:${action}`,
      kind,
      action,
      expectedResult,
      expectedBenefit,
      rationale,
      specDecisions,
    };
  } catch {
    return null;
  }
}

export function describeSelectedImprovement(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const parsed = parseSelectedImprovementRecord(raw);
  if (parsed) return parsed.expectedBenefit;
  return raw.trim();
}

export function rankImprovementCandidates(
  input: AutopilotImprovementEvidence,
): AutopilotImprovementCandidate[] {
  const proposed = [...(input.proposed ?? [])];
  const fromEvidence = evidenceCandidates(input);
  const merged = dedupeCandidates([...fromEvidence, ...proposed]);
  const ranked = merged.sort((a, b) => {
    const kindDelta = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kindDelta !== 0) return kindDelta;
    return a.id.localeCompare(b.id);
  });
  return ranked.slice(0, AUTOPILOT_MAX_IMPROVEMENT_CANDIDATES);
}

export function guardImprovementCandidate(
  candidate: AutopilotImprovementCandidate,
  spec: AutopilotImprovementSpec,
  brief = '',
): AutopilotImprovementGuard {
  if (candidate.changesBrief || candidate.changesNonGoals || candidate.changesEvaluatorPolicy) {
    return {
      ok: false,
      outcome: 'needs-expanded-authority',
      reason: 'proposal changes the human brief, non-goals, or evaluator policy',
    };
  }
  if (candidate.expandsAuthority || candidate.expandsScope) {
    return {
      ok: false,
      outcome: 'needs-expanded-authority',
      reason: 'proposal needs expanded authority or scope',
    };
  }
  if (candidate.dropsBaselineCoverage) {
    return {
      ok: false,
      outcome: 'needs-expanded-authority',
      reason: 'proposal drops protected baseline acceptance coverage',
    };
  }
  if (!candidate.action.trim() || !candidate.expectedResult.trim()) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'proposal is not a falsifiable improvement',
    };
  }
  if (!candidate.expectedBenefit.trim()) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'proposal has no falsifiable expected benefit',
    };
  }
  const colliding = collidingNonGoal(candidate, spec.nonGoals);
  if (colliding) {
    return {
      ok: false,
      outcome: 'needs-expanded-authority',
      reason: `proposal exceeds scope: collides with non-goal "${colliding}"`,
    };
  }
  if (!isAuthorizedImprovement(candidate, spec, brief)) {
    return {
      ok: false,
      outcome: 'needs-expanded-authority',
      reason: 'proposal is not grounded in an authorized brief or specified goal',
    };
  }
  for (const decision of candidate.specDecisions ?? []) {
    const key = decision.key
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    if (PROTECTED_DECISION_KEYS.has(key)) {
      return {
        ok: false,
        outcome: 'needs-expanded-authority',
        reason: `spec decision "${decision.key}" is outside implementation authority`,
      };
    }
    const existing = spec.specDecisions.find(
      (d) => d.key.trim().toLowerCase() === decision.key.trim().toLowerCase(),
    );
    if (
      existing &&
      existing.decision.trim() &&
      existing.decision.trim() !== decision.decision.trim()
    ) {
      return {
        ok: false,
        outcome: 'needs-expanded-authority',
        reason: `spec decision "${decision.key}" contradicts the locked baseline`,
      };
    }
  }
  return { ok: true, outcome: 'selected' };
}

export function selectImprovement(
  ranked: AutopilotImprovementCandidate[],
  spec: AutopilotImprovementSpec,
  brief = '',
): AutopilotImprovementProposal {
  const candidates = ranked.slice(0, AUTOPILOT_MAX_IMPROVEMENT_CANDIDATES);
  if (candidates.length === 0) {
    return {
      candidates,
      selected: null,
      outcome: 'no-benefit',
      reason: 'no remaining in-scope improvement with a falsifiable benefit',
    };
  }
  // Skip out-of-scope ranked rows so a planner-proposed expansion cannot
  // hide a later in-scope improvement. Pause only when nothing in-scope remains.
  let expansion: { candidate: AutopilotImprovementCandidate; reason?: string } | null = null;
  for (const candidate of candidates) {
    const guard = guardImprovementCandidate(candidate, spec, brief);
    if (guard.ok) {
      return { candidates, selected: candidate, outcome: 'selected' };
    }
    if (guard.outcome === 'needs-expanded-authority') {
      expansion ??= { candidate, reason: guard.reason };
      continue;
    }
  }
  if (expansion) {
    return {
      candidates,
      selected: expansion.candidate,
      outcome: 'needs-expanded-authority',
      reason: expansion.reason,
    };
  }
  return {
    candidates,
    selected: null,
    outcome: 'rejected',
    reason: candidates[0]?.action
      ? `no in-scope candidate remained after policy checks`
      : 'all proposed improvements were rejected',
  };
}

export function applyPlannerProposal(
  ranked: AutopilotImprovementCandidate[],
  spec: AutopilotImprovementSpec,
  raw: AutopilotImprovementProposal | null | undefined,
  brief = '',
): AutopilotImprovementProposal {
  if (!raw) return selectImprovement(ranked, spec, brief);
  const candidates = dedupeCandidates([
    ...ranked,
    ...(raw.candidates ?? []).filter((c) => c && typeof c === 'object'),
  ]).slice(0, AUTOPILOT_MAX_IMPROVEMENT_CANDIDATES);
  if (raw.outcome === 'needs-expanded-authority') {
    const selected = raw.selected ?? null;
    if (selected) {
      const guard = guardImprovementCandidate(selected, spec, brief);
      if (guard.outcome === 'needs-expanded-authority') {
        return {
          candidates,
          selected,
          outcome: 'needs-expanded-authority',
          reason: raw.reason ?? guard.reason,
        };
      }
    }
    return selectImprovement(candidates, spec, brief);
  }
  if (raw.outcome === 'rejected') {
    return {
      candidates,
      selected: null,
      outcome: 'rejected',
      reason: raw.reason ?? 'proposed improvement was rejected',
    };
  }
  if (raw.outcome === 'no-benefit' || raw.selected == null) {
    const fallback = selectImprovement(candidates, spec, brief);
    if (raw.outcome === 'no-benefit' && fallback.outcome === 'selected') {
      // Planner declined a benefit; Hub still pauses churn rather than
      // silently substituting a different change.
      return {
        candidates,
        selected: null,
        outcome: 'no-benefit',
        reason: raw.reason ?? fallback.reason,
      };
    }
    return fallback.outcome === 'selected'
      ? fallback
      : {
          candidates,
          selected: null,
          outcome: 'no-benefit',
          reason: raw.reason ?? fallback.reason,
        };
  }
  const guard = guardImprovementCandidate(raw.selected, spec, brief);
  if (!guard.ok) {
    return {
      candidates,
      selected: raw.selected,
      outcome: guard.outcome,
      reason: guard.reason,
    };
  }
  return { candidates, selected: raw.selected, outcome: 'selected' };
}

export function consecutiveNoBenefitStreak(events: AutopilotEventRecord[]): number {
  let streak = 0;
  for (const event of [...events].reverse()) {
    if (event.type === 'improvement_selected') return streak;
    if (event.type === 'improvement_no_benefit' || event.type === 'improvement_rejected') {
      streak += 1;
      continue;
    }
  }
  return streak;
}

export function mergeInScopeSpecDecisions<T extends AutopilotImprovementSpec>(
  spec: T,
  extra: { key: string; decision: string }[] | undefined,
): T {
  if (!extra || extra.length === 0) return spec;
  const specDecisions = [...spec.specDecisions];
  for (const decision of extra) {
    const key = decision.key.trim();
    const value = decision.decision.trim();
    if (!key || !value) continue;
    if (PROTECTED_DECISION_KEYS.has(key.toLowerCase().replace(/[\s_]+/g, '-'))) continue;
    const idx = specDecisions.findIndex((d) => d.key.trim().toLowerCase() === key.toLowerCase());
    if (idx >= 0) continue;
    specDecisions.push({ key, decision: value });
  }
  return { ...spec, specDecisions };
}

/**
 * Cycle-specific protected journeys that evaluation must keep covering:
 * previously selected improvements plus the newly chosen one, excluding
 * baseline spec journeys that pinCriteriaFromSpec already pins.
 */
export function extraProtectedJourneys(
  spec: AutopilotImprovementSpec,
  prior: AutopilotSelectedImprovement[],
  selected: AutopilotSelectedImprovement,
): { action: string; expectedResult: string }[] {
  const specified = new Set(
    spec.acceptanceJourneys
      .map((j) => normalizeJourney(j.action, j.expectedResult))
      .filter(Boolean),
  );
  const extra: { action: string; expectedResult: string }[] = [];
  const seen = new Set<string>();
  for (const row of [...prior, selected]) {
    const key = normalizeJourney(row.action, row.expectedResult);
    if (!key || specified.has(key) || seen.has(key)) continue;
    seen.add(key);
    extra.push({ action: row.action, expectedResult: row.expectedResult });
  }
  return extra;
}

function evidenceCandidates(input: AutopilotImprovementEvidence): AutopilotImprovementCandidate[] {
  const out: AutopilotImprovementCandidate[] = [];
  const verification = parseCycleVerification(input.lastVerification);
  const pinned = verification.pinned?.criteria ?? [];
  const failedBaseline = pinned.filter((c) => {
    if (c.source !== 'baseline') return false;
    const capture = verification.hubEvidence?.captures.find((cap) => cap.criterionId === c.id);
    if (!capture) return false;
    return capture.screenshotPresent === false && c.kind === 'browser_journey';
  });
  for (const criterion of failedBaseline) {
    out.push({
      id: `regression:${criterion.id}`,
      kind: 'regression',
      action: criterion.action,
      expectedResult: criterion.expectedResult,
      expectedBenefit: `Restore baseline: when a user ${criterion.action}, then ${criterion.expectedResult}.`,
      rationale: 'Observed baseline regression in deployment evidence',
    });
  }
  for (const attempt of input.failedAttempts) {
    const reason = attempt.reason.trim();
    if (!reason) continue;
    if (!/regression|baseline|health_only|missing_evidence/i.test(reason)) continue;
    out.push({
      id: `defect:${reason}`,
      kind: reason.includes('baseline') || reason.includes('regression') ? 'regression' : 'defect',
      action: 're-run the failing baseline journey',
      expectedResult: 'the previously verified behaviour is visible again',
      expectedBenefit: `Repair ${reason} observed during the last cycle.`,
      rationale: attempt.detail?.trim() || reason,
    });
  }
  const delivered = new Set(
    [
      ...verifiedJourneys(input.lastVerification).map((j) =>
        normalizeJourney(j.action, j.expectedResult),
      ),
      ...input.priorImprovements.map((j) => normalizeJourney(j.action, j.expectedResult)),
    ].filter(Boolean),
  );
  for (const journey of input.spec.acceptanceJourneys) {
    const key = normalizeJourney(journey.action, journey.expectedResult);
    if (!key || delivered.has(key)) continue;
    out.push({
      id: `unmet:${key}`,
      kind: 'unmet-goal',
      action: journey.action,
      expectedResult: journey.expectedResult,
      expectedBenefit: `When a user ${journey.action}, then ${journey.expectedResult}.`,
      rationale: 'Specified acceptance journey is not yet verified',
    });
  }
  for (const goal of extractBriefGoals(input.brief)) {
    if (collidingNonGoal(goal, input.spec.nonGoals)) continue;
    const key = normalizeJourney(goal.action, goal.expectedResult);
    if (!key || delivered.has(key)) continue;
    if (goalCoveredBy(goal, delivered, input.spec.acceptanceJourneys, input.priorImprovements)) {
      continue;
    }
    out.push({
      id: `unmet:${key}`,
      kind: 'unmet-goal',
      action: goal.action,
      expectedResult: goal.expectedResult,
      expectedBenefit: `When a user ${goal.action}, then ${goal.expectedResult}.`,
      rationale: 'Unmet brief goal',
    });
  }
  return dedupeCandidates(out);
}

function dedupeCandidates(
  candidates: AutopilotImprovementCandidate[],
): AutopilotImprovementCandidate[] {
  const seen = new Set<string>();
  const out: AutopilotImprovementCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${normalizeJourney(candidate.action, candidate.expectedResult)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function normalizeJourney(action: string, expectedResult: string): string {
  return `${action.trim().toLowerCase()}=>${expectedResult.trim().toLowerCase()}`;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'can',
  'user',
  'users',
  'via',
  'into',
  'onto',
  'than',
  'then',
  'when',
  'your',
  'our',
  'its',
  'their',
  'build',
  'make',
  'implement',
  'using',
  'able',
  'must',
  'show',
  'shows',
  'visible',
  'product',
  'described',
  'outcome',
  'page',
]);

const NON_GOAL_ALIASES: Record<string, string[]> = {
  auth: [
    'auth',
    'authentication',
    'login',
    'log in',
    'signin',
    'sign in',
    'signed in',
    'oauth',
    'sso',
    'password',
  ],
  authentication: [
    'auth',
    'authentication',
    'login',
    'log in',
    'signin',
    'sign in',
    'signed in',
    'oauth',
    'sso',
    'password',
  ],
  'multi-tenant': ['multi-tenant', 'multitenant', 'multi tenant', 'tenancy', 'tenants'],
  'multi tenant': ['multi-tenant', 'multitenant', 'multi tenant', 'tenancy', 'tenants'],
};

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function haystackOf(candidate: {
  action: string;
  expectedResult: string;
  expectedBenefit?: string;
}): string {
  return `${candidate.action} ${candidate.expectedResult} ${candidate.expectedBenefit ?? ''}`.toLowerCase();
}

function collidingNonGoal(
  candidate: { action: string; expectedResult: string; expectedBenefit?: string },
  nonGoals: string[],
): string | null {
  const haystack = haystackOf(candidate);
  for (const nonGoal of nonGoals) {
    const needles = expandNonGoal(nonGoal);
    if (needles.some((needle) => needle && haystack.includes(needle))) return nonGoal;
  }
  return null;
}

function expandNonGoal(nonGoal: string): string[] {
  const n = nonGoal.trim().toLowerCase();
  if (!n) return [];
  const extra = NON_GOAL_ALIASES[n] ?? [];
  for (const [key, vals] of Object.entries(NON_GOAL_ALIASES)) {
    if (n === key) continue;
    if (n.includes(key) || (key.length >= 4 && key.includes(n))) {
      extra.push(...vals);
    }
  }
  return [...new Set([n, ...extra])];
}

function isAuthorizedImprovement(
  candidate: AutopilotImprovementCandidate,
  spec: AutopilotImprovementSpec,
  brief: string,
): boolean {
  if (candidate.kind === 'regression' || candidate.kind === 'defect') return true;
  const corpus = [brief, ...spec.acceptanceJourneys.map((j) => `${j.action} ${j.expectedResult}`)]
    .join(' ')
    .toLowerCase();
  const distinctive = contentTokens(`${candidate.action} ${candidate.expectedResult}`);
  if (distinctive.length === 0) return false;
  return distinctive.some((token) => corpus.includes(token));
}

function verifiedJourneys(lastVerification: unknown): { action: string; expectedResult: string }[] {
  const verification = parseCycleVerification(lastVerification);
  const pinned = verification.pinned?.criteria ?? [];
  if (verification.judgement?.ok) {
    return pinned.map((c) => ({ action: c.action, expectedResult: c.expectedResult }));
  }
  return pinned
    .filter((c) => {
      const capture = verification.hubEvidence?.captures.find((cap) => cap.criterionId === c.id);
      if (!capture) return false;
      if (c.kind === 'browser_journey') return capture.screenshotPresent === true;
      return true;
    })
    .map((c) => ({ action: c.action, expectedResult: c.expectedResult }));
}

function extractBriefGoals(brief: string): AutopilotImprovementCandidate[] {
  const sentences = brief
    .split(/[.!?;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: AutopilotImprovementCandidate[] = [];
  for (const sentence of sentences) {
    if (/^(build|create|make|implement)\b/i.test(sentence)) continue;
    const stripped = sentence
      .replace(/^(users?\s+can|allow(?:s)?|support(?:s)?|include(?:s)?)\s+/i, '')
      .trim();
    if (!stripped) continue;
    for (const part of stripped
      .split(/\s+and\s+/i)
      .map((p) => p.trim())
      .filter(Boolean)) {
      if (contentTokens(part).length === 0) continue;
      out.push({
        id: `brief:${part.toLowerCase()}`,
        kind: 'unmet-goal',
        action: part,
        expectedResult: `the product shows that ${part}`,
        expectedBenefit: `When a user ${part}, then the product shows that outcome.`,
        rationale: 'Unmet brief goal',
      });
    }
  }
  return out;
}

function goalCoveredBy(
  goal: { action: string; expectedResult: string },
  delivered: Set<string>,
  specified: { action: string; expectedResult: string }[],
  prior: AutopilotSelectedImprovement[],
): boolean {
  const key = normalizeJourney(goal.action, goal.expectedResult);
  if (key && delivered.has(key)) return true;
  const goalTokens = contentTokens(goal.action);
  if (goalTokens.length === 0) return true;
  const rows = [
    ...specified,
    ...prior.map((p) => ({ action: p.action, expectedResult: p.expectedResult })),
  ];
  return rows.some((row) => {
    const rowTokens = new Set(contentTokens(`${row.action} ${row.expectedResult}`));
    return goalTokens.every((t) => rowTokens.has(t));
  });
}
