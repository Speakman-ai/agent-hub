import { useState } from 'react';
import { Loader2, UserPlus, Lock } from 'lucide-react';
import { getApiBase, getConnectionConfig } from '../utils/connection';
import { setup as setupHubAuth, login as loginHubAuth } from '../utils/auth';
import BrandLogo from './BrandLogo';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function SetupWizard({ onComplete }: { onComplete: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hubUsername, setHubUsername] = useState('');
  const [hubPassword, setHubPassword] = useState('');
  const handleHubAccountContinue = async (e: any) => {
    e.preventDefault();
    // Read from the form DOM (FormData), not React state. Password managers
    // (Bitwarden generate / autofill) write the <input> value without always
    // firing React onChange — controlled-state submits then send a stale /
    // empty password, create a half-baked Owner, and kick the user out of
    // the wizard. FormData sees what the user actually sees in the fields.
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const username = String(fd.get('hub-email') || hubUsername).trim();
    const password = String(fd.get('hub-password') || hubPassword);
    // Keep React state in sync so validation UI stays honest after autofill.
    if (username !== hubUsername) setHubUsername(username);
    if (password !== hubPassword) setHubPassword(password);
    if (!isValidEmail(username) || password.length < 12) {
      setError('Email and a password of at least 12 characters are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // When the server still has a legacy global `X-API-Key` configured
      // (the pre-JWT install), `/api/auth/setup` requires it as
      // break-glass proof so the migration to Owner-tracked auth can
      // run. Plain fresh installs (no key stored) pass `''` and the
      // header is omitted — `client/src/utils/auth.js#setup` only
      // attaches it when truthy.
      const { apiKey = '' } = getConnectionConfig();
      const sanitizedApiKey = apiKey.replace(/\s+/g, '').replace(/^["']+|["']+$/g, '');
      try {
        await setupHubAuth({
          baseUrl: getApiBase(),
          username,
          password,
          apiKey: sanitizedApiKey,
        });
      } catch (setupErr: any) {
        // Interrupted / double-submit after Owner already exists (password
        // manager autofill often fires submit twice). Fall through to login
        // with the same credentials so the wizard can continue.
        const msg = String(setupErr?.message || '');
        if (!/already configured/i.test(msg)) throw setupErr;
        await loginHubAuth({ baseUrl: getApiBase(), username, password });
      }
      setHubPassword('');
      await onComplete();
    } catch (err: any) {
      setError(err.message || 'Failed to create account');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-gray-950 overflow-y-auto">
      <div className="min-h-full w-full max-w-2xl mx-auto p-8">
        <div className="flex justify-center mb-6">
          <BrandLogo size="lg" />
        </div>
        <div className="space-y-5 max-w-md mx-auto">
          <div className="text-center mb-2">
            <div className="flex justify-center mb-3">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                <UserPlus className="w-7 h-7 text-emerald-400" />
              </div>
            </div>
            <h1 className="text-xl font-bold text-white mb-1">Create your Hub account</h1>
            <p className="text-gray-400 text-sm">
              This email and password protect Agent Hub on this machine: API access, settings, and
              org data. Pick something strong; you can add more users later in Settings.
            </p>
          </div>
          <form
            onSubmit={handleHubAccountContinue}
            className="space-y-3"
            autoComplete="off"
            data-bwignore="true"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
          >
            <div>
              <label htmlFor="hub-account-username" className="block text-xs text-gray-400 mb-1">
                Email
              </label>
              <input
                id="hub-account-username"
                name="hub-email"
                data-testid="hub-account-username"
                type="email"
                value={hubUsername}
                onChange={(e: any) => setHubUsername(e.target.value)}
                autoFocus
                autoComplete="off"
                data-bwignore="true"
                data-lpignore="true"
                data-1p-ignore="true"
                required
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label htmlFor="hub-account-password" className="block text-xs text-gray-400 mb-1">
                Password
              </label>
              <input
                id="hub-account-password"
                name="hub-password"
                data-testid="hub-account-password"
                type="password"
                value={hubPassword}
                onChange={(e: any) => setHubPassword(e.target.value)}
                autoComplete="new-password"
                data-bwignore="true"
                data-lpignore="true"
                data-1p-ignore="true"
                required
                minLength={12}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
              <p className="text-[10px] text-gray-500 mt-1">
                12 to 256 characters. This credential protects everything served from this
                environment. Prefer typing or pasting. Password-manager autofill can interrupt
                first-run setup.
              </p>
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 p-2 bg-red-900/30 border border-red-700 rounded-lg text-xs text-red-300"
              >
                <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={saving || !isValidEmail(hubUsername) || hubPassword.length < 12}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? 'Creating account…' : 'Continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
