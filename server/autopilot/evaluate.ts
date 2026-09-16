/**
 * Independent Autopilot evaluation: pin journeys before implementation, judge
 * deployed evidence, and decide last-known-good promotion.
 *
 * HTTP health is never sufficient. A candidate SHA becomes last-known-good
 * only when every pinned criterion has Hub-recorded captures bound at
 * execution time to this operation, deployment, origin and revision. Worker
 * JSON is a criterion-level pass/fail claim, not deployed proof. Hub captures
 * are screenshots, journey traces (recorded interactions, not a final-page
 * snapshot), and request/body evidence; both must agree. API success is the
 * pinned response assertion versus captured values, not JSON shape or a 2xx
 * at a matching path. Failed evaluation never selects an improvement.
 */

import { readFileSync } from 'fs';

export interface AutopilotEvaluationJourney {
  action: string;
  expectedResult: string;
}

export interface AutopilotEvaluationSpec {
  acceptanceJourneys: AutopilotEvaluationJourney[];
  qualityRubricVersion: number;
}

export type AutopilotCriterionKind = 'browser_journey' | 'api_check';
export type AutopilotCriterionSource = 'baseline' | 'cycle';

export interface AutopilotPinnedCriterion {
  id: string;
  source: AutopilotCriterionSource;
  kind: AutopilotCriterionKind;
  action: string;
  expectedResult: string;
  /** Frozen at pin time. Judge captured bodies against this, not JSON shape. */
  apiAssertion?: AutopilotPinnedApiAssertion | null;
  /** Frozen request inputs Hub transmits; not inferred at probe time. */
  apiRequest?: AutopilotPinnedApiRequest | null;
}

/** Explicit API request contract, pinned before implementation. */
export interface AutopilotPinnedApiRequest {
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Explicit API response contract, pinned before implementation. */
export interface AutopilotPinnedApiAssertion {
  json: boolean;
  /** Exact collection length (0 for an explicitly empty list). */
  arrayLength?: number;
  /** Collection must contain at least one domain item. */
  nonempty?: boolean;
  /** Exact field values, compared with Object.is (ready:true ≠ ready:false). */
  fields?: Record<string, string | number | boolean | null>;
  /** Collection items must be domain records, not error payloads. */
  itemKind?: 'items' | 'todos';
}

export interface AutopilotPinnedCriteria {
  specRevision: number;
  qualityRubricVersion: number;
  criteria: AutopilotPinnedCriterion[];
}

/** Max chars of Hub-recorded API body kept for pinned assertions. */
export const AUTOPILOT_API_BODY_MAX_CHARS = 64 * 1024;
/** Display-only excerpt. Never the assertion source when `body` is present. */
export const AUTOPILOT_API_BODY_EXCERPT_CHARS = 512;

export interface AutopilotApiCheckEvidence {
  method: string;
  url: string;
  status: number;
  /** Complete response for pinned assertions, bounded by AUTOPILOT_API_BODY_MAX_CHARS. */
  body?: string;
  /** False when `body` was cut at the size bound and is not the full HTTP response. */
  bodyComplete?: boolean;
  /** Truncated display excerpt. Not the assertion source. */
  bodyExcerpt?: string;
}

/** Hub-recorded HTTP response. `requestId` is required; report assertions are not. */
export interface AutopilotRecordedApiResponse {
  requestId: string;
  method: string;
  url: string;
  status: number;
  body?: string;
  bodyComplete?: boolean;
  bodyExcerpt?: string;
}

export interface AutopilotCriterionEvidence {
  criterionId: string;
  passed: boolean;
  kind: AutopilotCriterionKind;
  screenshotPath?: string | null;
  tracePath?: string | null;
  apiCheck?: AutopilotApiCheckEvidence | null;
  observed?: string;
  /** True when the worker asserted a pass without artifacts. */
  claimedWithoutEvidence?: boolean;
}

export interface AutopilotHealthCheck {
  url: string;
  ok: boolean;
}

export interface AutopilotEvaluationReport {
  expectedSha: string;
  observedSha: string | null;
  origin: string;
  healthCheck?: AutopilotHealthCheck | null;
  criteria: AutopilotCriterionEvidence[];
  capturedAt: string;
  /** If the worker used session preview instead of the live target. */
  usedPreview?: boolean;
}

export type AutopilotEvaluationRejectReason =
  | 'wrong_revision'
  | 'health_only'
  | 'missing_evidence'
  | 'stale_evidence'
  | 'unverifiable_claim'
  | 'baseline_regression'
  | 'pinned_criteria_missing'
  | 'preview_is_not_deployment'
  | 'subjective_claim';

export interface AutopilotEvaluationJudgementOk {
  ok: true;
  sha: string;
}

export interface AutopilotEvaluationJudgementFail {
  ok: false;
  reason: AutopilotEvaluationRejectReason;
  detail: string;
  /** Recover LKG immediately; do not retry this candidate. */
  recover: boolean;
}

export type AutopilotEvaluationJudgement =
  | AutopilotEvaluationJudgementOk
  | AutopilotEvaluationJudgementFail;

export interface AutopilotEvidenceBinding {
  operationId: string;
  deploymentId: string;
  expectedSha: string;
  /** Hub-observed live revision, never the worker-supplied SHA. */
  observedSha: string;
  origin: string;
  /** Hub clock when this evaluate operation started, not stamp time. */
  operationStartedAt: string;
}

/**
 * Worker-generated capture bound by the Hub at execution time. The evaluator
 * report cannot mint these; they are written when a screenshot is saved or
 * Hub records an HTTP response.
 */
export interface AutopilotExecutionCapture {
  captureId: string;
  criterionId: string;
  kind: AutopilotCriterionKind;
  capturedAt: string;
  operationId: string;
  deploymentId: string;
  expectedSha: string;
  origin: string;
  screenshot?: { path: string; mtimeMs: number } | null;
  trace?: { path: string; mtimeMs: number } | null;
  api?: AutopilotRecordedApiResponse | null;
}

export const AUTOPILOT_EVAL_BROWSER_TRACE_KIND = 'autopilot-eval-browser-trace' as const;

/** Browser ops that count as a journey interaction (not screenshot/close). */
export const AUTOPILOT_JOURNEY_INTERACTION_OPS = [
  'navigate',
  'click',
  'type',
  'extract',
  'scroll',
  'back',
  'forward',
  'wait',
  'read_page',
] as const;

const JOURNEY_INTERACTION_OP_SET: ReadonlySet<string> = new Set(AUTOPILOT_JOURNEY_INTERACTION_OPS);

/** One Hub-recorded evaluator browser step. */
export interface AutopilotEvaluatorBrowserAction {
  op: string;
  at: string;
  ok: boolean;
  url?: string;
  target?: string;
}

/**
 * True when `raw` is a Hub journey trace: the recorded interaction sequence,
 * not a final-page snapshot of url/title/text.
 */
export function isEvaluatorJourneyTrace(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== AUTOPILOT_EVAL_BROWSER_TRACE_KIND) return false;
  if (!Array.isArray(obj.actions) || obj.actions.length === 0) return false;
  let interaction = false;
  for (const row of obj.actions) {
    if (!row || typeof row !== 'object') return false;
    const action = row as Record<string, unknown>;
    if (typeof action.op !== 'string' || !action.op.trim()) return false;
    if (typeof action.at !== 'string' || !action.at.trim()) return false;
    if (typeof action.ok !== 'boolean') return false;
    if (action.ok === true && JOURNEY_INTERACTION_OP_SET.has(action.op)) {
      interaction = true;
    }
  }
  return interaction;
}

