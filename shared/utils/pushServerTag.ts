/**
 * Push data key naming the server a notification came from.
 *
 * A phone can be saved to several servers. Remote pushes carry the URL the
 * phone registered under; local banners carry the server whose socket raised
 * them. A notification without it can't be attributed to any server, so the
 * phone never answers or opens it.
 */
export const PUSH_SERVER_URL_KEY = 'hubServerUrl';

/** Copy of `data` tagged with `serverUrl` (unchanged when there is no URL). */
export function tagPushData<T extends Record<string, unknown>>(
  data: T | null | undefined,
  serverUrl: string | null | undefined,
): T | Record<string, unknown> {
  const base = data ?? {};
  return serverUrl ? { ...base, [PUSH_SERVER_URL_KEY]: serverUrl } : base;
}
