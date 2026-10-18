/**
 * Display helpers for PR environment share links, used by the web PR page and
 * the mobile PR screen.
 */

export interface PrEnvironmentShareLink {
  id: string;
  projectId: string;
  prNumber: number;
  label: string | null;
  url: string | null;
  status: 'active' | 'expired' | 'revoked';
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** Server-computed: active and the caller may revoke it. */
  canRevoke: boolean;
}

export interface PrEnvironmentShareList {
  links: PrEnvironmentShareLink[];
  passwordRequired: boolean;
  /** Absent on older servers; null for custom passwords or an explicitly disabled guard. */
  generatedPassword?: string | null;
  canManage: boolean;
  canSetPassword: boolean;
}

/**
 * Error codes the share-link routes send when share links cannot exist for
 * this PR at all (no wildcard ingress, or not an Agent Hub-hosted project).
 * Every other failure is transient as far as the UI is concerned.
 */
export const SHARE_UNSUPPORTED_CODES = {
  ingressNotConfigured: 'pr_env_ingress_not_configured',
  notHosted: 'pr_env_not_hosted',
} as const;

/** How the share panel should treat a failed list request. */
export function classifyShareListError(err: unknown): 'unsupported' | 'transient' {
  const code = (err as { code?: unknown } | null)?.code;
  return code === SHARE_UNSUPPORTED_CODES.ingressNotConfigured ||
    code === SHARE_UNSUPPORTED_CODES.notHosted
    ? 'unsupported'
    : 'transient';
}

/** Delay before the panel retries a failed list on its own. */
export const SHARE_LIST_RETRY_MS = 15_000;

/** Expiry choices offered when creating a link. */
export const SHARE_LINK_EXPIRY_OPTIONS: ReadonlyArray<{ label: string; hours: number }> = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
];

export const DEFAULT_SHARE_LINK_HOURS = 24 * 7;

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** "expires in 6 days", "expired", "revoked". */
export function shareLinkStatusLabel(
  link: PrEnvironmentShareLink,
  now: number = Date.now(),
): string {
  if (link.status === 'revoked') return 'revoked';
  const left = new Date(link.expiresAt).getTime() - now;
  if (link.status === 'expired' || left <= 0) return 'expired';
  return `expires in ${span(left)}`;
}

/** Active links first (soonest expiry last), then the rest by creation, newest first. */
export function sortShareLinks(links: PrEnvironmentShareLink[]): PrEnvironmentShareLink[] {
  const rank = (l: PrEnvironmentShareLink) => (l.status === 'active' ? 0 : 1);
  return [...links].sort(
    (a, b) =>
      rank(a) - rank(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Identity of the PR a panel is showing; async results for another PR are ignored. */
export function sharePanelKey(projectId: string, prNumber: number): string {
  return `${projectId}#${prNumber}`;
}

/**
 * Load state for the share panel, shared by web and mobile.
 *
 * Every action names the PR it belongs to (`key`, see `sharePanelKey`) and
 * the request it answers (`seq`, caller-issued and increasing). The reducer
 * ignores an action for a PR other than the one shown (a load or a
 * mutation's reload that finishes after the user switched PRs) and a
 * response to an older request for the same PR.
 *
 * - `unsupported`: the server said share links cannot exist here (tagged
 *   code). The panel hides; nothing to retry.
 * - `error`: any other failure. Data from an earlier load is kept so a blip
 *   does not wipe the list; the panel shows the error with a retry and
 *   retries on its own.
 * - `inFlight`: a request for the shown PR has started and not settled. The
 *   automatic retry is scheduled only after it settles (`shouldScheduleShareRetry`)
 *   and manual Retry is disabled meanwhile, so a slow request is never
 *   superseded by a retry and then discarded as stale.
 */
export interface ShareListState {
  key: string | null;
  status: 'loading' | 'ready' | 'unsupported' | 'error';
  data: PrEnvironmentShareList | null;
  error: string | null;
  seq: number;
  inFlight: boolean;
}

export type ShareListAction =
  | { type: 'reset'; key: string; seq: number }
  | { type: 'start'; key: string; seq: number }
  | { type: 'loaded'; key: string; seq: number; data: PrEnvironmentShareList }
  | { type: 'failed'; key: string; seq: number; error: unknown };

export const initialShareListState: ShareListState = {
  key: null,
  status: 'loading',
  data: null,
  error: null,
  seq: 0,
  inFlight: false,
};

export function shareListReducer(state: ShareListState, action: ShareListAction): ShareListState {
  if (action.type === 'reset') {
    return { ...initialShareListState, key: action.key, seq: action.seq };
  }
  if (action.key !== state.key) return state;
  switch (action.type) {
    case 'start':
      return {
        ...state,
        seq: action.seq,
        inFlight: true,
        status: state.data ? state.status : 'loading',
      };
    case 'loaded':
      if (action.seq !== state.seq) return state;
      return { ...state, status: 'ready', data: action.data, error: null, inFlight: false };
    case 'failed': {
      if (action.seq !== state.seq) return state;
      if (classifyShareListError(action.error) === 'unsupported') {
        return { ...state, status: 'unsupported', data: null, error: null, inFlight: false };
      }
      const message =
        action.error instanceof Error && action.error.message
          ? action.error.message
          : 'Could not load share links';
      return { ...state, status: 'error', error: message, inFlight: false };
    }
  }
}

/** Whether to arm the automatic retry: the last request failed and none is pending. */
export function shouldScheduleShareRetry(state: ShareListState): boolean {
  return state.status === 'error' && !state.inFlight;
}

/**
 * Where "Open environment" should go. With wildcard ingress the environment
 * is private, so the member ticket URL is the only one that works; the plain
 * URL is used only when the server says access links do not apply here
 * (tagged unsupported code). Any other failure is reported, since opening
 * the plain URL would just land on the access page.
 */
export async function resolvePrEnvironmentOpenUrl(
  fetchAccess: () => Promise<{ url?: string | null } | null | undefined>,
  plainUrl: string,
): Promise<{ url: string } | { error: string }> {
  try {
    const res = await fetchAccess();
    if (res?.url) return { url: res.url };
    return { error: 'The server did not return an access link.' };
  } catch (err) {
    if (classifyShareListError(err) === 'unsupported') return { url: plainUrl };
    return {
      error:
        err instanceof Error && err.message ? err.message : 'Could not open the PR environment.',
    };
  }
}
