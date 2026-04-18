import { useState, useEffect } from 'react';
import { Lock, Loader2, UserPlus, KeyRound } from 'lucide-react';
import { login, setup, getAuthStatus } from '../utils/auth.js';
import { getApiBase } from '../utils/connection.js';

/**
 * Full-screen login gate.
 *
 * - Calls /api/auth/status on mount to decide whether to show the "sign in"
 *   form or the first-run "create owner account" form.
 * - On success, calls `onAuthenticated()` so the parent can re-render into
 *   the normal app.
 */
export default function LoginScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('loading'); // loading | login | setup
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getAuthStatus(getApiBase());
        if (cancelled) return;
        setMode(status.authConfigured ? 'login' : 'setup');
        if (status.username) setUsername(status.username);
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Failed to reach server');
        setMode('login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'setup') {
        await setup({ baseUrl: getApiBase(), username, password });
      } else {
        await login({ baseUrl: getApiBase(), username, password });
      }
      onAuthenticated?.();
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  }

  const isSetup = mode === 'setup';
  const Icon = isSetup ? UserPlus : KeyRound;
  const title = isSetup ? 'Create your account' : 'Sign in to Agent Hub';
  const subtitle = isSetup
    ? 'No user has been configured yet. Pick a username and password for this environment.'
    : 'Enter your credentials to continue.';

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-6">
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            {mode === 'loading' ? (
              <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
            ) : (
              <Icon className="w-6 h-6 text-emerald-400" />
            )}
          </div>
          <h1 className="text-lg font-semibold text-white">{title}</h1>
          <p className="text-xs text-gray-400 text-center">{subtitle}</p>
        </div>

        {mode !== 'loading' && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                required
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                required
                minLength={isSetup ? 12 : undefined}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
              {isSetup && (
                <p className="text-[10px] text-gray-500 mt-1">
                  12–256 characters. This single credential protects everything served from this
                  environment — pick something strong.
                </p>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
                <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !username || !password}
              className="w-full flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded transition-colors"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isSetup ? (
                <UserPlus className="w-4 h-4" />
              ) : (
                <KeyRound className="w-4 h-4" />
              )}
              {isSetup ? 'Create account' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
