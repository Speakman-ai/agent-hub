import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import LoginScreen from './LoginScreen.jsx';
import { isAuthenticated } from '../utils/auth.js';
import { getApiBase } from '../utils/connection.js';
import { getAuthStatus } from '../utils/auth.js';

/**
 * Wraps the main app and blocks rendering until we know whether auth is
 * needed. If the server reports `authConfigured: true` and we don't have a
 * valid token, we render <LoginScreen /> instead of children.
 *
 * The existing legacy apiKey flow (via the SetupWizard / connection.js) is
 * preserved: when the server reports `authConfigured: false`, this gate is
 * a no-op and children render immediately.
 */
export default function AuthGate({ children }) {
  const [status, setStatus] = useState({ state: 'loading', required: false });
  // Counter increments when the user authenticates; used to re-check.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAuthStatus(getApiBase());
        if (cancelled) return;
        setStatus({ state: 'ready', required: !!res.authConfigured });
      } catch (err) {
        if (cancelled) return;
        // If the status endpoint itself is unreachable, surface the error
        // but don't hard-block — the main app's connection handling will
        // report the underlying issue. Treat as "not required" so the
        // legacy flow can still attempt to connect.
        setStatus({ state: 'ready', required: false, error: err?.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  if (status.state === 'loading') {
    return (
      <div className="flex flex-col h-screen bg-gray-950 text-gray-100 items-center justify-center gap-3">
        <Loader2 size={24} className="animate-spin text-indigo-400" />
        <p className="text-xs text-gray-500">Checking authentication…</p>
      </div>
    );
  }

  if (status.required && !isAuthenticated()) {
    return <LoginScreen onAuthenticated={() => setNonce((n) => n + 1)} />;
  }

  return children;
}
