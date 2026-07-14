/**
 * sessionPreviewState — pure helpers for the SessionPreviewPane.
 *
 * The pane is fed by `agenthub_preview` WS events whose shape is defined
 * in `server/preview/preview-block.ts` (`PreviewBroadcastEvent`).  We
 * derive a small, render-friendly state object from the latest event
 * for the active session, and we throttle iframe-activity touches so we
 * never call the runtime more often than once per `intervalMs`.
 *
 * Everything in this file is intentionally framework-free so it can be
 * unit-tested without React.
 */

import { getServerBase } from './connection';

/**
 * Discriminated-union state shape consumed by SessionPreviewPane.
 *
 *   { status: 'idle' }                                  — no event yet
 *   { status: 'starting',       previewId, target, route, agentReason } — block dispatched, runtime spawning
 *   { status: 'ready',  url, port, route, target, previewId, screenshotPath, agentReason }
 *     (`url` = fullUrl || previewUrl — the canonical URL to load in the iframe)
 *   { status: 'failed', error, logTail, previewId, target, route, agentReason }
 *   { status: 'unavailable', reason, wizard, wizardUrl, target, route, agentReason }
 *
 * Callers should switch on `status` for rendering. Unknown / malformed
 * events collapse to `{ status: 'idle' }` so the pane never crashes.
 */
/**
 * Append a cache-buster query param so iframe reloads after agent edits
 * fetch a fresh document even when ng serve HMR did not run yet.
 */
export function previewIframeSrc(url: any, bustToken: any) {
  if (!url || bustToken == null) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('_ah', String(bustToken));
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_ah=${encodeURIComponent(String(bustToken))}`;
  }
}

/**
 * The preview URL is routed through the Hub `/api/sessions/:id/preview/proxy/`
 * mount whenever the server has `publicUrl` set (remote browser
 * deployments). Local dev iframes still load `http://localhost:<port>`
 * directly and don't need an auth ticket.
 *
 * Returns the sessionId encoded in the URL on a hit, or `null` for any
 * non-proxy URL (including local-dev URLs and malformed inputs).
 *
 * Pure helper so the React component can decide whether to mint a
 * ticket without re-implementing the regex.
 */
export function previewProxySessionIdFromUrl(url: any) {
  if (!url || typeof url !== 'string') return null;
  // Path-prefix mode: /api/sessions/<sid>/preview/proxy/...
  let pathname: any;
  try {
    pathname = url.startsWith('/') ? url.split('?')[0] : new URL(url).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/api\/sessions\/([^/]+)\/preview\/proxy(?:\/|$)/);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }
  // Subdomain mode: https://<sid>.preview.<base>/...
  // The session id is the first DNS label (a UUID). Parse it from the
  // hostname so the ticket-mint flow knows which session to POST to.
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const label = host.split('.')[0];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(label)) {
      return label;
    }
  } catch {
    // not a valid URL
  }
  return null;
}

/**
 * Add `?ticket=<ticket>` to a preview-proxy iframe URL. Used by
 * `SessionPreviewPane` after `POST /api/sessions/:id/preview/ticket`
 * returns. Preserves any existing query string (e.g. the cache-buster
 * appended by `previewIframeSrc`).
 */
