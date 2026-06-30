import { useState, useEffect } from 'react';
import { Lock, Loader2, UserPlus, KeyRound, ShieldCheck } from 'lucide-react';
import { login, setup, getAuthStatus, completeMfaLogin, forgotPassword } from '../utils/auth';
import { getApiBase } from '../utils/connection';

/**
 * Full-screen login gate.
 *
 * - Calls /api/auth/status on mount to decide whether to show the "sign in"
 *   form or the first-run "create owner account" form.
 * - On success, calls `onAuthenticated()` so the parent can re-render into
 *   the normal app.
 */
function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function LoginScreen({ onAuthenticated }: any) {
  const [mode, setMode] = useState('loading'); // loading | login | setup | forgot | forgot-sent
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaMode, setMfaMode] = useState('totp');
  const [pendingMfa, setPendingMfa] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getAuthStatus(getApiBase());
        if (cancelled) return;
        setMode(status.authConfigured ? 'login' : 'setup');
        if (status.email) setUsername(status.email);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to reach server');
        setMode('login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: any) {
    e.preventDefault();
    setError(null);
    if (pendingMfa) {
      setSubmitting(true);
      try {
        await completeMfaLogin({
          baseUrl: getApiBase(),
          challengeId: pendingMfa.challengeId,
          code: mfaCode.trim().replace(/\s+/g, ''),
        });
        setMfaCode('');
        setPendingMfa(null);
        onAuthenticated?.();
      } catch (err: any) {
        setError(err.message || 'MFA verification failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (mode === 'forgot') {
      setSubmitting(true);
      try {
        await forgotPassword({ baseUrl: getApiBase(), email: username.trim() });
        setMode('forgot-sent');
      } catch (err: any) {
        setError(err.message || 'Failed to send reset email');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (mode === 'setup' && !isValidEmail(username)) {
      setError('Enter a valid email address.');
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'setup') {
        await setup({ baseUrl: getApiBase(), username, password });
      } else {
        const result = await login({ baseUrl: getApiBase(), username, password });
        if (result?.mfaRequired) {
          setPendingMfa(result);
          setPassword('');
          return;
        }
      }
      onAuthenticated?.();
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  }

  const isSetup = mode === 'setup';
  const isForgot = mode === 'forgot';
  const isForgotSent = mode === 'forgot-sent';
  const Icon = isSetup ? UserPlus : KeyRound;
  const title = pendingMfa
    ? 'Verify MFA'
    : isSetup
      ? 'Create your account'
      : 'Sign in to Agent Hub';
  const subtitle = pendingMfa
    ? 'Enter an authenticator code or use a recovery code.'
    : isSetup
      ? 'No user has been configured yet. Pick an email and password for this environment.'
      : 'Enter your email and password to continue. Existing sign-in names still work during migration.';

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-6">
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            {mode === 'loading' ? (
              <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
            ) : pendingMfa ? (
              <ShieldCheck className="w-6 h-6 text-emerald-400" />
            ) : (
              <Icon className="w-6 h-6 text-emerald-400" />
            )}
          </div>
          <h1 className="text-lg font-semibold text-white">{title}</h1>
          <p className="text-xs text-gray-400 text-center">{subtitle}</p>
        </div>

        {mode !== 'loading' && !isForgotSent && (
          <form onSubmit={handleSubmit} className="space-y-3">
            {pendingMfa ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMfaMode('totp')}
                    className={`text-xs rounded border px-3 py-2 ${
                      mfaMode === 'totp'
                        ? 'border-emerald-500 text-white bg-emerald-500/10'
                        : 'border-gray-700 text-gray-400'
                    }`}
                  >
                    Authenticator
                  </button>
                  <button
                    type="button"
                    onClick={() => setMfaMode('recovery')}
                    className={`text-xs rounded border px-3 py-2 ${
                      mfaMode === 'recovery'
                        ? 'border-emerald-500 text-white bg-emerald-500/10'
                        : 'border-gray-700 text-gray-400'
                    }`}
                  >
                    Recovery code
                  </button>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1" htmlFor="login-mfa-code">
                    {mfaMode === 'recovery' ? 'Recovery code' : 'Authenticator code'}
                  </label>
                  <input
                    id="login-mfa-code"
                    name={mfaMode === 'recovery' ? 'recovery-code' : 'totpCode'}
                    type="text"
                    value={mfaCode}
                    onChange={(e: any) => setMfaCode(e.target.value)}
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={mfaMode === 'recovery' ? 'text' : 'numeric'}
                    required
                    className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPendingMfa(null);
                    setMfaCode('');
                    setError(null);
                  }}
                  className="text-xs text-gray-400 hover:text-gray-200"
                >
                  Back to password
                </button>
              </>
            ) : (
              <>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Email</label>
                  <input
                    type={isSetup ? 'email' : 'text'}
                    value={username}
                    onChange={(e: any) => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="email"
                    required
                    className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e: any) => setPassword(e.target.value)}
                    autoComplete={isSetup ? 'new-password' : 'current-password'}
                    required
                    minLength={isSetup ? 12 : undefined}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                  {isSetup && (
                    <p className="text-[10px] text-gray-500 mt-1">
                      12-256 characters. This single credential protects everything served from this
                      environment. Pick something strong.
                    </p>
                  )}
                </div>
              </>
            )}

            {error && (
              <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
                <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || (pendingMfa ? !mfaCode : !username || !password)}
              className="w-full flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded transition-colors"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isSetup ? (
                <UserPlus className="w-4 h-4" />
              ) : (
                <KeyRound className="w-4 h-4" />
              )}
              {pendingMfa ? 'Verify and sign in' : isSetup ? 'Create account' : 'Sign in'}
            </button>
            {!isSetup && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode(isForgot ? 'login' : 'forgot');
                }}
                className="w-full text-xs text-gray-400 hover:text-gray-200"
              >
                {isForgot ? 'Back to sign in' : 'Forgot password?'}
              </button>
            )}
          </form>
        )}
        {isForgotSent && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setMode('login')}
              className="w-full flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium rounded transition-colors"
            >
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
