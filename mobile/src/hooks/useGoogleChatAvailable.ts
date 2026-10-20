import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { hasChatReadScope, isGoogleConnected } from '../utils/googleSurface';
import { useHubChatSnapshot } from './useHubChat';

/**
 * Whether the signed-in user can read Google Chat, so the drawer only offers
 * the Google Chat page when it has something to show. Re-probed per account.
 */
export function useGoogleChatAvailable(): boolean {
  const { account } = useHubChatSnapshot();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    api
      .getGoogleStatus()
      .then((status: unknown) => {
        if (!cancelled) setAvailable(isGoogleConnected(status) && hasChatReadScope(status));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [account]);
  return available;
}