export function withPreviewTicket(url: any, ticket: any, { origin }: any = {}) {
  if (!url || !ticket) return url;
  try {
    const browsingOrigin = resolvePreviewBrowsingOrigin(origin);
    const u = new URL(url, browsingOrigin ?? undefined);
    u.searchParams.set('ticket', ticket);
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}ticket=${encodeURIComponent(ticket)}`;
  }
}

/**
 * Origin the Hub SPA is using for API calls (same-origin local mode, or
 * configured remote URL). Returns `null` in non-browser test environments
 * when no `origin` override is passed.
 */
export function resolvePreviewBrowsingOrigin(originOverride: any) {
  if (originOverride) return originOverride;
  if (typeof window === 'undefined') return null;
  const base = getServerBase();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      return null;
    }
  }
  return window.location.origin;
}

/**
 * UUID label check for subdomain-mode session ids — mirror of the server-
 * side `SESSION_ID_LABEL_RE` in `server/preview/preview-subdomain-host.ts`.
 * Kept in sync so a session id the server WILL parse out of the Host is
 * the same shape this client builds into the URL. Diverging would mean
 * the iframe loads at a host the server refuses to dispatch.
 */
const SESSION_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the subdomain iframe URL `https://<sid>.<base>/<original-path>`
 * for subdomain-mode previews. Returns `null` when `subdomainBase` is
 * unset (subdomain mode off) or when `sessionId` doesn't match the
 * UUID shape the server requires.
 *
 * The "original-path" is what's after `/api/sessions/<sid>/preview/proxy`
 * in the path-prefix URL — we strip that prefix so the dev server
 * sees `/` (its default base) and emits asset URLs accordingly.
 *
 * Exported for testability; the higher-level `resolvePreviewBrowserUrl`
 * decides whether to call it based on the per-server config.
 */
export function buildSubdomainPreviewUrl(pathPrefixUrl: any, sessionId: any, subdomainBase: any) {
  if (!subdomainBase) return null;
  if (!sessionId || !SESSION_ID_UUID_RE.test(sessionId)) return null;
  const cleanBase = subdomainBase
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!cleanBase) return null;
  let pathname = '/';
  let search = '';
  let hash = '';
  try {
    const u = new URL(pathPrefixUrl, 'https://placeholder.invalid');
    pathname = u.pathname;
    search = u.search;
    hash = u.hash;
  } catch {
    // Relative URL with no base — pull pieces out by hand.
    const [pathPart, rest] = pathPrefixUrl.split('?', 2);
    pathname = pathPart;
    if (rest) {
      const [q, h] = rest.split('#', 2);
      search = `?${q}`;
      if (h) hash = `#${h}`;
    }
  }
  // Strip the path-prefix mount (`/api/sessions/<sid>/preview/proxy`)
  // from the start of the pathname; what remains is what the dev
  // server should see.
  const mountRe = new RegExp(`^/api/sessions/[^/]+/preview/proxy(?=/|$)`);
  const innerPath = pathname.replace(mountRe, '') || '/';
  const normalisedInner = innerPath.startsWith('/') ? innerPath : `/${innerPath}`;
  // Browser scheme: protocols other than https usually mean the
  // operator is testing locally without a wildcard cert; if HTTPS
  // isn't already in use on the parent, subdomain mode won't work
  // anyway (cookie Secure flag, ALB listener), so we hardcode https.
  return `https://${sessionId.toLowerCase()}.${cleanBase}${normalisedInner}${search}${hash}`;
}

/**
 * Turn a Hub preview-proxy URL (relative or absolute) into an absolute URL
 * the iframe should actually load. Two outcomes:
 *
 *   - When `subdomainBase` is set (server has the wildcard cert + Route 53
 *     wired), return the subdomain URL `https://<sid>.<base>/<inner-path>`.
 *     The app sees itself at `/` and every dev-server framework renders
 *     correctly with zero per-app config (Phase 4 of the session-previews
 *     RFC).
 *
 *   - Otherwise, return the same Hub-origin path-prefix URL the server
 *     emitted, normalised to the browsing origin so it works even when
 *     server `publicUrl` doesn't match the host the user loaded the SPA
 *     from. This is the back-compat default.
 */
