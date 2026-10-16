/**
 * Push across every saved server.
 *
 * The phone has one Expo push token, but each server keeps its own list of
 * devices to push to. To be notified by every saved server, the token is
 * registered with each of them using that server's own saved login, not the
 * active one. Each registration also sends the URL the phone uses for that
 * server; the server echoes it back as `hubServerUrl` in every push, which
 * is how a tap or an approval button finds the server it came from.
 *
 * Network calls go straight through `fetch` rather than the shared API
 * client: a rejected request for a server the user is not looking at must
 * not sign them out of the active one.
 */
import { PUSH_SERVER_URL_KEY } from '@shared/utils/pushServerTag';
import { authOriginOf } from './auth';

export { PUSH_SERVER_URL_KEY };

export interface PushServer {
  /** Saved-server (org) id on this phone. */
  id: string;
  /** Server root URL without a trailing slash. */
  serverUrl: string;
  apiKey: string;
}

export interface ServerPushDeps {
  fetch: (url: string, init?: any) => Promise<{ ok: boolean; status: number }>;
  /** Saved login token for a server, or null when signed out of it. */
  loginTokenFor: (serverUrl: string) => Promise<string | null>;
  /** Give up on a request after this long. Defaults to PUSH_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Removal and sign-out wait for these requests, so a server that accepts the
 * connection and never answers must not hold them up for longer than this.
 */
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

export interface ServerPushResult {
  serverUrl: string;
  ok: boolean;
  status?: number;
  error?: string;
}

function trimUrl(url: unknown): string {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

/** One entry per distinct server origin among the saved servers. */
export function pushServersFromOrgs(orgs: any[] | null | undefined): PushServer[] {
  const seen = new Set<string>();
  const out: PushServer[] = [];
  for (const org of orgs ?? []) {
    const serverUrl = trimUrl(org?.remoteUrl);
    const origin = authOriginOf(serverUrl);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push({ id: String(org.id), serverUrl, apiKey: org.apiKey || '' });
  }
  return out;
}

/** Same precedence as the active connection: a login beats an API key. */
export async function serverAuthHeaders(
  server: PushServer,
  deps: Pick<ServerPushDeps, 'loginTokenFor'>,
): Promise<Record<string, string>> {
  const token = await deps.loginTokenFor(server.serverUrl).catch(() => null);
  if (token) return { Authorization: `Bearer ${token}` };
  if (server.apiKey) return { 'X-API-Key': server.apiKey };
  return {};
}

async function call(
  server: PushServer,
  path: string,
  init: { method: string; body?: unknown },
  deps: ServerPushDeps,
): Promise<ServerPushResult> {
  const timeoutMs = deps.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race settles even if `fetch` ignores the abort signal.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const headers = await serverAuthHeaders(server, deps);
      return deps.fetch(`${server.serverUrl}/api${path}`, {
        method: init.method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    })();
    const res = await Promise.race([request, timedOut]);
    return { serverUrl: server.serverUrl, ok: res.ok, status: res.status };
  } catch (err) {
    return {
      serverUrl: server.serverUrl,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register the push token with every server. A server that is down or that
 * the user is signed out of just fails on its own; the rest still register.
 */
export function registerPushTokenWithServers(
  token: string,
  platform: string,
  servers: PushServer[],
  deps: ServerPushDeps,
): Promise<ServerPushResult[]> {
  return Promise.all(
    servers.map((server) =>
      call(
        server,
        '/devices',
        { method: 'POST', body: { token, platform, serverUrl: server.serverUrl } },
        deps,
      ),
    ),
  );
}

/** Stop a server pushing to this phone, e.g. before the server is deleted. */
export function unregisterPushTokenFromServer(
  token: string,
  server: PushServer,
  deps: ServerPushDeps,
): Promise<ServerPushResult> {
  return call(server, `/devices/${encodeURIComponent(token)}`, { method: 'DELETE' }, deps);
}

/** The server URL a push was tagged with, or null for an untagged push. */
export function pushServerUrl(data: unknown): string | null {
  const raw = (data as Record<string, unknown> | null | undefined)?.[PUSH_SERVER_URL_KEY];
  return authOriginOf(trimUrl(raw)) ? trimUrl(raw) : null;
}

export type PushSource =
  | { kind: 'active' }
  | { kind: 'other'; server: PushServer }
  /** Tagged with a server that is no longer saved. */
  | { kind: 'unknown' }
  /** Untagged: nothing in the notification says which server sent it. */
  | { kind: 'ambiguous' };

/**
 * Which server a notification belongs to, decided only from the notification
 * itself.
 *
 * A tagged notification names its server. If that server is no longer saved
 * (removed, or re-pointed elsewhere) it is `unknown`.
 *
 * An untagged notification is `ambiguous`, whatever the phone's current
 * state. Which server is active, or which servers tag today, says nothing
 * about a notification delivered earlier: it may predate its server's
 * upgrade, or come from a server since removed. Neither `unknown` nor
 * `ambiguous` may be answered or opened, since its ids would go to a server
 * that may never have issued them.
 */
export function pushSource(
  data: unknown,
  orgs: any[] | null | undefined,
  activeServerUrl: string | null | undefined,
): PushSource {
  const raw = (data as Record<string, unknown> | null | undefined)?.[PUSH_SERVER_URL_KEY];
  if (raw === undefined || raw === null || raw === '') return { kind: 'ambiguous' };
  const origin = authOriginOf(pushServerUrl(data));
  if (!origin) return { kind: 'unknown' };
  // Saved membership first: the active URL can still name a server whose
  // entry was just deleted, and that server's notifications are refused too.
  const server = pushServersFromOrgs(orgs).find((s) => authOriginOf(s.serverUrl) === origin);
  if (!server) return { kind: 'unknown' };
  return origin === authOriginOf(activeServerUrl) ? { kind: 'active' } : { kind: 'other', server };
}

/**
 * True when no saved server other than `orgId` still points at the origin of
 * `serverUrl`, so that server may be told to stop pushing to this phone.
 * Several saved entries can share one server, and they share its
 * registration.
 */
export function mayUnregisterServer(
  orgs: any[] | null | undefined,
  orgId: string,
  serverUrl: string | null | undefined,
): boolean {
  const origin = authOriginOf(trimUrl(serverUrl));
  if (!origin) return false;
  return !(orgs ?? []).some(
    (o: any) => String(o?.id) !== String(orgId) && authOriginOf(trimUrl(o?.remoteUrl)) === origin,
  );
}

/** Answer an approval on the server its push came from. Throws like the API client. */
export async function answerApprovalOnServer(
  server: PushServer,
  approvalId: string,
  decision: string,
  deps: ServerPushDeps,
): Promise<void> {
  const result = await call(
    server,
    `/me/approvals/${encodeURIComponent(approvalId)}/answer`,
    { method: 'POST', body: { decision } },
    deps,
  );
  if (result.ok) return;
  const err: Error & { status?: number } = new Error(
    result.error ?? `Answer failed: ${result.status}`,
  );
  if (result.status !== undefined) err.status = result.status;
  throw err;
}

export const UNKNOWN_SERVER_MESSAGE =
  'This notification is from a server that is no longer saved on this phone.';
export const AMBIGUOUS_SERVER_MESSAGE =
  "Can't tell which server this notification came from. Open the app on that server to answer it.";

/**
 * Answer an approval button press on the server its push came from. A push
 * whose server is no longer saved, or can't be told apart, is refused rather
 * than sent to a server that may not have issued it.
 */
export async function answerPushApproval<D extends string>(args: {
  data: unknown;
  orgs: any[] | null | undefined;
  activeServerUrl: string | null | undefined;
  approvalId: string;
  decision: D;
  answerOnActive: (approvalId: string, decision: D) => Promise<unknown>;
  deps: ServerPushDeps;
}): Promise<unknown> {
  const source = pushSource(args.data, args.orgs, args.activeServerUrl);
  if (source.kind === 'active') return args.answerOnActive(args.approvalId, args.decision);
  if (source.kind === 'other') {
    return answerApprovalOnServer(source.server, args.approvalId, args.decision, args.deps);
  }
  throw new Error(source.kind === 'ambiguous' ? AMBIGUOUS_SERVER_MESSAGE : UNKNOWN_SERVER_MESSAGE);
}

/**
 * Open a tapped push: on the active server directly, on another saved server
 * after switching to it. A push whose server is no longer saved, or can't be
 * told apart, opens nothing.
 * Resolves to what happened.
 */
export async function routePushTap(args: {
  data: unknown;
  orgs: any[] | null | undefined;
  activeServerUrl: string | null | undefined;
  routeOnActive: (data: unknown) => void;
  /** Resolves false when a newer switch superseded this one. */
  switchTo: (orgId: string) => Promise<boolean>;
  /** The active server now; read again after the switch. */
  currentServerUrl: () => string | null | undefined;
}): Promise<'routed' | 'switched' | 'superseded' | 'unknown' | 'ambiguous'> {
  const source = pushSource(args.data, args.orgs, args.activeServerUrl);
  if (source.kind === 'unknown' || source.kind === 'ambiguous') return source.kind;
  if (source.kind === 'other') {
    const target = source.server.serverUrl;
    const stillLatest = await args.switchTo(source.server.id);
    // Another tap or a manual switch may have taken over while this one ran:
    // then these ids belong to a server that is no longer the active one.
    if (!stillLatest || authOriginOf(args.currentServerUrl()) !== authOriginOf(target)) {
      return 'superseded';
    }
    args.routeOnActive(args.data);
    return 'switched';
  }
  args.routeOnActive(args.data);
  return 'routed';
}
