/**
 * Pure helpers for the login-screen server picker (desktop and mobile).
 *
 * The login page is the only UI a user can reach when they hold no password
 * for the org the app points at, so both clients let the user swap orgs or
 * edit the server URL from there. These helpers decide what the picker shows
 * and when stored credentials must be dropped; the components wire them to
 * each platform's org storage.
 */

export interface LoginServerOrg {
  id: string;
  name: string;
  mode?: string;
  color?: string;
  remote_url?: string;
  remoteUrl?: string;
}

export interface LoginServerCurrent {
  /** Matching bookmark id, or null when the connection URL isn't bookmarked. */
  id: string | null;
  name: string;
  url: string;
}

export interface LoginServerOptions {
  current: LoginServerCurrent;
  /** Connectable orgs other than the current one. */
  others: LoginServerOrg[];
}

/** Normalize a server URL for comparison / persistence: trim, strip trailing
 *  slashes, and default to https:// when the scheme is omitted. */
export function normalizeServerUrl(input: unknown): string {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  // A bare scheme ("https://") has no host; don't let the slash-strip turn it
  // into "https:" and then re-prefix it into a bogus "https://https:" URL.
  if (!trimmed || /^https?:\/*$/i.test(trimmed)) return '';
  const stripped = trimmed.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(stripped)) return stripped;
  return `https://${stripped}`;
}

/** `null` when valid, else a short message describing the problem. */
export function validateServerUrl(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return 'Server URL is required.';
  try {
    const u = new URL(normalizeServerUrl(input));
    if (!u.hostname) return 'Server URL must include a hostname.';
    return null;
  } catch {
    return 'Server URL is not valid.';
  }
}

/** Origin (scheme + host + port) of a server URL, or '' when it has none. */
export function serverOrigin(input: unknown): string {
  const url = normalizeServerUrl(input);
  if (!url) return '';
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True when moving from `prevUrl` to `nextUrl` targets a different server.
 * API keys and JWTs are issued by one server, so a change of origin must drop
 * them rather than carry them to the new host. A path-only edit on the same
 * origin keeps them.
 */
export function isServerOriginChange(prevUrl: unknown, nextUrl: unknown): boolean {
  return serverOrigin(prevUrl) !== serverOrigin(nextUrl);
}

export function loginOrgUrl(org: LoginServerOrg): string {
  return normalizeServerUrl(org.remote_url ?? org.remoteUrl ?? '');
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function isConnectable(org: LoginServerOrg | null | undefined): org is LoginServerOrg {
  return Boolean(org) && org!.mode !== 'local' && Boolean(loginOrgUrl(org!));
}

/**
 * Desktop: work out what the login page is connected to and what it could
 * switch to.
 *
 * `current` prefers the bookmark whose URL matches the live connection URL.
 * The active-org id can be stale (ConnectFirstScreen edits the connection
 * without creating a bookmark), so URL is the source of truth. When nothing
 * matches we synthesize an entry from the connection itself so the user can
 * still see and edit where they're signing in. Local mode always resolves to
 * this computer.
 */
export function resolveLoginServerOptions(params: {
  connection: { mode?: string; remoteUrl?: string };
  orgs: LoginServerOrg[];
  activeOrgId?: string | null;
}): LoginServerOptions {
  const remoteOrgs = params.orgs.filter((o) => o.mode === 'remote' && loginOrgUrl(o));
  // Local mode is pinned to this computer whatever the active org id says:
  // "Use local server" clears the connection without touching that id, so a
  // remote bookmark it still names is only a switch target.
  if (params.connection.mode === 'local') {
    return { current: { id: null, name: 'This computer', url: '' }, others: remoteOrgs };
  }
  const connUrl = normalizeServerUrl(params.connection.remoteUrl ?? '');

  let match = connUrl ? remoteOrgs.find((o) => loginOrgUrl(o) === connUrl) : undefined;
  if (!match && !connUrl && params.activeOrgId) {
    match = remoteOrgs.find((o) => o.id === params.activeOrgId);
  }

  const current: LoginServerCurrent = match
    ? { id: match.id, name: match.name, url: loginOrgUrl(match) }
    : { id: null, name: connUrl ? hostLabel(connUrl) : 'This computer', url: connUrl };

  const others = remoteOrgs.filter((o) => o.id !== current.id && loginOrgUrl(o) !== current.url);
  return { current, others };
}

/**
 * Mobile: every org is a remote server, and the active org is the connection.
 * Picks the active org (falling back to the first) and lists the other orgs
 * that can actually be connected to. Returns null when no org exists yet.
 */
export function resolveActiveOrgLoginServer(
  state: { activeOrgId?: string | null; orgs?: LoginServerOrg[] } | null | undefined,
): (LoginServerOptions & { currentOrg: LoginServerOrg }) | null {
  const orgs = Array.isArray(state?.orgs) ? state.orgs.filter(Boolean) : [];
  if (orgs.length === 0) return null;
  const currentOrg = orgs.find((o) => o.id === state?.activeOrgId) || orgs[0];
  return {
    currentOrg,
    current: { id: currentOrg.id, name: currentOrg.name, url: loginOrgUrl(currentOrg) },
    others: orgs.filter((o) => o.id !== currentOrg.id && isConnectable(o)),
  };
}
