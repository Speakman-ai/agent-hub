/**
 * useVersionCheck — decides whether to prompt the Electron user to download
 * a newer desktop build.
 *
 * Why it's Electron-only: the web client gets a fresh bundle on every hard
 * refresh after a prod deploy, and the mobile app uses a different
 * distribution channel (TestFlight / Expo). Only the installed desktop app
 * can meaningfully be "behind" the server.
 *
 * **Client version** prefers `app.getVersion()` (see `useClientBuildVersion`) so
 * the compare matches the DMG installer, not only the Vite-baked constant.
 *
 * The caller (App.jsx) passes `serverVersion` from `fetchDesktopUpdateHealth`, which
 * uses the remote hub, Settings → publicUrl (main-process fetch), or
 * `VITE_DESKTOP_UPDATE_CHECK_URL` so local bundled mode is not stuck on the
 * embedded server's version.
 *
 * Dismissal is stored in `sessionStorage` keyed by the specific server
 * version, so the banner comes back if the user connects to a server that
 * has been upgraded further during the same browser session.
 */

import { useCallback, useMemo, useState } from 'react';
import { useClientBuildVersion } from './useClientBuildVersion.js';
import { compareSemver, buildDmgDownloadUrl } from '../utils/version.js';

const DISMISS_STORAGE_KEY = 'update-dismissed-version';

function readDismissed() {
  try {
    return typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(DISMISS_STORAGE_KEY)
      : null;
  } catch {
    // sessionStorage can throw in locked-down contexts (private mode,
    // permission-denied iframes). Treat as "nothing dismissed".
    return null;
  }
}

function writeDismissed(version) {
  try {
    if (typeof sessionStorage !== 'undefined' && version) {
      sessionStorage.setItem(DISMISS_STORAGE_KEY, version);
    }
  } catch {
    // Ignore — we also flip local state, so the modal hides regardless.
  }
}

/**
 * @param {{ serverVersion: string | null | undefined }} args
 * @returns {{
 *   updateAvailable: boolean,
 *   serverVersion: string | null,
 *   clientVersion: string | null,
 *   downloadUrl: string | null,
 *   dismiss: () => void,
 * }}
 */
export function useVersionCheck({ serverVersion } = {}) {
  const [dismissedVersion, setDismissedVersion] = useState(() => readDismissed());

  const isElectron = typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  const arch = typeof window !== 'undefined' ? window.electronAPI?.arch : undefined;

  const rawClient = useClientBuildVersion();
  const clientVersion = rawClient || null;
  const normalizedServer =
    typeof serverVersion === 'string' && serverVersion.trim() ? serverVersion.trim() : null;

  const updateAvailable = useMemo(() => {
    if (!isElectron) return false;
    if (!normalizedServer || !clientVersion) return false;
    if (dismissedVersion && dismissedVersion === normalizedServer) return false;
    return compareSemver(clientVersion, normalizedServer) < 0;
  }, [isElectron, normalizedServer, clientVersion, dismissedVersion]);

  const downloadUrl = useMemo(
    () =>
      normalizedServer ? buildDmgDownloadUrl({ version: normalizedServer, platform, arch }) : null,
    [normalizedServer, platform, arch],
  );

  const dismiss = useCallback(() => {
    if (normalizedServer) {
      writeDismissed(normalizedServer);
      setDismissedVersion(normalizedServer);
    } else {
      // No server version yet — just hide for this render lifetime.
      setDismissedVersion('__transient__');
    }
  }, [normalizedServer]);

  return {
    updateAvailable,
    serverVersion: normalizedServer,
    clientVersion,
    downloadUrl,
    dismiss,
  };
}
