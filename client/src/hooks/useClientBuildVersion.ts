import { useState, useEffect } from 'react';

/**
 * Client semver shown in the UI and used for desktop update compares.
 * In Electron, prefers `app.getVersion()` from the main process so the prompt
 * matches the installed DMG; otherwise uses Vite's `VITE_APP_VERSION`.
 */
export function useClientBuildVersion() {
  const vite = import.meta.env.VITE_APP_VERSION || '';
  const [version, setVersion] = useState(() => vite);

  useEffect(() => {
    if (!window.electronAPI?.getAppVersion) return;
    let cancelled = false;
    window.electronAPI
      .getAppVersion()
      .then((v: any) => {
        if (!cancelled && typeof v === 'string' && v.trim()) {
          setVersion(v.trim());
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