/** Read a Hub-owned trace file and accept only a recorded journey sequence. */
export function fileIsEvaluatorJourneyTrace(filePath: string): boolean {
  try {
    return isEvaluatorJourneyTrace(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return false;
  }
}

export interface AutopilotCapturedCriterion {
  captureId: string;
  criterionId: string;
  kind: AutopilotCriterionKind;
  capturedAt: string;
  screenshotPath?: string | null;
  screenshotPresent: boolean;
  screenshotMtimeMs?: number | null;
  tracePath?: string | null;
  tracePresent: boolean;
  traceMtimeMs?: number | null;
  apiCheck?: AutopilotApiCheckEvidence | null;
  apiRequestId?: string | null;
  apiOriginMatches: boolean;
}

export interface AutopilotHubEvidence {
  binding: AutopilotEvidenceBinding;
  captures: AutopilotCapturedCriterion[];
}

export interface AutopilotCycleVerification {
  pinned: AutopilotPinnedCriteria | null;
  evidence: AutopilotEvaluationReport | null;
  hubEvidence: AutopilotHubEvidence | null;
  judgement: AutopilotEvaluationJudgement | null;
}

const SUBJECTIVE =
  /\b(looks good|seems fine|appears to work|probably works|i think it passed|lgtm)\b/i;
const DEFAULT_EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;

export function clipApiBodyExcerpt(body: string): string {
  return body.length <= AUTOPILOT_API_BODY_EXCERPT_CHARS
    ? body
    : body.slice(0, AUTOPILOT_API_BODY_EXCERPT_CHARS);
}

/**
 * Split an already-collected body into assertion text vs display excerpt.
 * Callers that read HTTP must cap the stream first; this must not be the
 * first bound on a live response.
 */
export function boundApiResponseBody(text: string): {
  body: string;
  bodyComplete: boolean;
  bodyExcerpt: string;
} {
  const bodyComplete = text.length <= AUTOPILOT_API_BODY_MAX_CHARS;
  const body = bodyComplete ? text : text.slice(0, AUTOPILOT_API_BODY_MAX_CHARS);
  return { body, bodyComplete, bodyExcerpt: clipApiBodyExcerpt(text) };
}

function parseApiBodyFields(api: Record<string, unknown>): {
  body?: string;
  bodyComplete?: boolean;
  bodyExcerpt?: string;
} {
  const body = typeof api.body === 'string' ? api.body : undefined;
  const bodyExcerpt =
    typeof api.bodyExcerpt === 'string'
      ? api.bodyExcerpt
      : typeof body === 'string'
        ? clipApiBodyExcerpt(body)
        : undefined;
  const bodyComplete =
    api.bodyComplete === false ? false : typeof body === 'string' ? true : undefined;
  return { body, bodyComplete, bodyExcerpt };
}

function parseApiCheckEvidence(api: Record<string, unknown>): AutopilotApiCheckEvidence {
  return {
    method: typeof api.method === 'string' && api.method.trim() ? api.method.trim() : 'GET',
    url: typeof api.url === 'string' ? api.url : '',
    status: typeof api.status === 'number' ? api.status : 0,
    ...parseApiBodyFields(api),
  };
}

export function criterionId(source: AutopilotCriterionSource, index: number): string {
  return `${source}-${index + 1}`;
}

function journeyKind(journey: AutopilotEvaluationJourney): AutopilotCriterionKind {
  const blob = `${journey.action} ${journey.expectedResult}`.toLowerCase();
  if (/\b(api|http|endpoint|json)\b/.test(blob) && !/\b(browser|page|form|click|ui)\b/.test(blob)) {
    return 'api_check';
  }
  return 'browser_journey';
}

const ASSERTION_FIELD_STOP = new Set([
  'return',
  'returns',
  'json',
  'with',
  'and',
  'the',
  'for',
  'from',
  'http',
  'get',
  'post',
  'put',
  'then',
  'when',
  'that',
  'this',
  'as',
  'are',
  'was',
]);

function coerceLiteral(raw: string): string | number | boolean | null {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseJsonExcerpt(excerpt: string): unknown | undefined {
  try {
    return JSON.parse(excerpt);
  } catch {
    return undefined;
  }
}

function extractLiteralFields(text: string): Record<string, string | number | boolean | null> {
  const fields: Record<string, string | number | boolean | null> = {};
  const objLit = text.match(/\{[^{}]+\}/);
  if (objLit) {
    const parsed = parseJsonExcerpt(objLit[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
          fields[k] = v as string | number | boolean | null;
        }
      }
    }
  }
  const fieldRe =
    /\b([a-z_][\w]*)\s*(?:is|:|=)?\s*(true|false|null|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\b/gi;
  for (const match of text.matchAll(fieldRe)) {
    const key = match[1]!;
    if (ASSERTION_FIELD_STOP.has(key.toLowerCase())) continue;
    fields[key] = coerceLiteral(match[2]!);
  }
  return fields;
}

const REQUEST_PAYLOAD_KEYS = new Set([
  'title',
  'name',
  'text',
  'id',
  'description',
  'label',
  'done',
  'completed',
]);

function isMutatingMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

/** Pin the HTTP request Hub will send so a POST cannot run without its JSON. */
export function pinApiRequest(
  journey: AutopilotEvaluationJourney,
): AutopilotPinnedApiRequest | null {
  const match = journey.action.trim().match(API_ACTION);
  if (!match) return null;
  const method = match[1]!.toUpperCase();
  const remainder = journey.action.trim().slice(match[0].length).trim();
  let body: string | undefined;
  const jsonLit = remainder.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonLit) {
    const parsed = parseJsonExcerpt(jsonLit[1]!);
    if (parsed !== undefined) body = JSON.stringify(parsed);
  }
  if (!body && isMutatingMethod(method)) {
    const fromAction = extractLiteralFields(remainder);
    const fromExpected = extractLiteralFields(journey.expectedResult);
    const payload: Record<string, string | number | boolean | null> = { ...fromAction };
    if (Object.keys(payload).length === 0) {
      for (const [k, v] of Object.entries(fromExpected)) {
        if (REQUEST_PAYLOAD_KEYS.has(k)) payload[k] = v;
      }
    }
    if (Object.keys(payload).length > 0) body = JSON.stringify(payload);
  }
  const headers: Record<string, string> = {};
  if (body != null && /^[[{]/.test(body)) headers['content-type'] = 'application/json';
  return {
    method,
    ...(body != null ? { body } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
export function pinApiResponseAssertion(
  journey: AutopilotEvaluationJourney,
): AutopilotPinnedApiAssertion {
  const expected = journey.expectedResult.trim();
  const blob = `${journey.action} ${expected}`;
  const json = /\bjson\b/i.test(blob) || /\{[\s\S]*\}|\[[\s\S]*\]/.test(expected);
  const empty =
    /\b(empty|no)\b[\s\w]*\b(list|array|items?|todos?|records?)\b/i.test(expected) ||
    /\b(list|array|items?)\b[\s\w]*\bempty\b/i.test(expected) ||
    /\[\s*\]/.test(expected);
  const collection = /\b(items?|list|todos?|records?|collection)\b/i.test(expected);
  const itemKind: AutopilotPinnedApiAssertion['itemKind'] = /\btodos?\b/i.test(blob)
    ? 'todos'
    : collection
      ? 'items'
      : undefined;
  const fields = extractLiteralFields(expected);
  const hasFields = Object.keys(fields).length > 0;
  return {
    json: json || empty || collection || hasFields,
    ...(empty ? { arrayLength: 0 } : collection ? { nonempty: true } : {}),
    ...(hasFields ? { fields } : {}),
    ...(itemKind && !empty ? { itemKind } : {}),
  };
}

function parseApiAssertion(raw: unknown): AutopilotPinnedApiAssertion | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.json !== true && obj.json !== false) return null;
  const assertion: AutopilotPinnedApiAssertion = { json: obj.json === true };
  if (
    typeof obj.arrayLength === 'number' &&
    Number.isInteger(obj.arrayLength) &&
    obj.arrayLength >= 0
  ) {
    assertion.arrayLength = obj.arrayLength;
  }
  if (obj.nonempty === true) assertion.nonempty = true;
  if (obj.itemKind === 'todos' || obj.itemKind === 'items') assertion.itemKind = obj.itemKind;
  if (obj.fields && typeof obj.fields === 'object' && !Array.isArray(obj.fields)) {
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(obj.fields as Record<string, unknown>)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        fields[k] = v as string | number | boolean | null;
      }
    }
    if (Object.keys(fields).length > 0) assertion.fields = fields;
  }
  return assertion;
}

function parseApiRequest(raw: unknown): AutopilotPinnedApiRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const method = typeof obj.method === 'string' ? obj.method.trim().toUpperCase() : '';
  if (!method) return null;
  const request: AutopilotPinnedApiRequest = { method };
  if (typeof obj.body === 'string') request.body = obj.body;
  if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof v === 'string' && k.trim()) headers[k] = v;
    }
    if (Object.keys(headers).length > 0) request.headers = headers;
  }
  return request;
}

