import { aiSignInGuideKey, needsAiSignInGuide } from '../utils/aiSignInGuide';

type GuideStatus = Parameters<typeof needsAiSignInGuide>[0];
interface GuideStorage {
  getItem: (key: string) => string | null | undefined | Promise<string | null | undefined>;
  setItem: (key: string, value: string) => void | Promise<void>;
}
interface GuideOptions {
  server: string;
  user?: Parameters<typeof aiSignInGuideKey>[1];
  enabled?: boolean;
  storage: GuideStorage;
  status?: GuideStatus;
  loadStatus?: (server: string, signal: AbortSignal) => Promise<GuideStatus>;
}

type ReactHooks = {
  useCallback: <T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: readonly unknown[],
  ) => T;
  useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void;
  useState: <T>(initialValue: T | (() => T)) => [T, (value: T | ((previous: T) => T)) => void];
  useRef: <T>(initialValue: T) => { current: T };
};

// Web and native install different React versions. Use the renderer's own hooks.
export function createUseAiSignInGuide({ useCallback, useEffect, useRef, useState }: ReactHooks) {
  return function useAiSignInGuide({
    server,
    user,
    enabled = true,
    storage,
    status,
    loadStatus,
  }: GuideOptions) {
    const key = aiSignInGuideKey(server, user);
    const [visibleKey, setVisibleKey] = useState<string | null>(null);
    const dismissedKeys = useRef(new Set<string>());
    const authConfigured = status?.authConfigured;
    const hasAnyAiCredentials = status?.hasAnyAiCredentials;

    useEffect(() => {
      setVisibleKey(null);
      if (!enabled || !server || dismissedKeys.current.has(key)) return;
      let cancelled = false;
      const controller = new AbortController();
      (async () => {
        let dismissed: string | null | undefined;
        try {
          dismissed = await storage.getItem(key);
        } catch {
          // Storage failure must not prevent navigation guidance.
        }
        if (dismissed === 'done' || cancelled || dismissedKeys.current.has(key)) return;
        const resolvedStatus = loadStatus
          ? await loadStatus(server, controller.signal)
          : { authConfigured, hasAnyAiCredentials };
        if (!cancelled && !dismissedKeys.current.has(key) && needsAiSignInGuide(resolvedStatus)) {
          setVisibleKey(key);
        }
      })().catch(() => {});
      return () => {
        cancelled = true;
        controller.abort();
      };
    }, [enabled, key, server, storage, loadStatus, authConfigured, hasAnyAiCredentials]);

    const dismissAiSignInGuide = useCallback(() => {
      dismissedKeys.current.add(key);
      setVisibleKey(null);
      // Both synchronous browser storage and asynchronous native storage can fail.
      void (async () => {
        await storage.setItem(key, 'done');
      })().catch(() => {});
    }, [key, storage]);

    return {
      showAiSignInGuide:
        enabled &&
        visibleKey === key &&
        !dismissedKeys.current.has(key) &&
        (loadStatus !== undefined || needsAiSignInGuide(status)),
      dismissAiSignInGuide,
    };
  };
}
