/**
 * Web composition root for the Server Agent settings binding (logic in
 * `@shared/utils/serverAgentSettingsStore`). The account is the Server, the
 * signed-in user and their session, so sign-out and sign-in (even as the same
 * user), account switch, and Server switch each start a new epoch.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_SERVER_AGENT_NAME } from '@shared/utils/hub';
import {
  createServerAgentSettingsBinding,
  serverAgentDisplayName as displayName,
  type ServerAgentSettings,
} from '@shared/utils/serverAgentSettingsStore';
import { api } from './api';
import { getAuthRecord } from './auth';
import { getServerBase } from './connection';

export { DEFAULT_SERVER_AGENT_NAME };

/** Short, non-reversible tag of the session token: changes on every sign-in. */
function sessionTag(token: unknown): string {
  if (typeof token !== 'string' || !token) return '';
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Server, signed-in user and session. The session tag makes a sign-out and
 * sign-in as the same user a new account, even though nothing renders the
 * Server Agent while signed out.
 */
function useAccountKey(): string {
  let user = '';
  let session = '';
  try {
    const rec = getAuthRecord();
    user = String(rec?.user?.id ?? rec?.user?.username ?? '');
    session = sessionTag(rec?.token);
  } catch {
    user = '';
  }
  return `${getServerBase()}\n${user}\n${session}`;
}

export const {
  useServerAgentSettings,
  useServerAgentLoadError,
  saveServerAgentSettings,
  resetServerAgentSettingsForTests,
} = createServerAgentSettingsBinding({
  fetch: () => api.getServerAgentSettings(),
  put: (body) => api.putServerAgentSettings(body),
  useAccountKey,
  hooks: { useSyncExternalStore, useEffect },
});

/** Never null on web: the Server is fixed and an unauthenticated user is ''. */
export const useServerAgentAccountKey: () => string = useAccountKey;

export const serverAgentDisplayName = (settings: ServerAgentSettings | null) =>
  displayName(settings, DEFAULT_SERVER_AGENT_NAME);
