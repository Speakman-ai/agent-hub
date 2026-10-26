import { useState } from 'react';
import { Loader2, UserRound } from 'lucide-react';
import { getApiBase } from '../utils/connection';
import { localSetup } from '../utils/auth';
import BrandLogo from './BrandLogo';

const USERNAME_RE = /^[a-zA-Z0-9_.\-@]{1,64}$/;

/**
 * First-run screen for local mode (`AGENT_HUB_MODE=local`). The server
 * skips auth entirely there, so the Owner only needs a name: no email,
 * no password, no sign-in.
 */
export default function LocalUsernameSetup({ onComplete }: { onComplete: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = username.trim();
  const valid = USERNAME_RE.test(trimmed);

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if (!valid) {
      setError('Use 1-64 letters, numbers, or . _ - @');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      try {
        await localSetup({ baseUrl: getApiBase(), username: trimmed });
      } catch (err: any) {
        // A double-submit or a second tab already created the Owner.
        if (!/already configured/i.test(String(err?.message || ''))) throw err;
      }
      await onComplete();
    } catch (err: any) {
      setError(err?.message || 'Failed to save username');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-gray-950 overflow-y-auto">
      <div className="min-h-full w-full max-w-md mx-auto p-8 flex flex-col justify-center">
        <div className="flex justify-center mb-6">
          <BrandLogo size="lg" />
        </div>
        <div className="text-center mb-4">
          <div className="flex justify-center mb-3">
            <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
              <UserRound className="w-7 h-7 text-emerald-400" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-white mb-1">What should we call you?</h1>
          <p className="text-gray-400 text-sm">
            Agent Hub is running locally, so there is no sign-in. Pick a username.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <label htmlFor="local-username" className="block text-xs text-gray-400 mb-1">
            Username
          </label>
          <input
            id="local-username"
            name="local-username"
            data-testid="local-username"
            value={username}
            onChange={(e: any) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            maxLength={64}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
          {error && (
            <div
              role="alert"
              className="p-2 bg-red-900/30 border border-red-700 rounded-lg text-xs text-red-300"
            >
              {error}
            </div>
          )}
          <button
            type="submit"
            data-testid="local-username-continue"
            disabled={saving || !valid}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
