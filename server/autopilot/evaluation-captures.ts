/**
 * Hub-owned Autopilot evaluation captures. Written when the evaluator worker
 * actually takes a screenshot (and a Hub-bound journey trace) or Hub records
 * an HTTP response for a pinned API criterion — never copied from the
 * assistant JSON report. Browser traces are the recorded interaction sequence
 * for this operation, not a final-page snapshot. API probes leave
 * screenshot/trace empty on purpose.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import path from 'path';
import {
  apiOriginMatches,
  apiRequestFromJourney,
  AUTOPILOT_API_BODY_MAX_CHARS,
  AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
  bindExecutionCapture,
  boundApiResponseBody,
  clipApiBodyExcerpt,
  fileIsEvaluatorJourneyTrace,
  isEvaluatorJourneyTrace,
  pinApiRequest,
  type AutopilotEvaluatorBrowserAction,
  type AutopilotExecutionCapture,
  type AutopilotPinnedCriterion,
  type AutopilotRecordedApiResponse,
} from './evaluate.js';
import type { AutopilotSessionWorkerBinding } from './worker-token.js';

const CAPTURE_SUBDIR = 'autopilot-eval-captures';
const ID_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const AUTOPILOT_EVAL_BROWSER_ACTION_MAX = 200;

export { AUTOPILOT_EVAL_BROWSER_TRACE_KIND };

/** Deadline covering headers and body for a Hub API probe. */
export const AUTOPILOT_API_PROBE_TIMEOUT_MS = 8_000;
/** Same-origin hops only; cross-origin Location is never followed. */
export const AUTOPILOT_API_PROBE_MAX_REDIRECTS = 5;

function assertSafeId(id: string, label: string): void {
  if (!ID_REGEX.test(id)) {
    throw new Error(`autopilot-eval-captures: invalid ${label} ${JSON.stringify(id)}`);
  }
}

function captureFile(dataDir: string, operationId: string): string {
  assertSafeId(operationId, 'operationId');
  return path.join(dataDir, CAPTURE_SUBDIR, `${operationId}.json`);
}

function actionFile(dataDir: string, operationId: string): string {
  assertSafeId(operationId, 'operationId');
  return path.join(dataDir, CAPTURE_SUBDIR, `${operationId}.actions.json`);
}

function atomicWrite(filePath: string, dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600, encoding: 'utf8' });
  renameSync(tmp, filePath);
}

