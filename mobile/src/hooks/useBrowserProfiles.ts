import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  groupBrowserProfilesByAgent,
  type BrowserProfileAgentGroup,
  type BrowserProfileWire,
} from '@shared/utils/browserProfiles';
import { api } from '../utils/api';

export interface UseBrowserProfiles {
  /** `null` until the first load finishes. */
  profiles: BrowserProfileWire[] | null;
  groups: BrowserProfileAgentGroup[];
  error: string | null;
  /** `<profileId>` while deleting, `<profileId>:<domain>` while clearing. */
  busy: string | null;
  reload: () => Promise<void>;
  clearDomain: (profile: BrowserProfileWire, domain: string) => Promise<void>;
  deleteProfile: (profile: BrowserProfileWire) => Promise<void>;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Data hook behind the mobile Browser Profiles settings tab. Same contract as
 * the web pane: load the caller's profiles, clear one domain (the server
 * returns the updated profile) or delete a whole profile. Confirmation
 * prompts stay in the component.
 */
export function useBrowserProfiles(): UseBrowserProfiles {
  const [profiles, setProfiles] = useState<BrowserProfileWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getMyBrowserProfiles();
      setProfiles(res.profiles);
    } catch (err) {
      setError(message(err, 'Failed to load browser profiles'));
      setProfiles((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const clearDomain = useCallback(async (profile: BrowserProfileWire, domain: string) => {
    setBusy(`${profile.id}:${domain}`);
    setError(null);
    try {
      const updated = await api.clearBrowserProfileDomain(profile.id, domain);
      setProfiles((prev) => (prev ?? []).map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError(message(err, 'Failed to clear domain'));
    } finally {
      setBusy(null);
    }
  }, []);

  const deleteProfile = useCallback(async (profile: BrowserProfileWire) => {
    setBusy(profile.id);
    setError(null);
    try {
      await api.deleteBrowserProfile(profile.id);
      setProfiles((prev) => (prev ?? []).filter((p) => p.id !== profile.id));
    } catch (err) {
      setError(message(err, 'Failed to delete profile'));
    } finally {
      setBusy(null);
    }
  }, []);

  const groups = useMemo(() => groupBrowserProfilesByAgent(profiles ?? []), [profiles]);

  return { profiles, groups, error, busy, reload, clearDomain, deleteProfile };
}
