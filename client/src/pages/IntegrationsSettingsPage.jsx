import { useState, useEffect, useCallback, useRef } from 'react';
import { Plug, CheckCircle2, Loader2, Link as LinkIcon, AlertTriangle, Info } from 'lucide-react';
import { api } from '../utils/api.js';
import { getApiBase, getAuthHeaders } from '../utils/connection.js';
import { useIntegrationStatus } from '../hooks/useIntegrationStatus.js';

/**
 * Settings → Integrations (per-user).
 *
 * Lists the SUPPORTED_INTEGRATIONS catalogue from the server alongside
 * the caller's existing connections. Each row offers Connect / Disconnect.
 *
 * Connect flow
 * ------------
 *  1. Click "Connect" → POST /api/users/:userId/integrations/:app/connect
 *  2. Server returns `{ authUrl, connectionId }`. We open `authUrl` in a
 *     centred popup.
 *  3. The page begins polling `GET …/:app` every 2s, capped at 5min.
 *  4. When Nango finishes the OAuth dance and POSTs the webhook, the
 *     row flips PENDING → CONNECTED. The popup posts a `success`
 *     message back to `window.opener` (a small bridge HTML page Nango
 *     hosts) and we trigger an immediate refetch instead of waiting for
 *     the next 2s tick.
 *
 * Error states surfaced inline:
 *  - Popup blocked ("Allow popups…")
 *  - OAuth denied ("Connection cancelled")
 *  - Polling timeout (5min — the user almost certainly closed the popup)
 */

function StatusBadge({ status }) {
  if (status === 'CONNECTED') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-900/40 border border-emerald-700 px-2 py-0.5 text-xs text-emerald-200">
        <CheckCircle2 size={12} /> Active
      </span>
    );
  }
  if (status === 'PENDING') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-900/30 border border-amber-700 px-2 py-0.5 text-xs text-amber-200">
        <Loader2 size={12} className="animate-spin" /> Pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
      Not connected
    </span>
  );
}

/**
 * Internal — single integration card. Owns its own polling state so a
 * Connect on one app doesn't gate the others.
 */