export function listEvaluationCaptures(
  dataDir: string,
  operationId: string,
): AutopilotExecutionCapture[] {
  if (!dataDir || !operationId.trim()) return [];
  let raw: string;
  try {
    raw = readFileSync(captureFile(dataDir, operationId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AutopilotExecutionCapture[] = [];
  for (const row of parsed) {
    const bound = bindExecutionCapture(row as AutopilotExecutionCapture);
    if (bound) out.push(bound);
  }
  return out;
}

export function appendEvaluationCapture(
  dataDir: string,
  capture: AutopilotExecutionCapture,
): AutopilotExecutionCapture | null {
  const bound = bindExecutionCapture(capture);
  if (!bound) return null;
  const existing = listEvaluationCaptures(dataDir, bound.operationId);
  if (existing.some((c) => c.captureId === bound.captureId)) return bound;
  existing.push(bound);
  const filePath = captureFile(dataDir, bound.operationId);
  atomicWrite(filePath, path.dirname(filePath), JSON.stringify(existing));
  return bound;
}

export interface AutopilotEvaluatorBrowserPage {
  url: string;
  title: string;
  textExcerpt: string;
}

/** Hub-owned browser trace: provenance plus the recorded interaction sequence. */
export interface AutopilotEvaluatorBrowserTrace {
  kind: typeof AUTOPILOT_EVAL_BROWSER_TRACE_KIND;
  operationId: string;
  deploymentId: string;
  expectedSha: string;
  origin: string;
  capturedAt: string;
  screenshotPath: string | null;
  page: AutopilotEvaluatorBrowserPage;
  actions: AutopilotEvaluatorBrowserAction[];
}

export interface RecordEvaluatorBrowserCaptureInput {
  dataDir: string;
  binding: AutopilotSessionWorkerBinding;
  operationId: string;
  deploymentId: string;
  expectedSha: string;
  screenshotPath?: string | null;
  /** Pre-written Hub journey trace. Snapshots and other non-journey files are ignored. */
  tracePath?: string | null;
  page?: AutopilotEvaluatorBrowserPage | null;
  actions?: AutopilotEvaluatorBrowserAction[] | null;
  criterionId?: string | null;
  capturedAt?: string;
}

function statCaptureArtifact(filePath: string | undefined | null): {
  path: string;
  mtimeMs: number;
} | null {
  const trimmed = (filePath ?? '').trim();
  if (!trimmed) return null;
  try {
    return { path: trimmed, mtimeMs: statSync(trimmed).mtimeMs };
  } catch {
    return null;
  }
}

function normalizeEvaluatorPage(
  page: AutopilotEvaluatorBrowserPage | null | undefined,
): AutopilotEvaluatorBrowserPage {
  return {
    url: typeof page?.url === 'string' ? page.url : '',
    title: typeof page?.title === 'string' ? page.title : '',
    textExcerpt: typeof page?.textExcerpt === 'string' ? page.textExcerpt : '',
  };
}

function normalizeEvaluatorAction(
  raw: AutopilotEvaluatorBrowserAction | null | undefined,
): AutopilotEvaluatorBrowserAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const op = typeof raw.op === 'string' ? raw.op.trim() : '';
  const at = typeof raw.at === 'string' ? raw.at.trim() : '';
  if (!op || !at || typeof raw.ok !== 'boolean') return null;
  const action: AutopilotEvaluatorBrowserAction = { op, at, ok: raw.ok };
  if (typeof raw.url === 'string' && raw.url.trim()) action.url = raw.url.trim();
  if (typeof raw.target === 'string' && raw.target.trim()) action.target = raw.target.trim();
  return action;
}

function normalizeEvaluatorActions(
  raw: AutopilotEvaluatorBrowserAction[] | null | undefined,
): AutopilotEvaluatorBrowserAction[] {
  if (!Array.isArray(raw)) return [];
  const out: AutopilotEvaluatorBrowserAction[] = [];
  for (const row of raw) {
    const action = normalizeEvaluatorAction(row);
    if (action) out.push(action);
  }
  return out.slice(-AUTOPILOT_EVAL_BROWSER_ACTION_MAX);
}

/** Record one evaluator browser op so a later screenshot can persist the journey. */
export function appendEvaluatorBrowserAction(
  dataDir: string,
  operationId: string,
  action: AutopilotEvaluatorBrowserAction,
): AutopilotEvaluatorBrowserAction | null {
  const normalized = normalizeEvaluatorAction(action);
  if (!dataDir || !operationId.trim() || !normalized) return null;
  try {
    assertSafeId(operationId, 'operationId');
  } catch {
    return null;
  }
  const existing = listEvaluatorBrowserActions(dataDir, operationId);
  existing.push(normalized);
  const kept = existing.slice(-AUTOPILOT_EVAL_BROWSER_ACTION_MAX);
  const filePath = actionFile(dataDir, operationId);
  atomicWrite(filePath, path.dirname(filePath), JSON.stringify(kept));
  return normalized;
}

export function listEvaluatorBrowserActions(
  dataDir: string,
  operationId: string,
): AutopilotEvaluatorBrowserAction[] {
  if (!dataDir || !operationId.trim()) return [];
  let filePath: string;
  try {
    filePath = actionFile(dataDir, operationId);
  } catch {
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return normalizeEvaluatorActions(parsed as AutopilotEvaluatorBrowserAction[]);
}

/** Persist a Hub-owned journey trace (interaction sequence, not a page snapshot). */
export function writeEvaluatorBrowserTrace(
  dataDir: string,
  trace: Omit<AutopilotEvaluatorBrowserTrace, 'kind'>,
): { path: string; mtimeMs: number } | null {
  const operationId = trace.operationId.trim();
  if (!dataDir || !operationId) return null;
  try {
    assertSafeId(operationId, 'operationId');
  } catch {
    return null;
  }
  const record: AutopilotEvaluatorBrowserTrace = {
    kind: AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
    operationId,
    deploymentId: trace.deploymentId.trim(),
    expectedSha: trace.expectedSha.trim(),
    origin: trace.origin.replace(/\/+$/, ''),
    capturedAt: trace.capturedAt,
    screenshotPath: trace.screenshotPath?.trim() || null,
    page: normalizeEvaluatorPage(trace.page),
    actions: normalizeEvaluatorActions(trace.actions),
  };
  if (!isEvaluatorJourneyTrace(record)) return null;
  const dir = path.join(dataDir, CAPTURE_SUBDIR);
  const filePath = path.join(dir, `${operationId}.${randomUUID()}.trace.json`);
  try {
    atomicWrite(filePath, dir, JSON.stringify(record));
    return { path: filePath, mtimeMs: statSync(filePath).mtimeMs };
  } catch {
    return null;
  }
}

/** Record screenshot and Hub-owned journey trace the evaluator session just produced. */
export function recordEvaluatorBrowserCapture(
  input: RecordEvaluatorBrowserCaptureInput,
): AutopilotExecutionCapture | null {
  if (input.binding.role !== 'evaluator') return null;
  const origin = (input.binding.origin ?? '').replace(/\/+$/, '');
  const operationId = input.operationId.trim();
  const deploymentId = input.deploymentId.trim();
  const expectedSha = input.expectedSha.trim();
  if (!origin || !operationId || !deploymentId || !expectedSha) return null;
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const screenshot = statCaptureArtifact(input.screenshotPath);
  const suppliedActions = normalizeEvaluatorActions(input.actions);
  const actions = suppliedActions.length
    ? suppliedActions
    : listEvaluatorBrowserActions(input.dataDir, operationId);
  const existingTrace = statCaptureArtifact(input.tracePath);
  const existingJourney = existingTrace && fileIsEvaluatorJourneyTrace(existingTrace.path);
  const trace = existingJourney
    ? existingTrace
    : writeEvaluatorBrowserTrace(input.dataDir, {
        operationId,
        deploymentId,
        expectedSha,
        origin,
        capturedAt,
        screenshotPath: screenshot?.path ?? null,
        page: normalizeEvaluatorPage(input.page),
        actions,
      });
  if (!screenshot && !trace) return null;
  return appendEvaluationCapture(input.dataDir, {
    captureId: randomUUID(),
    criterionId: input.criterionId?.trim() || 'unassigned',
    kind: 'browser_journey',
    capturedAt,
    operationId,
    deploymentId,
    expectedSha,
    origin,
    screenshot,
    trace,
    api: null,
  });
}

/** Observation trailer so an evaluator can cite Hub-owned paths instead of inventing them. */
export function formatAutopilotCaptureCitation(
  capture: {
    screenshot?: { path: string } | null;
    trace?: { path: string } | null;
  } | null,
): string {
  if (!capture) return '';
  const shot = capture.screenshot?.path?.trim() || '';
  const trace = capture.trace?.path?.trim() || '';
  if (!shot && !trace) return '';
  return [
    'Hub recorded this browser step. Cite these exact paths on the matching criterion:',
    `screenshotPath: ${shot || '(none)'}`,
    `tracePath: ${trace || '(none)'}`,
  ].join('\n');
}

export function apiTargetFromCriterion(
  origin: string,
  criterion: AutopilotPinnedCriterion,
): { method: string; url: string } | null {
  return apiRequestFromJourney(origin, criterion);
}

export interface ProbePinnedApiInput {
  operationId: string;
  deploymentId: string;
  expectedSha: string;
  origin: string;
  criterion: AutopilotPinnedCriterion;
  capturedAt?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxBodyChars?: number;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject);
    });
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function responseUrl(res: Response, requestUrl: string): string {
  const raw = typeof res.url === 'string' ? res.url.trim() : '';
  return raw || requestUrl;
}

/** Start cancel; never await it — a hanging cancel() must not hold the probe. */
function abandonPending(pending: Promise<unknown> | undefined | null): void {
  if (pending) void pending.catch(() => undefined);
}

function abandonResponseBody(res: Response | null | undefined): void {
  try {
    abandonPending(res?.body?.cancel());
  } catch {
    /* already closed */
  }
}

function abandonReader(reader: { cancel(): Promise<unknown> }): void {
  try {
    abandonPending(reader.cancel());
  } catch {
    /* already closed */
  }
}

/**
 * Read a live response with a hard size cap and abort. Cancels the stream on
 * overflow without waiting for the source cancel callback to settle.
 */
export async function readResponseTextBounded(
  res: Response,
  options: { maxChars: number; signal: AbortSignal },
): Promise<{ body: string; bodyComplete: boolean; bodyExcerpt: string }> {
  const { maxChars, signal } = options;
  const reader = res.body?.getReader();
  if (!reader) return boundApiResponseBody('');
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (true) {
      if (signal.aborted) {
        abandonReader(reader);
        throw abortError();
      }
      const chunk = await awaitWithAbort(reader.read(), signal);
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
      if (body.length > maxChars) {
        abandonReader(reader);
        const clipped = body.slice(0, maxChars);
        return {
          body: clipped,
          bodyComplete: false,
          bodyExcerpt: clipApiBodyExcerpt(clipped),
        };
      }
    }
    body += decoder.decode();
    return boundApiResponseBody(body);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* cancelled */
    }
  }
}

