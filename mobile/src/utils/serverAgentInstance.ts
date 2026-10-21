/**
 * Mobile composition root for the Server Agent settings binding (logic in
 * `@shared/utils/serverAgentSettingsStore`). The signed-in account comes from
 * the chat account gate's generation, bumped on sign-out and on account,
 * server and org switch; null while no account is served.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_SERVER_AGENT_NAME } from '@shared/utils/hub';
import {
  createServerAgentSettingsBinding,
  serverAgentDisplayName as displayName,
  type ServerAgentSettings,
} from '@shared/utils/serverAgentSettingsStore';
import { api } from './api';
import { useHubChatSnapshot } from '../hooks/useHubChat';

export { DEFAULT_SERVER_AGENT_NAME };

function useAccountKey(): string | null {
  const { active, account } = useHubChatSnapshot();
  return active ? `account:${account}` : null;
}

export const {
  useServerAgentAccountKey,
  useServerAgentSettings,
  useServerAgentLoadError,
  saveServerAgentSettings,
  resetServerAgentSettingsForTests,
} = createServerAgentSettingsBinding({
  fetch: () => api.getServerAgentSettings() as Promise<ServerAgentSettings>,
  put: (body) => api.putServerAgentSettings(body) as Promise<ServerAgentSettings>,
  useAccountKey,
  hooks: { useSyncExternalStore, useEffect },
});

export const serverAgentDisplayName = (settings: ServerAgentSettings | null) =>
  displayName(settings, DEFAULT_SERVER_AGENT_NAME);
