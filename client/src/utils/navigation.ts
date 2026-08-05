/**
 * Top-level navigation helpers for the web client.
 *
 * App still owns navigation as `currentView` state, but the active view is
 * mirrored into `location.hash` so refresh and browser back/forward keep the
 * user on the same surface without requiring server catch-all routes.
 */

export const DEFAULT_VIEW = 'dashboard';

const PROJECT_SCOPED_VIEWS = new Set([
  'wiki',
  'notes',
  'reviewer',
  'pulls',
  'threads',
  'support',
  // 'calendar' is intentionally NOT project-scoped: Calendar is a per-user
  // Google surface that lives in the global Dashboard tier (`#/calendar`),
  // never inside a single project. See card 1287 / the Google Workspace spec.
  'deployments',
  'replays',
  'security',
]);

const REMOVED_GLOBAL_VIEWS = new Set(['sheets', 'drive']);

export type NavigationState = {
  view: string;
  projectId?: string | null;
  prNumber?: number | string | null;
  threadId?: string | null;
  designId?: string | null;
  /** Support view only: deep-link a specific ticket to focus on open. */
  ticketId?: string | null;
};

function cleanSegment(value: any) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

function parsePositiveInt(value: any) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitHash(hash: any) {
  const raw = typeof hash === 'string' ? hash.trim() : '';
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
  const withoutSlash = withoutHash.startsWith('/') ? withoutHash.slice(1) : withoutHash;
  if (!withoutSlash) return { path: '', params: new URLSearchParams() };
  const [path, query = ''] = withoutSlash.split('?');
  return { path, params: new URLSearchParams(query) };
}

export function parseNavigationHash(hash?: any): NavigationState | null {
  const { path, params } = splitHash(hash);
  if (!path) return null;

  const segments = path
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  if (segments.length === 0) return null;

  let view = segments[0];
  let projectId: string | null = null;

  if (view === 'view' && segments[1]) {
    view = segments[1];
  } else if (PROJECT_SCOPED_VIEWS.has(view) && segments[1]) {
    projectId = segments[1];
  }
  if (REMOVED_GLOBAL_VIEWS.has(view)) {
    view = DEFAULT_VIEW;
    projectId = null;
  }

  const explicitProject = cleanSegment(params.get('project'));
  if (explicitProject) projectId = explicitProject;

  return {
    view: view || DEFAULT_VIEW,
    projectId,
    prNumber: parsePositiveInt(params.get('pr')),
    threadId: cleanSegment(params.get('thread')),
    designId: cleanSegment(params.get('design')),
    ticketId: cleanSegment(params.get('ticket')),
  };
}

export function buildNavigationHash(state: NavigationState) {
  const view =
    typeof state?.view === 'string' && state.view.trim() !== '' ? state.view.trim() : DEFAULT_VIEW;
  const params = new URLSearchParams();

  const projectId = cleanSegment(state?.projectId);
  let path = '';
  if (PROJECT_SCOPED_VIEWS.has(view) && projectId) {
    path = `/${encodeURIComponent(view)}/${encodeURIComponent(projectId)}`;
  } else if (view !== DEFAULT_VIEW) {
    path = `/${encodeURIComponent(view)}`;
  }

  const prNumber = parsePositiveInt(state?.prNumber);
  if (view === 'pulls' && prNumber) params.set('pr', String(prNumber));
  const threadId = cleanSegment(state?.threadId);
  if (view === 'threads' && threadId) params.set('thread', threadId);
  const designId = cleanSegment(state?.designId);
  if (view === 'design' && designId) params.set('design', designId);
  const ticketId = cleanSegment(state?.ticketId);
  if (view === 'support' && ticketId) params.set('ticket', ticketId);

  const query = params.toString();
  if (!path && !query) return '';
  return `#${path || `/${encodeURIComponent(view)}`}${query ? `?${query}` : ''}`;
}

/**
 * Parse a *path*-shaped deep link: `/projects/<projectId>/<view>[/<prNumber>]`.
 *
 * The app routes on the hash, but people share and bookmark path URLs (the
 * shape GitHub uses), and the server's SPA catch-all happily serves them. So a
 * pasted `/projects/acme/pulls/306` has to resolve to the same place as
 * `#/pulls/acme?pr=306` instead of silently dumping the user on the dashboard.
 *
 * `basePath` is whatever precedes `/projects` (a deployment path prefix, if
 * any) so the caller can rewrite the URL to the canonical hash form without
 * losing the prefix.
 */
export function parseNavigationPath(
  pathname?: any,
): { state: NavigationState; basePath: string } | null {
  const raw = typeof pathname === 'string' ? pathname.trim() : '';
  if (!raw) return null;
  const parts = raw.split('/');
  // Last occurrence: a prefix could itself be named "projects".
  const anchor = parts.lastIndexOf('projects');
  if (anchor === -1) return null;

  const segments = parts
    .slice(anchor + 1)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const [projectId, view, extra] = segments;
  if (!projectId || !view || !PROJECT_SCOPED_VIEWS.has(view)) return null;

  const basePath = parts.slice(0, anchor).join('/');
  return {
    state: {
      view,
      projectId,
      prNumber: view === 'pulls' ? parsePositiveInt(extra) : null,
    },
    basePath,
  };
}

export function readNavigationStateFromLocation(locationLike?: any): NavigationState | null {
  const loc =
    locationLike ??
    (typeof window !== 'undefined' && window.location ? window.location : undefined);
  if (!loc) return null;
  const fromHash = parseNavigationHash(loc.hash);
  const fromPath = parseNavigationPath(loc.pathname)?.state ?? null;
  if (!fromHash) return fromPath;
  // The hash is canonical, but a path deep-link can still supply a PR number
  // the hash lacks — that is exactly the `/projects/x/pulls/306#/pulls/x` URL
  // older builds produced when they appended a hash to a pasted path link.
  if (
    fromPath &&
    !fromHash.prNumber &&
    fromPath.prNumber &&
    fromHash.view === fromPath.view &&
    fromHash.projectId === fromPath.projectId
  ) {
    return { ...fromHash, prNumber: fromPath.prNumber };
  }
  return fromHash;
}

/**
 * Resolve the initial top-level view at mount time.
 *
 * @param {string} [requested] an explicit view to honor. Any non-empty string
 *   wins; otherwise we fall back to the URL hash, then the default home view.
 * @returns {string}
 */
export function getInitialView(requested?: any) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    return requested;
  }
  const route = readNavigationStateFromLocation();
  if (route?.view) return route.view;
  return DEFAULT_VIEW;
}

export function getInitialNavigation(requested?: any): NavigationState {
  if (typeof requested === 'string' && requested.trim() !== '') {
    return { view: requested };
  }
  return readNavigationStateFromLocation() ?? { view: DEFAULT_VIEW };
}
