/**
 * Sign-in handoff: the agent's `browser` op `request_login` parks the turn
 * until the human signs in through the Agent browser pane and clicks Done
 * (or Cancel), the wait times out, or the user stops the turn.
 *
 * Agents never see passwords, 2FA codes or payment details; the human types
 * them straight into the live Chromium. State is in memory on purpose: a
 * pending request is only meaningful while the turn awaiting it is alive, and
 * a Hub restart kills that turn anyway.
 */

import { randomUUID } from 'node:crypto';

/** How long a turn waits for the human before giving up. */
export const BROWSER_LOGIN_HANDOFF_TIMEOUT_MS = 15 * 60 * 1000;
export const BROWSER_LOGIN_DOMAIN_MAX_CHARS = 253;
export const BROWSER_LOGIN_REASON_MAX_CHARS = 500;

export type BrowserLoginOutcome = 'done' | 'cancelled' | 'timeout' | 'aborted';

/** What the pane and notifications see. */
export interface BrowserLoginRequest {
  requestId: string;
  sessionId: string;
  domain: string;
  reason: string;
  requestedAt: number;
  expiresAt: number;
}

export interface BrowserLoginResolution {
  outcome: BrowserLoginOutcome;
  /** Why an `aborted` wait ended (Stop, browser closed, superseded). */
  detail?: string;
}

export type BrowserLoginHandoffEvent =
  | { type: 'requested'; request: BrowserLoginRequest }
  | { type: 'resolved'; request: BrowserLoginRequest; resolution: BrowserLoginResolution };

interface Pending {
  request: BrowserLoginRequest;
  settle: (r: BrowserLoginResolution) => void;
  timer: NodeJS.Timeout;
}

const pendingBySession = new Map<string, Pending>();
const listeners = new Set<(ev: BrowserLoginHandoffEvent) => void>();

function emit(ev: BrowserLoginHandoffEvent): void {
  for (const l of Array.from(listeners)) {
    try {
      l(ev);
    } catch (err) {
      console.warn(`[browser-login] listener failed: ${String(err)}`);
    }
  }
}

/** Observe requests opening and closing (pane WebSocket, tests). */
export function subscribeBrowserLoginHandoffs(
  listener: (ev: BrowserLoginHandoffEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reduce what the agent passed to a bare hostname. Accepts `example.com`,
 * `https://example.com/login` or `example.com/path`. Returns null for
 * anything that is not a plausible hostname.
 */
export function normalizeBrowserLoginDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > BROWSER_LOGIN_DOMAIN_MAX_CHARS + 16) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > BROWSER_LOGIN_DOMAIN_MAX_CHARS) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null;
  return host;
}

export function getPendingBrowserLogin(sessionId: string): BrowserLoginRequest | null {
  return pendingBySession.get(sessionId)?.request ?? null;
}

export interface RequestBrowserLoginOptions {
  timeoutMs?: number;
  /** Called once the request is registered, before waiting. */
  onRequested?: (request: BrowserLoginRequest) => void;
}

/**
 * Register a sign-in request for `sessionId` and wait for it to settle. A
 * session has at most one open request; a new one aborts the previous wait.
 */
export function requestBrowserLogin(
  sessionId: string,
  input: { domain: string; reason?: string },
  opts: RequestBrowserLoginOptions = {},
): { request: BrowserLoginRequest; settled: Promise<BrowserLoginResolution> } {
  settleBrowserLogin(sessionId, { outcome: 'aborted', detail: 'superseded' });

  const timeoutMs = Math.max(1, opts.timeoutMs ?? BROWSER_LOGIN_HANDOFF_TIMEOUT_MS);
  const now = Date.now();
  const request: BrowserLoginRequest = {
    requestId: randomUUID(),
    sessionId,
    domain: input.domain,
    reason: (input.reason ?? '').trim().slice(0, BROWSER_LOGIN_REASON_MAX_CHARS),
    requestedAt: now,
    expiresAt: now + timeoutMs,
  };

  let settle!: (r: BrowserLoginResolution) => void;
  const settled = new Promise<BrowserLoginResolution>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => {
    settleBrowserLogin(sessionId, { outcome: 'timeout' }, request.requestId);
  }, timeoutMs);
  timer.unref?.();
  pendingBySession.set(sessionId, { request, settle, timer });

  emit({ type: 'requested', request });
  try {
    opts.onRequested?.(request);
  } catch (err) {
    console.warn(`[browser-login] onRequested failed: ${String(err)}`);
  }
  return { request, settled };
}

/**
 * Settle the open request for `sessionId`. When `requestId` is given it must
 * match, so a stale Done from a pane that missed an update cannot resolve a
 * newer request. Returns false when nothing was pending (or the id mismatched).
 */
export function settleBrowserLogin(
  sessionId: string,
  resolution: BrowserLoginResolution,
  requestId?: string,
): boolean {
  const p = pendingBySession.get(sessionId);
  if (!p) return false;
  if (requestId && p.request.requestId !== requestId) return false;
  pendingBySession.delete(sessionId);
  clearTimeout(p.timer);
  p.settle(resolution);
  emit({ type: 'resolved', request: p.request, resolution });
  return true;
}

/** Stop / browser close: end any wait without the human's answer. */
export function abortBrowserLogin(sessionId: string, detail: string): boolean {
  return settleBrowserLogin(sessionId, { outcome: 'aborted', detail });
}

/** Test-only. */
export function __resetBrowserLoginHandoffsForTests(): void {
  for (const id of Array.from(pendingBySession.keys())) {
    abortBrowserLogin(id, 'reset');
  }
  listeners.clear();
}