function mapJourneys(
  journeys: AutopilotEvaluationJourney[],
  source: AutopilotCriterionSource,
): AutopilotPinnedCriterion[] {
  return journeys
    .map((j) => ({
      action: typeof j.action === 'string' ? j.action.trim() : '',
      expectedResult: typeof j.expectedResult === 'string' ? j.expectedResult.trim() : '',
    }))
    .filter((j) => j.action && j.expectedResult)
    .map((j, i) => {
      const kind = journeyKind(j);
      return {
        id: criterionId(source, i),
        source,
        kind,
        action: j.action,
        expectedResult: j.expectedResult,
        apiAssertion: kind === 'api_check' ? pinApiResponseAssertion(j) : null,
        apiRequest: kind === 'api_check' ? pinApiRequest(j) : null,
      };
    });
}

/**
 * Snapshot baseline (and optional cycle-specific) journeys so implementation
 * cannot redefine success after the fact.
 */
export function deriveCycleJourneys(
  spec: AutopilotEvaluationSpec,
  cycle: {
    selectedImprovement?: string | null;
    cardId?: string | null;
  } = {},
  board?: { primaryCardId: string; cards: { cardId: string }[] } | null,
): AutopilotEvaluationJourney[] {
  const fromImprovement = parseSelectedImprovement(cycle.selectedImprovement);
  if (fromImprovement) return [fromImprovement];
  const journeys = spec.acceptanceJourneys ?? [];
  if (!board || !cycle.cardId || cycle.cardId === board.primaryCardId) {
    return journeys.filter((j) => j.action?.trim() && j.expectedResult?.trim());
  }
  const idx = board.cards.findIndex((c) => c.cardId === cycle.cardId);
  // Extra cards are filed after the primary, 1:1 with journeys.slice(1).
  const journey = idx > 0 ? journeys[idx] : journeys[0];
  return journey?.action && journey.expectedResult ? [journey] : [];
}

function parseSelectedImprovement(
  raw: string | null | undefined,
): AutopilotEvaluationJourney | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
    const expectedResult =
      typeof parsed.expectedResult === 'string' ? parsed.expectedResult.trim() : '';
    if (action && expectedResult) return { action, expectedResult };
  } catch {
    /* not JSON */
  }
  return null;
}

export function pinCriteriaFromSpec(
  spec: AutopilotEvaluationSpec,
  specRevision: number,
  cycleJourneys: AutopilotEvaluationJourney[] = [],
): AutopilotPinnedCriteria {
  const baseline = mapJourneys(spec.acceptanceJourneys, 'baseline');
  const extra = mapJourneys(cycleJourneys, 'cycle');
  return {
    specRevision,
    qualityRubricVersion: spec.qualityRubricVersion,
    criteria: [...baseline, ...extra],
  };
}