function IntegrationRow({ integration, userId, providerReady, onChange }) {
  const [polling, setPolling] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const popupRef = useRef(null);

  const { data, error, timedOut, refetch } = useIntegrationStatus({
    userId,
    app: integration.id,
    polling,
    fetcher: api.getUserIntegration,
    pollIntervalMs: 2000,
    pollTimeoutMs: 5 * 60 * 1000,
    onConnected: () => {
      setPolling(false);
      onChange?.();
    },
    onTimeout: () => {
      setPolling(false);
      setActionError(
        'Timed out waiting for the popup to finish. If you closed it, try Connect again.',
      );
    },
  });

  // Listen for postMessage from the OAuth bridge popup. We only react to
  // messages whose origin matches our API base (the server hosts the
  // bridge page) — anything else is ignored to avoid a hostile page in
  // an unrelated tab forging a "success".
  useEffect(() => {
    if (!polling) return undefined;
    const apiOrigin = (() => {
      try {
        return new URL(getApiBase(), window.location.origin).origin;
      } catch {
        return window.location.origin;
      }
    })();
    function onMsg(ev) {
      if (ev.origin !== apiOrigin && ev.origin !== window.location.origin) return;
      const payload = ev.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.type !== 'agent-hub:integration:result') return;
      if (payload.app && payload.app !== integration.id) return;
      if (payload.status === 'success') {
        // Don't wait for the next 2s tick — fetch right away.
        void refetch();
      } else if (payload.status === 'denied') {
        setPolling(false);
        setActionError('Connection cancelled by the OAuth provider.');
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [polling, integration.id, refetch]);

  const handleConnect = useCallback(async () => {
    setActionError(null);
    setPopupBlocked(false);
    setBusy(true);
    try {
      const res = await api.connectUserIntegration(userId, integration.id);
      if (!res?.authUrl) {
        throw new Error('Server did not return an authUrl');
      }
      // Open the popup BEFORE flipping `polling` so that if the popup is
      // blocked, we surface that immediately and don't strand the row in
      // a permanent Pending state.
      const features = 'width=600,height=720,menubar=no,toolbar=no,location=yes,status=yes';
      const win = window.open(res.authUrl, 'agent-hub-oauth', features);
      if (!win || win.closed || typeof win.closed === 'undefined') {
        setPopupBlocked(true);
        return;
      }
      popupRef.current = win;
      setPolling(true);
      // Optimistically flip to PENDING so the badge reflects state before
      // the next poll lands.
      await refetch();
    } catch (err) {
      setActionError(err?.message || 'Failed to start OAuth flow');
    } finally {
      setBusy(false);
    }
  }, [userId, integration.id, refetch]);

  const handleDisconnect = useCallback(async () => {
    setActionError(null);
    setBusy(true);
    try {
      await api.disconnectUserIntegration(userId, integration.id);
      await refetch();
      onChange?.();
    } catch (err) {
      setActionError(err?.message || 'Disconnect failed');
    } finally {
      setBusy(false);
    }
  }, [userId, integration.id, refetch, onChange]);

  const status = data?.status ?? null;
  const isConnected = status === 'CONNECTED';
  const isPending = status === 'PENDING' || polling;

  return (
    <li
      className="rounded border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
      data-testid={`integration-row-${integration.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{integration.label}</span>
          <StatusBadge status={status} />
          {!providerReady && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-300">
              <AlertTriangle size={12} /> Provider unavailable
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-400 mt-1">{integration.description}</p>
        {integration.docsUrl && (
          <a
            href={integration.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline mt-1"
          >
            <LinkIcon size={11} /> Learn more
          </a>
        )}
        {actionError && (
          <div className="text-xs text-red-300 mt-2 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{actionError}</span>
          </div>
        )}
        {popupBlocked && (
          <div className="text-xs text-amber-300 mt-2 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              Popup blocked by the browser. Allow popups for this site and click Connect again.
            </span>
          </div>
        )}
        {timedOut && !actionError && (
          <div className="text-xs text-amber-300 mt-2 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>Timed out after 5 minutes. Click Connect to start over.</span>
          </div>
        )}
        {error && (
          <div className="text-xs text-red-300 mt-2 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {isConnected ? (
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={busy}
            className="rounded bg-zinc-700 hover:bg-red-700 px-3 py-1.5 text-sm disabled:opacity-50"
            data-testid={`disconnect-${integration.id}`}
          >
            {busy ? 'Working…' : 'Disconnect'}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy || isPending || !providerReady}
            className="inline-flex items-center gap-1 rounded bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm disabled:opacity-50"
            data-testid={`connect-${integration.id}`}
          >
            {busy || isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Plug size={12} />
            )}
            {isPending ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Public page component. `userId` is normally injected from the parent
 * (the host knows the authenticated user). For a standalone render we
 * fall back to fetching `/auth/me` once on mount.
 */
export default function IntegrationsSettingsPage({ userId: userIdProp = null }) {
  const [userId, setUserId] = useState(userIdProp);
  const [supported, setSupported] = useState(null);
  const [providerReady, setProviderReady] = useState(true);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Resolve current user when the prop is omitted.
  useEffect(() => {
    if (userIdProp) {
      setUserId(userIdProp);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/auth/me`, { headers: getAuthHeaders() });
        if (!res.ok) throw new Error(`GET /auth/me → ${res.status}`);
        const body = await res.json();
        if (!cancelled) setUserId(body.user?.id ?? null);
      } catch (err) {
        if (!cancelled) setLoadError(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userIdProp]);

  const reloadConnections = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await api.listUserIntegrations(userId);
      setConnections(res?.integrations ?? []);
    } catch (err) {
      setLoadError(err.message || String(err));
    }
  }, [userId]);

  // Initial catalogue + connections load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const cat = await api.getSupportedIntegrations();
        if (cancelled) return;
        setSupported(cat?.integrations ?? []);
        setProviderReady(cat?.providerReady ?? false);
        if (userId) {
          const conn = await api.listUserIntegrations(userId);
          if (cancelled) return;
          setConnections(conn?.integrations ?? []);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) {
    return (
      <div className="text-zinc-400 flex items-center gap-2 text-sm">
        <Loader2 size={14} className="animate-spin" /> Loading integrations…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded border border-red-700 bg-red-900/30 p-4 text-sm text-red-100">
        {loadError}
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="rounded border border-amber-700 bg-amber-900/30 p-4 text-sm text-amber-100">
        Not authenticated — sign in to manage personal integrations.
      </div>
    );
  }

  // Map status by app for the cards. The hook re-fetches per-row, so
  // this is just the seed value for the first render.
  const statusByApp = new Map(connections.map((c) => [c.app, c]));

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Plug size={18} /> Integrations
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          Connect your personal third-party accounts so Agent Hub agents can act on your behalf.
          Connections are scoped to your user and can be disconnected at any time.
        </p>
      </header>

      {!providerReady && (
        <div className="rounded border border-amber-700 bg-amber-900/30 p-3 text-sm text-amber-100 flex items-start gap-2">
          <Info size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            The integration provider isn&apos;t configured on this server. Ask your operator to
            enable Hub-Shared mode or set up a Nango key in Settings → Admin → Integrations.
          </div>
        </div>
      )}

      <ul className="space-y-2" data-testid="integration-list">
        {(supported ?? []).map((integration) => (
          <IntegrationRow
            key={integration.id}
            integration={integration}
            userId={userId}
            providerReady={providerReady}
            // Seed initial render with whatever the bulk list returned.
            // The hook will re-fetch and keep this row in sync going
            // forward.
            initialStatus={statusByApp.get(integration.id) ?? null}
            onChange={reloadConnections}
          />
        ))}
      </ul>
    </div>
  );
}
