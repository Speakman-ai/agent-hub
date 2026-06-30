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
  'deployments',
  'replays',
  'security',
]);

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

export function readNavigationStateFromLocation(locationLike?: any): NavigationState | null {
  const loc =
    locationLike ??
    (typeof window !== 'undefined' && window.location ? window.location : undefined);
  if (!loc) return null;
  return parseNavigationHash(loc.hash);
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
