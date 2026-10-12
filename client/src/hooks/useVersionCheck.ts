/**
 * useVersionCheck — decides whether to point the Electron user at to download
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
 * version, so the sidebar pointer comes back if the user connects to a server
 * that has been upgraded further during the same browser session.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useClientBuildVersion } from './useClientBuildVersion';
import { compareSemver, buildDmgDownloadUrl } from '../utils/version';

const DISMISS_STORAGE_KEY = 'update-dismissed-version';

/** Recheck cadence for an installer that is not published yet. */
export const INSTALLER_RECHECK_MS = 5 * 60 * 1000;
/** Timed rechecks stop after an hour; window focus still triggers one. */
export const INSTALLER_MAX_TIMED_RECHECKS = 12;

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

function writeDismissed(version: any) {
  try {
    if (typeof sessionStorage !== 'undefined' && version) {
      sessionStorage.setItem(DISMISS_STORAGE_KEY, version);
    }
  } catch {
    // Ignore — we also flip local state, so the modal hides regardless.
  }
}

type InstallerStatus = 'checking' | 'published' | 'missing' | 'unverifiable';

/**
 * `updateAvailable` means a newer build is downloadable now; it drives the
 * Settings → General download card. `showUpdateHint` additionally respects the
 * per-version dismissal and drives the sidebar pointer.
 *
 * The hub's version is bumped before the DMG for it is uploaded, so when the
 * preload can probe, the update is only announced once the installer exists.
 * Preloads that predate the probe (an older install in remote mode) keep the
 * unverified behavior so they still learn about updates.
 */
export function useVersionCheck({ serverVersion }: any = {}) {
  const [dismissedVersion, setDismissedVersion] = useState(() => readDismissed());

  const isElectron = typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  const arch = typeof window !== 'undefined' ? window.electronAPI?.arch : undefined;

  const rawClient = useClientBuildVersion();
  const clientVersion = rawClient || null;
  const normalizedServer =
    typeof serverVersion === 'string' && serverVersion.trim() ? serverVersion.trim() : null;

  const isNewer = useMemo(() => {
    if (!isElectron) return false;
    if (!normalizedServer || !clientVersion) return false;
    return compareSemver(clientVersion, normalizedServer) < 0;
  }, [isElectron, normalizedServer, clientVersion]);

  const downloadUrl = useMemo(
    () =>
      normalizedServer ? buildDmgDownloadUrl({ version: normalizedServer, platform, arch }) : null,
    [normalizedServer, platform, arch],
  );

  const [installer, setInstaller] = useState<{ url: string | null; status: InstallerStatus }>({
    url: null,
    status: 'checking',
  });
  const [probeAttempt, setProbeAttempt] = useState(0);
  useEffect(() => {
    if (!isNewer || !downloadUrl) return;
    const probe = window.electronAPI?.probeInstallerUrl;
    if (typeof probe !== 'function') {
      setInstaller({ url: downloadUrl, status: 'unverifiable' });
      return;
    }
    let cancelled = false;
    // A recheck keeps the previous result visible instead of flashing 'checking'.
    setInstaller((prev) =>
      prev.url === downloadUrl ? prev : { url: downloadUrl, status: 'checking' },
    );
    Promise.resolve(probe(downloadUrl))
      .then((ok: unknown) => {
        if (cancelled) return;
        // null: the main process won't probe this host (a non-S3 release base).
        const status: InstallerStatus = ok === null ? 'unverifiable' : ok ? 'published' : 'missing';
        setInstaller({ url: downloadUrl, status });
      })
      .catch(() => {
        if (!cancelled) setInstaller({ url: downloadUrl, status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [isNewer, downloadUrl, probeAttempt]);

  // The hub version usually arrives before its DMG is uploaded, and a probe can
  // also fail on a flaky network. Recheck on a bounded timer and on window focus
  // so the update appears without restarting the app.
  const installerMissing = installer.url === downloadUrl && installer.status === 'missing';
  useEffect(() => {
    if (!isNewer || !installerMissing) return;
    let timedRechecks = 0;
    const recheck = () => setProbeAttempt((n) => n + 1);
    const timer = setInterval(() => {
      timedRechecks += 1;
      if (timedRechecks > INSTALLER_MAX_TIMED_RECHECKS) {
        clearInterval(timer);
        return;
      }
      recheck();
    }, INSTALLER_RECHECK_MS);
    window.addEventListener('focus', recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', recheck);
    };
  }, [isNewer, installerMissing]);

  const installerReady =
    !downloadUrl ||
    (installer.url === downloadUrl &&
      (installer.status === 'published' || installer.status === 'unverifiable'));
  const updateAvailable = isNewer && installerReady;
  const showUpdateHint =
    updateAvailable && !(dismissedVersion && dismissedVersion === normalizedServer);

  const dismiss = useCallback(() => {
    if (normalizedServer) {
      writeDismissed(normalizedServer);
      setDismissedVersion(normalizedServer);
    } else {
      setDismissedVersion('__transient__');
    }
  }, [normalizedServer]);

  return {
    updateAvailable,
    showUpdateHint,
    serverVersion: normalizedServer,
    clientVersion,
    downloadUrl,
    dismiss,
  };
}