function redirectTarget(
  location: string | null,
  fromUrl: string,
  pinnedOrigin: string,
): string | null {
  if (!location?.trim()) return null;
  let next: URL;
  try {
    next = new URL(location, fromUrl);
  } catch {
    return null;
  }
  if (!apiOriginMatches(next.href, pinnedOrigin)) return null;
  return next.href;
}

/**
 * Fetch HTTP-redirect fetch step 12: only POST becomes GET on 301/302;
 * 303 rewrites methods other than GET/HEAD; 307/308 never change the method.
 * https://fetch.spec.whatwg.org/#http-redirect-fetch
 */
export function methodAfterRedirect(status: number, method: string): string {
  const current = method.toUpperCase();
  if ((status === 301 || status === 302) && current === 'POST') return 'GET';
  if (status === 303 && current !== 'GET' && current !== 'HEAD') return 'GET';
  return current;
}

/** Fetch request-body-header names stripped when a redirect rewrites the method. */
const REQUEST_BODY_HEADER_NAMES = new Set([
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
]);

export interface AutopilotProbeRequest {
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** Apply Fetch method rewrite plus body/header removal as one request mutation. */
export function applyRedirectToRequest(
  status: number,
  request: AutopilotProbeRequest,
): AutopilotProbeRequest {
  const method = methodAfterRedirect(status, request.method);
  if (method === request.method.toUpperCase()) {
    return { method, body: request.body, headers: { ...request.headers } };
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (REQUEST_BODY_HEADER_NAMES.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return { method, headers };
}

function pinnedProbeRequest(
  criterion: AutopilotPinnedCriterion,
  method: string,
): AutopilotProbeRequest {
  const pinned =
    criterion.apiRequest ??
    pinApiRequest({ action: criterion.action, expectedResult: criterion.expectedResult });
  return {
    method: (pinned?.method ?? method).toUpperCase(),
    body: pinned?.body,
    headers: { ...(pinned?.headers ?? {}) },
  };
}

function probeFetchInit(request: AutopilotProbeRequest, signal: AbortSignal): RequestInit {
  const init: RequestInit = {
    method: request.method,
    redirect: 'manual',
    signal,
  };
  if (Object.keys(request.headers).length > 0) init.headers = request.headers;
  if (request.body != null && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }
  return init;
}

/**
 * Hub-executed API probe bound to this evaluate operation. The live session is
 * pinned to the deployment origin: redirects are inspected before follow,
 * the body is read under a size cap, and the whole exchange has a deadline
 * that includes teardown — stream cancel is never awaited. Never copies
 * status/body from the evaluator report.
 */
export async function probePinnedApiCriterion(
  input: ProbePinnedApiInput,
): Promise<AutopilotExecutionCapture | null> {
  if (input.criterion.kind !== 'api_check') return null;
  const target = apiTargetFromCriterion(input.origin, input.criterion);
  if (!target) return null;
  const pinnedOrigin = input.origin.replace(/\/+$/, '');
  if (!apiOriginMatches(target.url, pinnedOrigin)) return null;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? AUTOPILOT_API_PROBE_TIMEOUT_MS;
  const maxBodyChars = input.maxBodyChars ?? AUTOPILOT_API_BODY_MAX_CHARS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await awaitWithAbort(
      (async () => {
        let url = target.url;
        let request = pinnedProbeRequest(input.criterion, target.method);
        let res: Response | null = null;
        let actualUrl = target.url;
        for (let hop = 0; hop <= AUTOPILOT_API_PROBE_MAX_REDIRECTS; hop++) {
          if (!apiOriginMatches(url, pinnedOrigin)) return null;
          res = await awaitWithAbort(
            Promise.resolve(fetchImpl(url, probeFetchInit(request, ac.signal))),
            ac.signal,
          );
          actualUrl = responseUrl(res, url);
          if (!apiOriginMatches(actualUrl, pinnedOrigin)) {
            abandonResponseBody(res);
            return null;
          }
          if (!REDIRECT_STATUS.has(res.status)) break;
          const next = redirectTarget(res.headers.get('location'), actualUrl, pinnedOrigin);
          abandonResponseBody(res);
          if (!next) return null;
          request = applyRedirectToRequest(res.status, request);
          url = next;
          res = null;
        }
        if (!res || REDIRECT_STATUS.has(res.status)) {
          abandonResponseBody(res);
          return null;
        }
        const recordedBody = await readResponseTextBounded(res, {
          maxChars: maxBodyChars,
          signal: ac.signal,
        });
        const api: AutopilotRecordedApiResponse = {
          requestId: randomUUID(),
          method: request.method,
          url: actualUrl,
          status: res.status,
          ...recordedBody,
        };
        return bindExecutionCapture({
          captureId: randomUUID(),
          criterionId: input.criterion.id,
          kind: 'api_check',
          capturedAt: input.capturedAt ?? new Date().toISOString(),
          operationId: input.operationId,
          deploymentId: input.deploymentId,
          expectedSha: input.expectedSha,
          origin: pinnedOrigin,
          screenshot: null,
          trace: null,
          api,
        });
      })(),
      ac.signal,
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