export function parsePinnedCriteria(raw: unknown): AutopilotPinnedCriteria | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const specRevision =
    typeof obj.specRevision === 'number' && Number.isInteger(obj.specRevision)
      ? obj.specRevision
      : null;
  const qualityRubricVersion =
    typeof obj.qualityRubricVersion === 'number' && obj.qualityRubricVersion >= 1
      ? Math.floor(obj.qualityRubricVersion)
      : null;
  if (specRevision == null || qualityRubricVersion == null) return null;
  if (!Array.isArray(obj.criteria) || obj.criteria.length === 0) return null;
  const criteria: AutopilotPinnedCriterion[] = [];
  for (const row of obj.criteria) {
    if (!row || typeof row !== 'object') return null;
    const c = row as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id.trim() : '';
    const source = c.source === 'cycle' ? 'cycle' : c.source === 'baseline' ? 'baseline' : null;
    const kind =
      c.kind === 'api_check'
        ? 'api_check'
        : c.kind === 'browser_journey'
          ? 'browser_journey'
          : null;
    const action = typeof c.action === 'string' ? c.action.trim() : '';
    const expectedResult = typeof c.expectedResult === 'string' ? c.expectedResult.trim() : '';
    if (!id || !source || !kind || !action || !expectedResult) return null;
    const apiAssertion =
      kind === 'api_check'
        ? (parseApiAssertion(c.apiAssertion) ?? pinApiResponseAssertion({ action, expectedResult }))
        : null;
    const apiRequest =
      kind === 'api_check'
        ? (parseApiRequest(c.apiRequest) ?? pinApiRequest({ action, expectedResult }))
        : null;
    criteria.push({ id, source, kind, action, expectedResult, apiAssertion, apiRequest });
  }
  return { specRevision, qualityRubricVersion, criteria };
}

export function parseCycleVerification(raw: unknown): AutopilotCycleVerification {
  if (!raw || typeof raw !== 'object') {
    return { pinned: null, evidence: null, hubEvidence: null, judgement: null };
  }
  const obj = raw as Record<string, unknown>;
  return {
    pinned: parsePinnedCriteria(obj.pinned),
    evidence: parseEvaluationReport(obj.evidence),
    hubEvidence: parseHubEvidence(obj.hubEvidence),
    judgement: parseJudgement(obj.judgement),
  };
}

function parseJudgement(raw: unknown): AutopilotEvaluationJudgement | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.ok === true && typeof obj.sha === 'string' && obj.sha.trim()) {
    return { ok: true, sha: obj.sha };
  }
  if (obj.ok === false && typeof obj.reason === 'string' && typeof obj.detail === 'string') {
    return {
      ok: false,
      reason: obj.reason as AutopilotEvaluationRejectReason,
      detail: obj.detail,
      recover: obj.recover === true,
    };
  }
  return null;
}

export function writeCycleVerification(
  current: unknown,
  patch: Partial<AutopilotCycleVerification>,
): string {
  const existing = parseCycleVerification(current);
  return JSON.stringify({
    pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
    evidence: patch.evidence !== undefined ? patch.evidence : existing.evidence,
    hubEvidence: patch.hubEvidence !== undefined ? patch.hubEvidence : existing.hubEvidence,
    judgement: patch.judgement !== undefined ? patch.judgement : existing.judgement,
  });
}

export function parseEvaluationReport(raw: unknown): AutopilotEvaluationReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const expectedSha = typeof obj.expectedSha === 'string' ? obj.expectedSha.trim() : '';
  const origin = typeof obj.origin === 'string' ? obj.origin.trim() : '';
  if (!expectedSha || !origin) return null;
  const observedSha =
    typeof obj.observedSha === 'string' && obj.observedSha.trim() ? obj.observedSha.trim() : null;
  const capturedAt = typeof obj.capturedAt === 'string' ? obj.capturedAt : '';
  const criteriaRaw = Array.isArray(obj.criteria) ? obj.criteria : [];
  const criteria: AutopilotCriterionEvidence[] = criteriaRaw.map((row) => {
    const c = (row ?? {}) as Record<string, unknown>;
    const api =
      c.apiCheck && typeof c.apiCheck === 'object' ? (c.apiCheck as Record<string, unknown>) : null;
    return {
      criterionId: typeof c.criterionId === 'string' ? c.criterionId : '',
      passed: c.passed === true,
      kind: c.kind === 'api_check' ? 'api_check' : 'browser_journey',
      screenshotPath: typeof c.screenshotPath === 'string' ? c.screenshotPath : null,
      tracePath: typeof c.tracePath === 'string' ? c.tracePath : null,
      apiCheck: api ? parseApiCheckEvidence(api) : null,
      observed: typeof c.observed === 'string' ? c.observed : undefined,
      claimedWithoutEvidence: c.claimedWithoutEvidence === true,
    };
  });
  const health =
    obj.healthCheck && typeof obj.healthCheck === 'object'
      ? (obj.healthCheck as Record<string, unknown>)
      : null;
  return {
    expectedSha,
    observedSha,
    origin,
    healthCheck: health
      ? { url: typeof health.url === 'string' ? health.url : '', ok: health.ok === true }
      : null,
    criteria,
    capturedAt,
    usedPreview: obj.usedPreview === true,
  };
}

export type ArtifactExists = (
  path: string,
) => { exists: boolean; mtimeMs?: number; journeyTrace?: boolean } | boolean;

function resolveArtifact(
  path: string | null | undefined,
  artifactExists?: ArtifactExists,
): {
  present: boolean;
  mtimeMs?: number;
} {
  if (!path?.trim()) return { present: false };
  if (!artifactExists) return { present: false };
  const result = artifactExists(path);
  if (typeof result === 'boolean') {
    // Existence without mtime is not freshness. Callers must stat.
    return { present: result, mtimeMs: undefined };
  }
  return { present: result.exists, mtimeMs: result.mtimeMs };
}

function isJourneyTraceArtifact(
  filePath: string | null | undefined,
  artifactExists?: ArtifactExists,
): boolean {
  if (!filePath?.trim()) return false;
  if (artifactExists) {
    const result = artifactExists(filePath);
    if (typeof result === 'object' && result && typeof result.journeyTrace === 'boolean') {
      return result.journeyTrace;
    }
  }
  return fileIsEvaluatorJourneyTrace(filePath);
}