export function resolvePreviewBrowserUrl(url: any, { origin, subdomainBase }: any = {}) {
  if (!url || typeof url !== 'string') return url;
  const sessionId = previewProxySessionIdFromUrl(url);
  if (!sessionId) return url;

  // Subdomain mode wins when configured. Falls back to path-prefix if
  // the helper refuses to build (non-UUID session id, bad base, etc.).
  if (subdomainBase) {
    const subUrl = buildSubdomainPreviewUrl(url, sessionId, subdomainBase);
    if (subUrl) return subUrl;
  }

  const browsingOrigin = resolvePreviewBrowsingOrigin(origin);
  if (!browsingOrigin) return url;

  try {
    const u = new URL(url, browsingOrigin);
    if (u.origin !== browsingOrigin) {
      return `${browsingOrigin}${u.pathname}${u.search}${u.hash}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Coerce a raw `event.ports` payload into a clean array of preview port
 * entries. Drops anything without a usable `internalPort` + `url` so the
 * selector never renders a broken option. Primary entry is floated first so
 * the default selection matches the pane's primary URL.
 */
export function normalizePreviewPorts(raw: any) {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      internalPort: typeof p.internalPort === 'number' ? p.internalPort : null,
      label: typeof p.label === 'string' && p.label ? p.label : null,
      primary: p.primary === true,
      url: typeof p.url === 'string' ? p.url : '',
    }))
    .filter((p: any) => p.internalPort != null && p.url);
  return cleaned.sort((a: any, b: any) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
}

export function derivePaneState(event: any) {
  if (!event || typeof event !== 'object') return { status: 'idle' };
  const { kind, target, route, agentReason, previewId } = event;
  if (kind === 'preview') {
    const url = event.fullUrl || event.previewUrl || '';
    return {
      status: 'ready',
      url,
      port: typeof event.port === 'number' ? event.port : null,
      // Multi-port dev servers ship a `ports` array (primary first); the pane
      // renders a selector when it has >1 entry. Single-port previews omit it,
      // so this defaults to [] and the pane behaves exactly as before.
      ports: normalizePreviewPorts(event.ports),
      route: route || '/',
      target: target || null,
      previewId: previewId || '',
      screenshotPath: event.screenshotPath || null,
      agentReason: agentReason || '',
      logTail: Array.isArray(event.logTail) ? event.logTail : [],
    };
  }
  if (kind === 'preview_failed') {
    return {
      status: 'failed',
      error: event.error || 'preview failed',
      logTail: Array.isArray(event.logTail) ? event.logTail : [],
      previewId: previewId || '',
      target: target || null,
      route: route || '/',
      agentReason: agentReason || '',
    };
  }
  if (kind === 'preview_unavailable') {
    return {
      status: 'unavailable',
      reason: event.unavailableReason || 'no-pr-env',
      wizard: event.wizard || null,
      wizardUrl: event.wizardUrl || null,
      target: target || null,
      route: route || '/',
      agentReason: agentReason || '',
    };
  }
  // `preview_starting` — emitted by handlePreviewBlock once after spawn
  // and then periodically while the runtime is still booting, each time
  // carrying the current stdout/stderr tail so the pane can render boot
  // output in real time instead of only on success/failure.
  if (kind === 'preview_starting') {
    return {
      status: 'starting',
      previewId: previewId || '',
      target: target || null,
      route: route || '/',
      agentReason: agentReason || '',
      logTail: Array.isArray(event.logTail) ? event.logTail : [],
      previewUrl: event.previewUrl || '',
      port: typeof event.port === 'number' ? event.port : null,
    };
  }
  return { status: 'idle' };
}

/**
 * Build a throttled activity-touch caller. The returned `notify()` invokes
 * `callback()` at most once per `intervalMs`. Subsequent calls within the
 * window are dropped. Test-friendly: pass `now` to override `Date.now`.
 *
 * Why: AC requires touch-on-activity (focus/blur/mousemove) to be
 * debounced to ~30 s so a fast-moving cursor doesn't melt the runtime.
 */
export function createActivityTouch(
  callback: any,
  intervalMs: any = 30_000,
  now: any = () => Date.now(),
) {
  // Start "infinitely far in the past" so the first call always fires
  // regardless of where the caller's clock starts.
  let last = Number.NEGATIVE_INFINITY;
  return function notify() {
    const ts = now();
    if (ts - last < intervalMs) return false;
    last = ts;
    try {
      callback();
    } catch {
      // Touch failures are non-fatal — keep the clock advanced so we
      // don't burst-retry on every mousemove after an error.
    }
    return true;
  };
}

/**
 * localStorage key for the pane open/closed state, scoped per session.
 * Exposed so tests don't have to duplicate the key format.
 */
export function paneOpenStorageKey(sessionId: any) {
  if (!sessionId) return null;
  return `previewPaneOpen:${sessionId}`;
}

/**
 * localStorage key for the pane width (px). The pane is resizable and we
 * persist the user's preferred width across reloads, scoped per session
 * so a wide multi-monitor session doesn't drag a narrow laptop one wider.
 */
export function paneWidthStorageKey(sessionId: any) {
  if (!sessionId) return null;
  return `previewPaneWidth:${sessionId}`;
}

/**
 * localStorage key for the in-session design pane width (px). Scoped per
 * session like the preview pane so each session keeps its own preferred
 * width. `variant` separates the two design surfaces — a linked Design
 * Studio canvas (`'linked'`) vs a design-mode worktree canvas (`'mode'`) —
 * so flipping a session between them doesn't share one width.
 */
export function designPaneWidthStorageKey(sessionId: any, variant = 'linked') {
  if (!sessionId) return null;
  return `designPaneWidth:${variant}:${sessionId}`;
}

/** Default width (px) for the in-session design panes. */
export const DEFAULT_DESIGN_PANE_WIDTH = 520;

/** Minimum width (px) for the in-session design panes. */
export const MIN_DESIGN_PANE_WIDTH = 320;

/**
 * Absolute maximum width (px) for the in-session design panes — the ceiling
 * for the *stored* preference. The rendered/operable width is additionally
 * capped to a fraction of the viewport by `useResizablePaneWidth`, so a width
 * persisted on a wide monitor can't overflow or crush the chat on a narrower
 * laptop/tablet. Keep this as the upper bound; the responsive cap lives in the
 * hook.
 */
export const MAX_DESIGN_PANE_WIDTH = 1200;

/** Best-effort preview id from a stored `agenthub_preview` WS payload. */
export function previewIdFromEvent(event: any) {
  if (!event || typeof event !== 'object') return '';
  const id = event.previewId;
  return typeof id === 'string' ? id : '';
}

/** Drop per-session preview pane prefs from localStorage (archive / delete). */
export function clearSessionPreviewStorage(sessionId: any) {
  if (!sessionId) return;
  try {
    const openKey = paneOpenStorageKey(sessionId);
    const widthKey = paneWidthStorageKey(sessionId);
    if (openKey) window.localStorage.removeItem(openKey);
    if (widthKey) window.localStorage.removeItem(widthKey);
    for (const variant of ['linked', 'mode']) {
      const designKey = designPaneWidthStorageKey(sessionId, variant);
      if (designKey) window.localStorage.removeItem(designKey);
    }
  } catch {
    /* storage unavailable */
  }
}

/**
 * Default pane width in pixels. Used as the `useState` initial value in
 * SessionPreviewPane and as the `fallback` in `clampPaneWidth`, so the two
 * stay in sync from a single source of truth.
 */
export const DEFAULT_PANE_WIDTH = 560;

/**
 * Device-width presets for the preview pane's snap buttons. Each width is the
 * device's CSS (logical) viewport width in portrait, matching the values Chrome
 * DevTools' device toolbar uses. Clicking a preset sets the pane width to the
 * device width (still passed through `clampPaneWidth`, so a preset outside the
 * [min, max] bounds is clamped rather than rejected). Resizing by drag is
 * unaffected — these are just shortcuts to common widths.
 *
 * Single source of truth so the component and its tests don't drift on the
 * exact pixel values.
 */
export const PREVIEW_DEVICE_PRESETS = [
  { id: 'iphone', label: 'iPhone', width: 390 },
  { id: 'ipad-mini', label: 'iPad mini', width: 768 },
  { id: 'ipad', label: 'iPad', width: 820 },
] as const;

export type PreviewDevicePreset = (typeof PREVIEW_DEVICE_PRESETS)[number];

/**
 * Decide whether the SessionPreviewPane should be visible for the active
 * session.
 *
 * Policy (UX rule): the pane is **hidden by default** and only appears
 * once a preview is actually building (status `starting`) or available
 * (status `ready` / `failed` / `unavailable`). A bare session in a
 * preview-capable project no longer pops the pane open with an empty
 * "no app loaded here" placeholder — the user opens it by clicking the
 * Start preview button below the chat, which seeds a synthetic
 * `preview_starting` event into `activePreviewEvent`.
 *
 * Inputs are intentionally primitive so this helper stays unit-testable
 * without touching React:
 *
 *   - `activeSessionId`     — current session id (falsy → hidden).
 *   - `project`             — `activeChatProject` row; we look at
 *                             `project.prEnv.preview.compose.entryService`
 *                             to decide whether the project supports
 *                             previews at all.
 *   - `activePreviewEvent`  — the latest `agenthub_preview` WS payload
 *                             for this session (falsy → hidden).
 *   - `paneOpenBySession`   — the `previewPaneOpenBySession` map; an
 *                             explicit `false` keeps the pane hidden so
 *                             the user's close gesture is honored.
 */
export function shouldShowSessionPreviewPane({
  activeSessionId,
  project,
  activePreviewEvent,
  paneOpenBySession,
}: any = {}) {
  if (!activeSessionId) return false;
  if (!project?.prEnv?.preview?.compose?.entryService) return false;
  if (!activePreviewEvent) return false;
  if (paneOpenBySession && paneOpenBySession[activeSessionId] === false) return false;
  return true;
}

/**
 * REST path (relative to the `/api` base) for the preview-state
 * hydration endpoint. The client calls this to re-request the
 * authoritative preview event for a session when its pane is stuck on
 * `preview_starting` — e.g. a live `ready` WS frame was dropped while
 * the socket stayed open, so no reconnect fired and the WS
 * connect-snapshot never replayed.
 */
export function previewStateApiPath(sessionId: any) {
  return `/sessions/${sessionId}/preview/state`;
}

/**
 * Decide how to reconcile a pane's CURRENT preview event with the
 * authoritative event returned by `GET /preview/state`. The rules are
 * deliberately conservative so hydration only ever *advances* a stuck
 * pane and never fights the live WS event stream:
 *
 *   - Only a pane currently on `preview_starting` is a candidate — a
 *     pane that already advanced (`preview` / `preview_failed` / idle)
 *     is left untouched so we never downgrade fresher live state.
 *   - The fetched event must be terminal (`preview` or `preview_failed`)
 *     to apply. A fetched `preview_starting` carries no advancement, so
 *     we keep the current event (which may hold a fresher live logTail).
 *   - Run identity is resolved by the caller and this reducer together:
 *       · When the current run already has a `previewId` (the real WS
 *         `preview_starting` has landed), require a positive match — a
 *         delayed terminal for an OLDER id is dropped. This covers
 *         WS-driven restarts that don't bump the client start-generation.
 *       · When the current run is the synthetic seed (empty `previewId`,
 *         set on the Start-preview click before any WS frame arrives), we
 *         cannot match by id, so we apply the fetched terminal to let the
 *         pane converge even when the `preview_starting` frame itself was
 *         dropped. The stale-response race for this no-id case is handled
 *         by the CALLER's start-generation guard (it discards a response
 *         issued for a run the user has since restarted away from) — see
 *         the reconcile effect in App.jsx. Without that guard this branch
 *         would be unsafe; with it, the seed converges without reopening
 *         the race.
 *
 * Returns the event that should be stored for the session — either the
 * `fetched` event (when it advances state) or the `current` reference
 * unchanged (so callers can bail without a re-render).
 */
export function reconcilePreviewEvent(current: any, fetched: any) {
  if (!current || current.kind !== 'preview_starting') return current;
  if (!fetched || typeof fetched !== 'object') return current;
  if (fetched.kind !== 'preview' && fetched.kind !== 'preview_failed') return current;
  const curId = current.previewId;
  // Identifiable current run → only a same-id terminal may apply.
  if (curId) return curId === fetched.previewId ? fetched : current;
  // Synthetic seed (no id) → apply; the caller's start-generation guard
  // owns staleness so this can't clobber a newer restart.
  return fetched;
}

/**
 * The synthetic `preview_starting` seed the UI shows between the
 * Start-preview click and the first WS frame. It has no `previewId`
 * because the group id is minted server-side during async boot. Exported
 * so the reconcile path and tests share one definition.
 */
export const SYNTHETIC_PREVIEW_STARTING_SEED = {
  type: 'agenthub_preview',
  kind: 'preview_starting',
  previewId: '',
} as Record<string, any>;

/**
 * Full decision for a `GET /preview/state` hydration response. Folds the
 * start-generation staleness guard together with `reconcilePreviewEvent`
 * so the entire self-heal contract is unit-testable in one pure place —
 * the reconcile effect in App.jsx is then a thin wiring layer.
 *
 * The start-generation (`seqAtRequest` captured before the request,
 * `currentSeq` read at apply time) is the identity signal for the no-id
 * synthetic seed: if the user (re)started the preview while the request
 * was in flight the generation advances and we discard the response, so a
 * terminal event for an older run can never clobber the newer one. When
 * the generation is unchanged the response is authoritative for the run
 * on screen, so `reconcilePreviewEvent` may safely converge the seed.
 *
 * @param {object|null|undefined} currentEvent stored WS event for the
 *   session, or null/undefined when only the synthetic seed exists.
 * @param {boolean} seeded whether the optimistic synthetic seed is set.
 * @param {*} fetched the `event` from `/preview/state` (or null).
 * @param {number} seqAtRequest start generation when the poll was issued.
 * @param {number} currentSeq start generation now (at apply time).
 * @returns {{event: object}|null} the event to store, or null to leave
 *   the session's state unchanged.
 */
export function resolvePreviewHydration({
  currentEvent,
  seeded,
  fetched,
  seqAtRequest,
  currentSeq,
}: any) {
  if (!fetched || typeof fetched !== 'object') return null;
  // Stale: the run the response describes is no longer the one on screen.
  if (seqAtRequest !== currentSeq) return null;
  const current = currentEvent ?? (seeded ? SYNTHETIC_PREVIEW_STARTING_SEED : null);
  const next = reconcilePreviewEvent(current, fetched);
  if (next === current) return null;
  return { event: next };
}

/**
 * Validate a pane width pulled from localStorage. Returns the clamped
 * number on success, or `null` if the input is unusable.
 */
export function clampPaneWidth(
  value: any,
  { min = 320, max = 1400, fallback = DEFAULT_PANE_WIDTH }: any = {},
) {
  // null / undefined / empty-string read out of localStorage means
  // "never persisted" — return the fallback rather than coercing to 0
  // and then clamping up to `min`.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  // Infinity is technically out of bounds — clamp it like any other
  // too-large value so callers using `clampPaneWidth(Infinity, {max})`
  // get the ceiling, not the fallback.
  if (n === Number.POSITIVE_INFINITY) return max;
  if (n === Number.NEGATIVE_INFINITY) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
