import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { resetPassword } from '../utils/auth';
import { getApiBase } from '../utils/connection';
import BrandLogo from './BrandLogo';

export default function ResetPasswordPage({ token, onComplete }: any) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<any>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: any) {
    event.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await resetPassword({ baseUrl: getApiBase(), token, newPassword: password });
      setDone(true);
      setPassword('');
    } catch (err: any) {
      setError(err.message || 'Password reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-6">
        <div className="flex flex-col items-center gap-2 mb-6">
          <BrandLogo size="lg" />
          <h1 className="text-lg font-semibold text-white">Reset your password</h1>
          <p className="text-xs text-gray-400 text-center">
            {done ? 'Your password has been changed.' : 'Choose a new password for your account.'}
          </p>
        </div>

        {done ? (
          <button
            type="button"
            onClick={onComplete}
            className="w-full flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium rounded transition-colors"
          >
            Sign in
          </button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">New password</label>
              <input
                type="password"
                value={password}
                onChange={(event: any) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
                minLength={12}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            {error && (
              <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
                <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={submitting || !password}
              className="w-full flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded transition-colors"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Reset password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