export function apiOriginMatches(url: string, origin: string): boolean {
  try {
    return new URL(url).origin.replace(/\/+$/, '') === origin.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

function isHealthUrl(url: string, healthUrl?: string | null): boolean {
  const health = (healthUrl ?? '').replace(/\/+$/, '');
  const trimmed = url.replace(/\/+$/, '');
  if (health && trimmed === health) return true;
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === '/health';
  } catch {
    return false;
  }
}

const API_ACTION = /^(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i;

/** Resolve the live URL a pinned API journey names. Identity only, not a pass. */
export function apiRequestFromJourney(
  origin: string,
  criterion: { action: string },
): { method: string; url: string } | null {
  const originTrimmed = origin.replace(/\/+$/, '');
  const match = criterion.action.trim().match(API_ACTION);
  if (!match || !originTrimmed) return null;
  try {
    return {
      method: match[1]!.toUpperCase(),
      url: new URL(match[2]!, `${originTrimmed}/`).toString(),
    };
  } catch {
    return null;
  }
}

function normalizePathname(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return urlOrPath.replace(/\/+$/, '') || '/';
  }
}

/** True when the recorded request is the journey's endpoint, not that it passed. */
export function apiTargetsCriterion(
  criterion: AutopilotPinnedCriterion,
  api: AutopilotApiCheckEvidence,
  origin: string,
): boolean {
  const expected = apiRequestFromJourney(origin, criterion);
  if (expected) {
    if (api.method.toUpperCase() !== expected.method) return false;
    return normalizePathname(api.url) === normalizePathname(expected.url);
  }
  const pathInAction = criterion.action.match(/(\/[\w/-]+)/);
  if (!pathInAction) return false;
  return normalizePathname(api.url) === pathInAction[1]!.replace(/\/+$/, '');
}

function jsonCollectionItems(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of ['items', 'data', 'todos', 'results', 'records']) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return null;
}

const DOMAIN_ITEM_KEYS = ['title', 'name', 'text', 'id', 'description', 'label'];

function isDomainCollectionItem(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const obj = item as Record<string, unknown>;
  if ('error' in obj || 'errno' in obj) return false;
  return DOMAIN_ITEM_KEYS.some((k) => obj[k] != null && obj[k] !== '');
}

/**
 * Hub-recorded body must satisfy the pinned assertion's values, not merely
 * parse as JSON or be a nonempty array.
 */
export function apiSatisfiesExpectedResult(
  criterion: AutopilotPinnedCriterion,
  api: AutopilotApiCheckEvidence,
): boolean {
  const assertion =
    criterion.apiAssertion ??
    pinApiResponseAssertion({ action: criterion.action, expectedResult: criterion.expectedResult });
  if (api.bodyComplete === false) return false;
  const body = (typeof api.body === 'string' ? api.body : (api.bodyExcerpt ?? '')).trim();
  if (!body) return false;
  if (!assertion.json) return body.length > 0;
  const parsed = parseJsonExcerpt(body);
  if (parsed === undefined) return false;
  const items = jsonCollectionItems(parsed);
  if (assertion.arrayLength != null) {
    if (!items || items.length !== assertion.arrayLength) return false;
  }
  if (assertion.nonempty) {
    if (!items || items.length === 0) return false;
  }
  if (assertion.fields) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    for (const [key, expected] of Object.entries(assertion.fields)) {
      if (!Object.is(obj[key], expected)) return false;
    }
  }
  if (assertion.itemKind) {
    if (!items || !items.every(isDomainCollectionItem)) return false;
  }
  return true;
}

function criterionFailureReason(
  criterion: AutopilotPinnedCriterion,
): AutopilotEvaluationRejectReason {
  return criterion.source === 'baseline' ? 'baseline_regression' : 'missing_evidence';
}

function parseIsoMs(raw: string): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function withinFreshWindow(
  atMs: number | null | undefined,
  nowMs: number,
  maxAgeMs: number,
  notBeforeMs: number | null,
): boolean {
  if (atMs == null || !Number.isFinite(atMs)) return false;
  if (atMs > nowMs + CLOCK_SKEW_MS) return false;
  if (nowMs - atMs > maxAgeMs) return false;
  if (notBeforeMs != null && atMs < notBeforeMs - CLOCK_SKEW_MS) return false;
  return true;
}

function parseRecordedApi(raw: unknown): AutopilotRecordedApiResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const api = raw as Record<string, unknown>;
  const requestId = typeof api.requestId === 'string' ? api.requestId.trim() : '';
  const url = typeof api.url === 'string' ? api.url.trim() : '';
  const method = typeof api.method === 'string' && api.method.trim() ? api.method.trim() : 'GET';
  const status = typeof api.status === 'number' ? api.status : NaN;
  if (!requestId || !url || !Number.isFinite(status)) return null;
  return {
    requestId,
    method,
    url,
    status,
    ...parseApiBodyFields(api),
  };
}

/** Validate a Hub capture written at execution time. Report JSON cannot mint one. */
export function bindExecutionCapture(
  input: AutopilotExecutionCapture,
): AutopilotExecutionCapture | null {
  const captureId = input.captureId?.trim() ?? '';
  const criterionIdValue = input.criterionId?.trim() ?? '';
  const operationId = input.operationId?.trim() ?? '';
  const deploymentId = input.deploymentId?.trim() ?? '';
  const expectedSha = input.expectedSha?.trim() ?? '';
  const origin = (input.origin ?? '').replace(/\/+$/, '');
  const capturedAt = input.capturedAt?.trim() ?? '';
  if (
    !captureId ||
    !criterionIdValue ||
    !operationId ||
    !deploymentId ||
    !expectedSha ||
    !origin ||
    !capturedAt
  ) {
    return null;
  }
  if (input.kind !== 'browser_journey' && input.kind !== 'api_check') return null;
  const screenshot =
    input.screenshot?.path?.trim() && Number.isFinite(input.screenshot.mtimeMs)
      ? { path: input.screenshot.path.trim(), mtimeMs: input.screenshot.mtimeMs }
      : null;
  const trace =
    input.trace?.path?.trim() && Number.isFinite(input.trace.mtimeMs)
      ? { path: input.trace.path.trim(), mtimeMs: input.trace.mtimeMs }
      : null;
  const api = input.api?.requestId?.trim() ? parseRecordedApi(input.api) : null;
  if (input.kind === 'api_check' && !api) return null;
  if (input.kind === 'browser_journey' && !screenshot && !trace) return null;
  return {
    captureId,
    criterionId: criterionIdValue,
    kind: input.kind,
    capturedAt,
    operationId,
    deploymentId,
    expectedSha,
    origin,
    screenshot,
    trace,
    api,
  };
}

/**
 * Attach Hub-recorded browser files to a criterion when the worker cited
 * that path. This is identity matching only — it never copies API status or
 * invents captures from the report.
 */
export function associateCapturesWithCriteria(
  captures: AutopilotExecutionCapture[],
  report: AutopilotEvaluationReport | null | undefined,
): AutopilotExecutionCapture[] {
  if (!report) return captures;
  return captures.map((capture) => {
    if (capture.criterionId && capture.criterionId !== 'unassigned') return capture;
    const ev = report.criteria.find(
      (row) =>
        (capture.screenshot?.path &&
          (row.screenshotPath === capture.screenshot.path ||
            row.tracePath === capture.screenshot.path)) ||
        (capture.trace?.path &&
          (row.tracePath === capture.trace.path || row.screenshotPath === capture.trace.path)),
    );
    if (!ev?.criterionId) return capture;
    return (
      bindExecutionCapture({
        ...capture,
        criterionId: ev.criterionId,
        kind: 'browser_journey',
      }) ?? capture
    );
  });
}

/**
 * Assemble Hub evidence from execution-time captures. Never copies API
 * status/body or screenshot strings from the evaluator report.
 */
export function stampHubEvidence(input: {
  operationId: string;
  deploymentId: string;
  expectedSha: string;
  observedSha: string | null;
  origin: string;
  operationStartedAt: string;
  captures: AutopilotExecutionCapture[];
  report?: AutopilotEvaluationReport | null;
  artifactExists?: ArtifactExists;
}): AutopilotHubEvidence | null {
  const operationId = input.operationId.trim();
  const deploymentId = input.deploymentId.trim();
  const expectedSha = input.expectedSha.trim();
  const observedSha = (input.observedSha ?? '').trim();
  const origin = input.origin.replace(/\/+$/, '');
  const operationStartedAt = input.operationStartedAt.trim();
  if (
    !operationId ||
    !deploymentId ||
    !expectedSha ||
    !observedSha ||
    !origin ||
    !operationStartedAt
  ) {
    return null;
  }
  const captures: AutopilotCapturedCriterion[] = [];
  for (const raw of associateCapturesWithCriteria(input.captures, input.report)) {
    const bound = bindExecutionCapture(raw);
    if (!bound) continue;
    if (
      bound.operationId !== operationId ||
      bound.deploymentId !== deploymentId ||
      bound.expectedSha !== expectedSha ||
      bound.origin.replace(/\/+$/, '') !== origin
    ) {
      continue;
    }
    const shot = resolveArtifact(bound.screenshot?.path, input.artifactExists);
    const trace = resolveArtifact(bound.trace?.path, input.artifactExists);
    const screenshotMtimeMs = shot.mtimeMs ?? bound.screenshot?.mtimeMs ?? null;
    const traceMtimeMs = trace.mtimeMs ?? bound.trace?.mtimeMs ?? null;
    const api = bound.api;
    captures.push({
      captureId: bound.captureId,
      criterionId: bound.criterionId,
      kind: bound.kind,
      capturedAt: bound.capturedAt,
      screenshotPath: bound.screenshot?.path ?? null,
      screenshotPresent: Boolean(bound.screenshot && shot.present),
      screenshotMtimeMs,
      tracePath: bound.trace?.path ?? null,
      tracePresent: Boolean(
        bound.trace &&
        trace.present &&
        isJourneyTraceArtifact(bound.trace.path, input.artifactExists),
      ),
      traceMtimeMs,
      apiCheck: api
        ? {
            method: api.method,
            url: api.url,
            status: api.status,
            body: api.body,
            bodyComplete: api.bodyComplete,
            bodyExcerpt: api.bodyExcerpt,
          }
        : null,
      apiRequestId: api?.requestId ?? null,
      apiOriginMatches: api ? apiOriginMatches(api.url, origin) : false,
    });
  }
  return {
    binding: {
      operationId,
      deploymentId,
      expectedSha,
      observedSha,
      origin,
      operationStartedAt,
    },
    captures,
  };
}

export function parseHubEvidence(raw: unknown): AutopilotHubEvidence | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const bindingRaw =
    obj.binding && typeof obj.binding === 'object'
      ? (obj.binding as Record<string, unknown>)
      : null;
  if (!bindingRaw) return null;
  const operationId =
    typeof bindingRaw.operationId === 'string' ? bindingRaw.operationId.trim() : '';
  const deploymentId =
    typeof bindingRaw.deploymentId === 'string' ? bindingRaw.deploymentId.trim() : '';
  const expectedSha =
    typeof bindingRaw.expectedSha === 'string' ? bindingRaw.expectedSha.trim() : '';
  const observedSha =
    typeof bindingRaw.observedSha === 'string' ? bindingRaw.observedSha.trim() : '';
  const origin = typeof bindingRaw.origin === 'string' ? bindingRaw.origin.trim() : '';
  const operationStartedAt =
    typeof bindingRaw.operationStartedAt === 'string' ? bindingRaw.operationStartedAt.trim() : '';
  if (
    !operationId ||
    !deploymentId ||
    !expectedSha ||
    !observedSha ||
    !origin ||
    !operationStartedAt
  ) {
    return null;
  }
  const capturesRaw = Array.isArray(obj.captures) ? obj.captures : [];
  const captures: AutopilotCapturedCriterion[] = capturesRaw.map((row) => {
    const c = (row ?? {}) as Record<string, unknown>;
    const api =
      c.apiCheck && typeof c.apiCheck === 'object' ? (c.apiCheck as Record<string, unknown>) : null;
    const requestId =
      typeof c.apiRequestId === 'string' && c.apiRequestId.trim()
        ? c.apiRequestId.trim()
        : typeof api?.requestId === 'string'
          ? api.requestId.trim()
          : '';
    return {
      captureId: typeof c.captureId === 'string' ? c.captureId : '',
      criterionId: typeof c.criterionId === 'string' ? c.criterionId : '',
      kind: c.kind === 'api_check' ? 'api_check' : 'browser_journey',
      capturedAt: typeof c.capturedAt === 'string' ? c.capturedAt : '',
      screenshotPath: typeof c.screenshotPath === 'string' ? c.screenshotPath : null,
      screenshotPresent: c.screenshotPresent === true,
      screenshotMtimeMs:
        typeof c.screenshotMtimeMs === 'number' && Number.isFinite(c.screenshotMtimeMs)
          ? c.screenshotMtimeMs
          : null,
      tracePath: typeof c.tracePath === 'string' ? c.tracePath : null,
      tracePresent: c.tracePresent === true,
      traceMtimeMs:
        typeof c.traceMtimeMs === 'number' && Number.isFinite(c.traceMtimeMs)
          ? c.traceMtimeMs
          : null,
      apiCheck: api ? parseApiCheckEvidence(api) : null,
      apiRequestId: requestId || null,
      apiOriginMatches: c.apiOriginMatches === true,
    };
  });
  return {
    binding: { operationId, deploymentId, expectedSha, observedSha, origin, operationStartedAt },
    captures,
  };
}

function hasBothBrowserArtifacts(cap: AutopilotCapturedCriterion): boolean {
  return cap.screenshotPresent && cap.tracePresent;
}

function hasFreshBrowserCapture(
  cap: AutopilotCapturedCriterion,
  nowMs: number,
  maxAgeMs: number,
  notBeforeMs: number | null,
): boolean {
  const capturedMs = parseIsoMs(cap.capturedAt);
  if (!withinFreshWindow(capturedMs, nowMs, maxAgeMs, notBeforeMs)) return false;
  if (!hasBothBrowserArtifacts(cap)) return false;
  return (
    withinFreshWindow(cap.screenshotMtimeMs, nowMs, maxAgeMs, notBeforeMs) &&
    withinFreshWindow(cap.traceMtimeMs, nowMs, maxAgeMs, notBeforeMs)
  );
}

function hasFreshApiCapture(
  cap: AutopilotCapturedCriterion,
  origin: string,
  nowMs: number,
  maxAgeMs: number,
  notBeforeMs: number | null,
  healthUrl?: string | null,
): boolean {
  const api = cap.apiCheck;
  const requestId = cap.apiRequestId?.trim() ?? '';
  if (!requestId || !api || !api.url) return false;
  if (!Number.isFinite(api.status) || api.status < 200 || api.status >= 300) return false;
  if (!cap.apiOriginMatches || !apiOriginMatches(api.url, origin)) return false;
  if (isHealthUrl(api.url, healthUrl)) return false;
  const capturedMs = parseIsoMs(cap.capturedAt);
  return withinFreshWindow(capturedMs, nowMs, maxAgeMs, notBeforeMs);
}

function captureCovers(
  criterion: AutopilotPinnedCriterion,
  cap: AutopilotCapturedCriterion,
  origin: string,
  nowMs: number,
  maxAgeMs: number,
  notBeforeMs: number | null,
  healthUrl?: string | null,
): boolean {
  if (cap.criterionId !== criterion.id) return false;
  if (criterion.kind === 'browser_journey') {
    return (
      cap.kind === 'browser_journey' && hasFreshBrowserCapture(cap, nowMs, maxAgeMs, notBeforeMs)
    );
  }
  if (
    cap.kind !== 'api_check' ||
    !hasFreshApiCapture(cap, origin, nowMs, maxAgeMs, notBeforeMs, healthUrl) ||
    !cap.apiCheck
  ) {
    return false;
  }
  return (
    apiTargetsCriterion(criterion, cap.apiCheck, origin) &&
    apiSatisfiesExpectedResult(criterion, cap.apiCheck)
  );
}

export function judgeEvaluation(input: {
  pinned: AutopilotPinnedCriteria | null;
  expectedSha: string;
  targetOrigin: string;
  report: AutopilotEvaluationReport | null;
  hubEvidence?: AutopilotHubEvidence | null;
  binding?: { operationId: string; deploymentId: string };
  now?: Date;
  maxEvidenceAgeMs?: number;
}): AutopilotEvaluationJudgement {
  const fail = (
    reason: AutopilotEvaluationRejectReason,
    detail: string,
    recover: boolean,
  ): AutopilotEvaluationJudgementFail => ({ ok: false, reason, detail, recover });

  if (!input.pinned || input.pinned.criteria.length === 0) {
    return fail(
      'pinned_criteria_missing',
      'evaluation criteria were not pinned before implementation',
      true,
    );
  }
  const expected = input.expectedSha.trim();
  if (!expected) {
    return fail('wrong_revision', 'cycle has no expected merged SHA to verify', true);
  }
  if (input.report?.usedPreview) {
    return fail(
      'preview_is_not_deployment',
      'session preview is not proof of the deployed target',
      false,
    );
  }

  const hub = input.hubEvidence ?? null;
  if (!hub) {
    if (input.report?.healthCheck?.ok) {
      return fail('health_only', 'HTTP health is not sufficient deployed evidence', false);
    }
    return fail(
      'missing_evidence',
      'evaluation has no Hub-bound evidence records for this operation',
      false,
    );
  }

  const targetOrigin = input.targetOrigin.replace(/\/+$/, '');
  const bindOrigin = hub.binding.origin.replace(/\/+$/, '');
  if (targetOrigin && bindOrigin !== targetOrigin) {
    return fail(
      'preview_is_not_deployment',
      `evidence origin ${bindOrigin} is not the experiment target ${targetOrigin}`,
      false,
    );
  }
  if (input.binding) {
    if (hub.binding.operationId !== input.binding.operationId) {
      return fail(
        'missing_evidence',
        'evidence records are not bound to this evaluation operation',
        false,
      );
    }
    if (hub.binding.deploymentId !== input.binding.deploymentId) {
      return fail('missing_evidence', 'evidence records are not bound to this deployment', false);
    }
  }
  if (hub.binding.expectedSha !== expected || hub.binding.observedSha !== expected) {
    return fail(
      'wrong_revision',
      `deployed revision ${hub.binding.observedSha || '(missing)'} does not match expected ${expected}`,
      true,
    );
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const maxAge = input.maxEvidenceAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS;
  const notBeforeMs = parseIsoMs(hub.binding.operationStartedAt);

  const reportById = new Map((input.report?.criteria ?? []).map((c) => [c.criterionId, c]));
  const capturesFor = (id: string) => hub.captures.filter((c) => c.criterionId === id);
  const covered = input.pinned.criteria.filter((c) =>
    capturesFor(c.id).some((cap) =>
      captureCovers(
        c,
        cap,
        targetOrigin,
        nowMs,
        maxAge,
        notBeforeMs,
        input.report?.healthCheck?.url,
      ),
    ),
  );

  if (covered.length === 0) {
    const staleCapture = hub.captures.some((cap) => {
      if (cap.screenshotPresent || cap.tracePresent) {
        if (!hasBothBrowserArtifacts(cap)) return false;
        return !hasFreshBrowserCapture(cap, nowMs, maxAge, notBeforeMs);
      }
      if (cap.apiRequestId) {
        return !hasFreshApiCapture(
          cap,
          targetOrigin,
          nowMs,
          maxAge,
          notBeforeMs,
          input.report?.healthCheck?.url,
        );
      }
      return false;
    });
    if (staleCapture) {
      return fail('stale_evidence', 'Hub capture capturedAt or artifact mtime is stale', false);
    }
    if (hub.captures.length === 0 && input.report?.healthCheck?.ok) {
      return fail('health_only', 'HTTP health is not sufficient deployed evidence', false);
    }
    if (hub.captures.length === 0) {
      return fail('missing_evidence', 'no pinned criterion has Hub-verified captures', false);
    }
  }

  const requestOwners = new Map<string, string>();
  const captureOwners = new Map<string, string>();
  for (const criterion of input.pinned.criteria) {
    const ev = reportById.get(criterion.id);
    if (ev?.claimedWithoutEvidence) {
      return fail(
        'unverifiable_claim',
        `criterion ${criterion.id} is an unverifiable subjective claim`,
        false,
      );
    }
    const matching = capturesFor(criterion.id).find((cap) =>
      captureCovers(
        criterion,
        cap,
        targetOrigin,
        nowMs,
        maxAge,
        notBeforeMs,
        input.report?.healthCheck?.url,
      ),
    );
    if (!matching) {
      const any = capturesFor(criterion.id)[0];
      if (
        criterion.kind === 'browser_journey' &&
        any?.apiCheck &&
        !hasFreshBrowserCapture(any, nowMs, maxAge, notBeforeMs)
      ) {
        return fail(
          'missing_evidence',
          `browser journey ${criterion.id} requires screenshot and trace captures, not an API check`,
          false,
        );
      }
      if (
        criterion.kind === 'browser_journey' &&
        any &&
        (any.screenshotPresent || any.tracePresent) &&
        !hasFreshBrowserCapture(any, nowMs, maxAge, notBeforeMs)
      ) {
        if (!hasBothBrowserArtifacts(any)) {
          return fail(
            'missing_evidence',
            `browser journey ${criterion.id} requires screenshot and trace captures`,
            false,
          );
        }
        return fail(
          'stale_evidence',
          `criterion ${criterion.id} artifact is older than this evaluation`,
          false,
        );
      }
      if (criterion.kind === 'api_check') {
        const targeted = capturesFor(criterion.id).find(
          (cap) =>
            cap.kind === 'api_check' &&
            cap.apiCheck &&
            hasFreshApiCapture(
              cap,
              targetOrigin,
              nowMs,
              maxAge,
              notBeforeMs,
              input.report?.healthCheck?.url,
            ) &&
            apiTargetsCriterion(criterion, cap.apiCheck, targetOrigin),
        );
        if (targeted?.apiCheck) {
          return fail(
            criterionFailureReason(criterion),
            `criterion ${criterion.id} response did not match expected result`,
            true,
          );
        }
        if (ev?.apiCheck && !any?.apiRequestId) {
          return fail(
            'missing_evidence',
            `criterion ${criterion.id} API status was asserted in the report without a Hub-recorded request`,
            false,
          );
        }
      }
      return fail('missing_evidence', `no Hub capture for pinned criterion ${criterion.id}`, false);
    }
    if (matching.captureId) {
      const prevCap = captureOwners.get(matching.captureId);
      if (prevCap && prevCap !== criterion.id) {
        return fail(
          'missing_evidence',
          `criterion ${criterion.id} reused capture ${matching.captureId} from ${prevCap}`,
          false,
        );
      }
      captureOwners.set(matching.captureId, criterion.id);
    }
    if (criterion.kind === 'api_check' && matching.apiRequestId) {
      const prev = requestOwners.get(matching.apiRequestId);
      if (prev && prev !== criterion.id) {
        return fail(
          'missing_evidence',
          `API check for ${criterion.id} reused ${prev}'s request`,
          false,
        );
      }
      requestOwners.set(matching.apiRequestId, criterion.id);
    }
    if (
      ev?.claimedWithoutEvidence ||
      (ev?.observed &&
        SUBJECTIVE.test(ev.observed) &&
        !hasFreshBrowserCapture(matching, nowMs, maxAge, notBeforeMs) &&
        !hasFreshApiCapture(
          matching,
          targetOrigin,
          nowMs,
          maxAge,
          notBeforeMs,
          input.report?.healthCheck?.url,
        ))
    ) {
      return fail(
        'unverifiable_claim',
        `criterion ${criterion.id} is an unverifiable subjective claim`,
        false,
      );
    }
    if (!ev) {
      return fail(
        'missing_evidence',
        `no criterion-level outcome for pinned criterion ${criterion.id}`,
        false,
      );
    }
    if (!ev.passed) {
      return fail(
        criterionFailureReason(criterion),
        `criterion ${criterion.id} failed: ${criterion.action}`,
        true,
      );
    }
  }

  return { ok: true, sha: expected };
}

/** True when a failed judgement should roll back to last-known-good now. */
export function shouldRecoverFromEvaluation(judgement: AutopilotEvaluationJudgement): boolean {
  return judgement.ok === false && judgement.recover;
}

/**
 * Evaluator/Hub capture failures, not product regressions. Re-verify (and
 * redeploy if the merged SHA is not live) instead of re-implementing the
 * same baseline card.
 */
export function isCaptureEvidenceFailure(
  reason: AutopilotEvaluationRejectReason | string,
): boolean {
  return (
    reason === 'missing_evidence' ||
    reason === 'health_only' ||
    reason === 'preview_is_not_deployment' ||
    reason === 'stale_evidence'
  );
}

/**
 * True when the cycle recorded a passing judgement whose SHA and Hub
 * evidence binding match this candidate. Pending or failed evaluation
 * cannot become last-known-good.
 */
export function verificationAllowsLastKnownGood(
  verification: unknown,
  input: { sha: string; deploymentId: string },
): boolean {
  const sha = input.sha.trim();
  const deploymentId = input.deploymentId.trim();
  if (!sha || !deploymentId) return false;
  const parsed = parseCycleVerification(verification);
  const judgement = parsed.judgement;
  const binding = parsed.hubEvidence?.binding;
  if (!judgement?.ok || judgement.sha !== sha) return false;
  if (!binding) return false;
  if (binding.deploymentId !== deploymentId) return false;
  if (binding.expectedSha !== sha || binding.observedSha !== sha) return false;
  return (parsed.hubEvidence?.captures.length ?? 0) > 0;
}
